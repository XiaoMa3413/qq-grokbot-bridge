'use strict';
const WebSocket = require('ws');
const fs = require('fs'), path = require('path');
const { loadConfig, log, toPayload, loadReplyToken, TokenManager, QQApi, HTTP_TIMEOUT_MS, dispatcher, fetch } = require('./lib');
const { createReplyServer } = require('./reply_server');
const { downloadImages } = require('./media');
const { SeenIds, RecentImages, redact } = require('./events');
const { createHistory } = require('./history');
const { assembleContext, speakerId } = require('./context');
const { memoryPath } = require('./memory');
const { Watchdog } = require('./watchdog');
const { checkLiveness, detectClockJump } = require('./liveness');
const { JobStore, ForwardWorker } = require('./jobs');
const { RemoteAccess } = require('./remote');
const { acquireInstanceLock } = require('./instance_lock');
const { GatewaySession } = require('./gateway_session');
const VERSION = require('./package.json').version;
const APP_ID = process.env.QQ_APP_ID, SECRET = process.env.QQ_APP_SECRET;
if (!APP_ID || !SECRET) { console.error('FATAL: env QQ_APP_ID and QQ_APP_SECRET are required (not set). Exiting.'); process.exit(78); }
async function start() {
const cfg = loadConfig();
const history = createHistory({ dir: process.env.QQ_HISTORY_DIR || path.join(__dirname, 'data', 'history'), config: cfg });
const { readAll, historyLimit, append, mergeRecent } = history;
const queueDir = path.resolve(process.env.QQ_JOBS_DIR || path.join(__dirname, 'data', 'jobs'));
await acquireInstanceLock(queueDir);
const checkpoint = cfg.replyPublicUrl ? new GatewaySession(queueDir, APP_ID) : null;
let wsRef = null, lastAliveAt = Date.now(), lastTick = Date.now();   // lastAliveAt/lastTick are stamped on READY/RESUMED and on heartbeat ACKs
let jobs = null;
let shuttingDown = false;
let ingressError = false, pendingDispatch = null, gatewayReady = false;
const LIVENESS_MAX_AGE_MS = Number(process.env.QQ_LIVENESS_MAX_AGE_MS) || 90000;
const LIVENESS_INTERVAL_MS = 15000;
const READY_TIMEOUT_MS = Number(process.env.QQ_READY_TIMEOUT_MS) || 60000;
let connectionGraceUntil = Date.now() + READY_TIMEOUT_MS;
const WS_STATE_NAMES = { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED' };
const wsStateName = state => {
  const n = state === null || state === undefined ? 'NONE' : WS_STATE_NAMES[state];
  return n || 'NONE';
};
// Health payload for the reply server's /health endpoint, built on the same liveness decision.
function livenessHealth() {
  const state = wsRef === null ? null : wsRef.readyState;
  const r = checkLiveness({ wsState: state, lastAliveAt, now: Date.now(), maxAgeMs: LIVENESS_MAX_AGE_MS });
  return { ok: r.ok && gatewayReady && !ingressError, version: VERSION, ws_state: wsStateName(state), last_ack_age_ms: r.ageMs,
    reason: ingressError ? 'ingress-persistence-failed' : r.reason || (gatewayReady ? '' : 'gateway-not-ready'),
    ...(jobs ? { jobs: jobs.summary() } : {}) };
}
// If no websocket heartbeat ack arrives within the grace period, give up so the supervisor restarts us.
// Also watch for a suspended/fast-forwarded local clock: (now - lastTick) - interval should stay small.
setInterval(() => {
  const now = Date.now();
  if (detectClockJump(lastTick, now, LIVENESS_INTERVAL_MS)) {
    const drift = (now - lastTick) - LIVENESS_INTERVAL_MS;
    log('clock jump/suspend detected, drift ' + drift + 'ms, exit 1');
    process.exit(1);
  }
  lastTick = now;
  if (ingressError) return; // Retry the retained dispatch without losing the current session.
  const r = checkLiveness({ wsState: wsRef === null ? null : wsRef.readyState, lastAliveAt, now, maxAgeMs: LIVENESS_MAX_AGE_MS });
  if (!r.ok && r.reason === 'ws-not-open' && now < connectionGraceUntil) return;
  if (!r.ok) { log('LIVENESS fail', r.reason); process.exit(1); }
}, LIVENESS_INTERVAL_MS);
if (cfg.replyPublicUrl) jobs = new JobStore({ dir: queueDir });
const remoteAccess = jobs ? new RemoteAccess(jobs, cfg.replyPublicUrl) : null;
if (!cfg.forwardWebhookUrl) log('WARN: no forward webhook URL (QQ_FORWARD_WEBHOOK_URL / config.json); messages will only be logged');
const tm = new TokenManager(cfg, APP_ID, SECRET), api = new QQApi(cfg, tm);
const srv = createReplyServer(api, loadReplyToken(), livenessHealth, { remote: !!cfg.replyPublicUrl, store: jobs, access: remoteAccess, history });
srv.listen(cfg.replyPort, cfg.replyHost, () => log(`reply server on http://${cfg.replyHost}:${cfg.replyPort}`));
setInterval(() => tm.get().catch(e => log('token refresh error', e.message)), 30000);

// Dispatch-level dedup (last 1000 message ids) and per-group recent images (last 10 min, 5 per group).
const seen = new SeenIds(1000), recent = new RecentImages(600000, 5);
const worker = jobs ? new ForwardWorker(jobs, { log, prepare: async (p, job) => {
  await prepareInbound(p);
  return remoteAccess.payload(p, job);
}, send: async p => {
  if (!gatewayReady || wsRef?.readyState !== WebSocket.OPEN || !sessionId) throw new Error('QQ is reconnecting');
  const response = await sendWebhook(p);
  const retryAfter = response.headers.get('retry-after');
  const retryAfterMs = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
  await response.body?.cancel();
  return { ok: response.ok, status: response.status, retryAfterMs };
} }) : null;
function runWorker() {
  if (!shuttingDown && !ingressError && gatewayReady && worker && cfg.forwardWebhookUrl && wsRef?.readyState === WebSocket.OPEN && sessionId)
    worker.runOnce().catch(() => log('queue worker error'));
}

// If a fresh connection never completes its handshake (no READY/RESUMED), give up and exit
// so the supervisor restarts us, rather than hanging forever half-connected.
const readyWd = new Watchdog({ onFire: reason => { log('WATCHDOG', reason, 'exit 1'); process.exit(1); } });

// Attach the conversation history and the long-term memory path to a forwarded payload (before the current message is recorded), then record the current one.
function recordInbound(p, content) {
  const id = p.type === 'group' ? p.group_openid : p.openid;
  p.memory_path = memoryPath(p.type, id);
  try {
    const stored = readAll(p.type, id, { strict: true });
    Object.assign(p, assembleContext(p, stored, { maxChars: cfg.contextTextMaxChars, maxEntries: historyLimit(p.type) }));
    if (!stored.some(entry => entry.msg_id === p.msg_id)) append(p.type, id, { role: 'user', nickname: p.nickname, member_role: p.author && p.author.member_role,
      openid: speakerId(p), msg_id: p.msg_id,
      content: content ?? p.content, timestamp: p.timestamp || new Date().toISOString() });
  } catch (e) {
    log('history error', e.message);
    Object.assign(p, assembleContext(p, [], { maxChars: cfg.contextTextMaxChars, maxEntries: historyLimit(p.type), historyAvailable: false }));
  }
}
async function forward(p) {
  if (!cfg.forwardWebhookUrl) return;
  if (cfg.replyPublicUrl) p.reply_url = cfg.replyPublicUrl;
  for (let i = 0; i < 3; i++) {
    try { const r = await sendWebhook(p); await r.body?.cancel();
      if (r.ok) return log('forwarded', p.type, p.msg_id); log('forward HTTP', r.status); }
    catch (e) { log('forward error', e.message); }
    await new Promise(r => setTimeout(r, 1000 * 2 ** i));
  }
}
function sendWebhook(p) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.QQ_FORWARD_WEBHOOK_SECRET) {
    const name = process.env.QQ_FORWARD_WEBHOOK_HEADER || 'Authorization';
    headers[name] = name.toLowerCase() === 'authorization' ? 'Bearer ' + process.env.QQ_FORWARD_WEBHOOK_SECRET : process.env.QQ_FORWARD_WEBHOOK_SECRET;
  }
  return fetch(cfg.forwardWebhookUrl, { method: 'POST', redirect: 'error', headers, body: JSON.stringify(p),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), dispatcher });
}
async function prepareInbound(p) {
  try {
    await downloadImages(p);
    await downloadImages({ msg_id: p.msg_id + '-q', attachments: p.quoted.flatMap(q => q.attachments || []) });
    await downloadImages({ msg_id: p.msg_id + '-rc', attachments: p.recent_context.flatMap(c => c.attachments || []) });
  } catch (e) { log('media error', e.message); }
  const imgs = p.attachments.filter(a => a && a.local_path).map(a => a.local_path);
  const histContent = [p.content, ...imgs.map(x => '[图片] ' + (remoteAccess ? path.basename(x) : x))].filter(Boolean).join('\n');
  if (p.type === 'group' && p.at === false) {
    for (const x of imgs) recent.add(p.group_openid, { local_path: x, nickname: p.nickname, timestamp: p.timestamp });
    append('group', p.group_openid, { role: 'user', nickname: p.nickname, member_role: p.author.member_role,
      openid: speakerId(p), msg_id: p.msg_id, content: histContent, timestamp: p.timestamp || new Date().toISOString() });
    log('recv group-nonat', p.msg_id); return;
  }
  if (p.type === 'group') {
    p.recent_images = recent.get(p.group_openid);
    if (p.recent_context.length) mergeRecent('group', p.group_openid, p.recent_context);
  }
  recordInbound(p, histContent);
}

let sessionId = checkpoint?.sessionId || null, seq = checkpoint?.seq ?? null, hb = null, missed = 0, backoff = 1000;
function commitSequence(nextSession, nextSeq) {
  if (checkpoint) checkpoint.commit(nextSession, nextSeq);
  sessionId = nextSession; seq = nextSeq;
}
function acceptDispatch(m) {
  const nextSession = m.t === 'READY' ? m.d.session_id : sessionId;
  let localPayload = null;
  if (m.t !== 'READY' && m.t !== 'RESUMED') {
    if (process.env.QQ_DEBUG_RAW_EVENTS === '1') {
      try { fs.appendFileSync(path.join(__dirname, 'logs', 'raw-events.jsonl'), JSON.stringify(redact({ t: m.t, d: m.d })) + '\n'); }
      catch (e) { log('raw event dump error', e.message); }
    }
    const p = toPayload(m.t, m.d);
    if (!p) log('unhandled event', m.t);
    else if (jobs && !(p.type === 'group' && p.at === false)) {
      const { job, added } = jobs.enqueue(p);
      log(added ? 'queued' : 'dup', p.type, job.id);
    } else localPayload = p;
  }
  // Persist the task first. Replaying after a failed checkpoint is safe because enqueue deduplicates.
  if (!Number.isSafeInteger(m.s) || m.s < 0 || !nextSession) throw new Error('invalid dispatch sequence or session');
  commitSequence(nextSession, m.t === 'READY' ? m.s : Math.max(seq ?? 0, m.s));
  ingressError = false; pendingDispatch = null;
  if (m.t === 'READY' || m.t === 'RESUMED') {
    gatewayReady = true;
    backoff = 1000; lastAliveAt = Date.now(); readyWd.disarm();
    log(m.t); // Session identifiers stay in the private checkpoint.
  }
  if (localPayload && !seen.check(localPayload.msg_id)) {
    // Non-mention context and legacy local mode retain their best-effort behavior.
    prepareInbound(localPayload).then(() => {
      if (localPayload.type === 'group' && localPayload.at === false) return;
      log('recv', localPayload.type, localPayload.msg_id); return forward(localPayload);
    }).catch(e => log('inbound preparation error', e.code || 'EINBOUND'));
  }
  runWorker();
}
function failIngress(m, ws, error) {
  ingressError = true; pendingDispatch = m; gatewayReady = false;
  log('ingress persistence failed', error.code || 'EINGRESS');
  // Ignore all remaining frames from this socket; no later sequence can overtake the failure.
  ws.terminate();
}
async function connect() {
  if (shuttingDown) return;
  try {
    if (pendingDispatch) {
      try { acceptDispatch(pendingDispatch); }
      catch (e) { log('ingress retry failed', e.code || 'EINGRESS'); schedule(); return; }
    }
    gatewayReady = false;
    connectionGraceUntil = Date.now() + READY_TIMEOUT_MS;
    readyWd.arm(READY_TIMEOUT_MS, 'no READY/RESUMED within timeout');
    const g = await api.req('GET', '/gateway');
    const ws = new WebSocket(g.url, { handshakeTimeout: 15000 });
    wsRef = ws;                                                    // so the liveness check can watch it
    ws.on('open', () => log('ws open'));
    ws.on('message', async raw => {
      if (shuttingDown || ws !== wsRef || ws.readyState !== WebSocket.OPEN) return;
      let m;
      try {
        m = JSON.parse(raw);
        if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('invalid gateway envelope');
      }
      catch { log('invalid gateway JSON; reconnecting without advancing sequence'); ws.terminate(); return; }
      if (m.op === 0) {
        try { acceptDispatch(m); } catch (e) { failIngress(m, ws, e); }
        return;
      }
      try {
      switch (m.op) {
        case 10: {
          clearInterval(hb); missed = 0;
          hb = setInterval(() => {
            if (missed >= 2) { log('heartbeat not acked for 2 intervals, exit'); process.exit(1); }
            missed++; ws.send(JSON.stringify({ op: 1, d: seq }));
          }, m.d.heartbeat_interval);
          const token = 'QQBot ' + await tm.get();
          if (shuttingDown || ws !== wsRef || ws.readyState !== WebSocket.OPEN) return;
          if (sessionId) ws.send(JSON.stringify({ op: 6, d: { token, session_id: sessionId, seq } }));
          else ws.send(JSON.stringify({ op: 2, d: { token, intents: cfg.intents, shard: [0, 1] } }));
          break; }
        case 11: lastAliveAt = Date.now(); missed = 0; break;
        case 7: log('server requested reconnect'); ws.close(4000); break;
        case 9: log('invalid session, re-identify'); commitSequence(null, null); ws.close(4000); break;
      }
      } catch (e) { log('gateway control error', e.code || 'EGATEWAY'); ws.terminate(); }
    });
    ws.on('close', c => {
      if (ws !== wsRef) return;
      gatewayReady = false; clearInterval(hb); readyWd.disarm(); log('ws closed', c);
      if ([4914, 4915].includes(c)) { log('bot offline/banned, exit'); process.exit(1); }
      if ([4004, 4006, 4007, 4009].includes(c) || c >= 4900) {
        try { commitSequence(null, null); }
        catch { log('cannot clear invalid gateway checkpoint'); process.exit(1); }
      }
      schedule();
    });
    ws.on('error', e => log('ws error', e.message));
  } catch (e) { log('connect error', e.message, JSON.stringify(e.body || '')); schedule(); }
}
function schedule() { if (shuttingDown) return; log(`reconnect in ${backoff}ms`); connectionGraceUntil = Date.now() + backoff + READY_TIMEOUT_MS; setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60000); }
process.on('unhandledRejection', e => log('unhandledRejection', e && e.message));
if (worker && cfg.forwardWebhookUrl) {
  setInterval(runWorker, 1000);
}
connect();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true; log('shutdown', signal); readyWd.disarm(); clearInterval(hb);
  wsRef?.terminate();
  setTimeout(() => process.exit(1), 30000).unref();
  srv.close(async () => { await worker?.running; process.exit(0); });
});
}
start().catch(e => { console.error('FATAL:', e.message); process.exit(['EINSTANCELOCKED', 'EJOBSTATE'].includes(e.code) ? 78 : 1); });
