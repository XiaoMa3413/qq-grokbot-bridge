'use strict';
const WebSocket = require('ws');
const fs = require('fs'), path = require('path');
const { loadConfig, log, toPayload, loadReplyToken, TokenManager, QQApi, HTTP_TIMEOUT_MS, dispatcher, fetch } = require('./lib');
const { createReplyServer } = require('./reply_server');
const { downloadImages } = require('./media');
const { SeenIds, RecentImages, redact } = require('./events');
const { getHistory, append, mergeRecent } = require('./history');
const { memoryPath } = require('./memory');
const { Watchdog } = require('./watchdog');
const { checkLiveness, detectClockJump } = require('./liveness');
const { JobStore, ForwardWorker } = require('./jobs');
const { RemoteAccess } = require('./remote');
const VERSION = require('./package.json').version;
const APP_ID = process.env.QQ_APP_ID, SECRET = process.env.QQ_APP_SECRET;
if (!APP_ID || !SECRET) { console.error('FATAL: env QQ_APP_ID and QQ_APP_SECRET are required (not set). Exiting.'); process.exit(78); }
let wsRef = null, lastAliveAt = Date.now(), lastTick = Date.now();   // lastAliveAt/lastTick are stamped on READY/RESUMED and on heartbeat ACKs
let jobs = null;
let shuttingDown = false;
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
  return { ok: r.ok, version: VERSION, ws_state: wsStateName(state), last_ack_age_ms: r.ageMs, reason: r.reason,
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
  const r = checkLiveness({ wsState: wsRef === null ? null : wsRef.readyState, lastAliveAt, now, maxAgeMs: LIVENESS_MAX_AGE_MS });
  if (!r.ok && r.reason === 'ws-not-open' && now < connectionGraceUntil) return;
  if (!r.ok) { log('LIVENESS fail', r.reason); process.exit(1); }
}, LIVENESS_INTERVAL_MS);
const cfg = loadConfig();
if (cfg.replyPublicUrl) jobs = new JobStore();
const remoteAccess = jobs ? new RemoteAccess(jobs, cfg.replyPublicUrl) : null;
if (!cfg.forwardWebhookUrl) log('WARN: no forward webhook URL (QQ_FORWARD_WEBHOOK_URL / config.json); messages will only be logged');
const tm = new TokenManager(cfg, APP_ID, SECRET), api = new QQApi(cfg, tm);
const srv = createReplyServer(api, loadReplyToken(), livenessHealth, { remote: !!cfg.replyPublicUrl, store: jobs, access: remoteAccess });
srv.listen(cfg.replyPort, cfg.replyHost, () => log(`reply server on http://${cfg.replyHost}:${cfg.replyPort}`));
setInterval(() => tm.get().catch(e => log('token refresh error', e.message)), 30000);

// Dispatch-level dedup (last 1000 message ids) and per-group recent images (last 10 min, 5 per group).
const seen = new SeenIds(1000), recent = new RecentImages(600000, 5);
const worker = jobs ? new ForwardWorker(jobs, { log, prepare: async (p, job) => {
  await prepareInbound(p);
  return remoteAccess.payload(p, job);
}, send: async p => {
  if (wsRef?.readyState !== WebSocket.OPEN || !sessionId) throw new Error('QQ is reconnecting');
  const response = await sendWebhook(p);
  const retryAfter = response.headers.get('retry-after');
  const retryAfterMs = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
  await response.body?.cancel();
  return { ok: response.ok, status: response.status, retryAfterMs };
} }) : null;
function runWorker() {
  if (!shuttingDown && worker && cfg.forwardWebhookUrl && wsRef?.readyState === WebSocket.OPEN && sessionId)
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
    const stored = getHistory(p.type, id);
    p.history = stored.filter(entry => entry.msg_id !== p.msg_id);
    if (!stored.some(entry => entry.msg_id === p.msg_id)) append(p.type, id, { role: 'user', nickname: p.nickname, member_role: p.author && p.author.member_role,
      openid: (p.author && (p.author.user_openid || p.author.member_openid)) || null, msg_id: p.msg_id,
      content: content ?? p.content, timestamp: p.timestamp || new Date().toISOString() });
  } catch (e) { log('history error', e.message); if (!Array.isArray(p.history)) p.history = []; }
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
      openid: p.author.member_openid || null, content: histContent, timestamp: p.timestamp || new Date().toISOString() });
    log('recv group-nonat', p.msg_id); return;
  }
  if (p.type === 'group') {
    p.recent_images = recent.get(p.group_openid);
    if (p.recent_context.length) mergeRecent('group', p.group_openid, p.recent_context);
  }
  recordInbound(p, histContent);
}

let sessionId = null, seq = null, hb = null, missed = 0, backoff = 1000;
async function connect() {
  if (shuttingDown) return;
  try {
    connectionGraceUntil = Date.now() + READY_TIMEOUT_MS;
    readyWd.arm(READY_TIMEOUT_MS, 'no READY/RESUMED within timeout');
    const g = await api.req('GET', '/gateway');
    const ws = new WebSocket(g.url, { handshakeTimeout: 15000 });
    wsRef = ws;                                                    // so the liveness check can watch it
    ws.on('open', () => log('ws open'));
    ws.on('message', async raw => {
      const m = JSON.parse(raw); if (m.s) seq = m.s;
      switch (m.op) {
        case 10: {
          clearInterval(hb); missed = 0;
          hb = setInterval(() => {
            if (missed >= 2) { log('heartbeat not acked for 2 intervals, exit'); process.exit(1); }
            missed++; ws.send(JSON.stringify({ op: 1, d: seq }));
          }, m.d.heartbeat_interval);
          const token = 'QQBot ' + await tm.get();
          if (sessionId) ws.send(JSON.stringify({ op: 6, d: { token, session_id: sessionId, seq } }));
          else ws.send(JSON.stringify({ op: 2, d: { token, intents: cfg.intents, shard: [0, 1] } }));
          break; }
        case 11: lastAliveAt = Date.now(); missed = 0; break;
        case 7: log('server requested reconnect'); ws.close(4000); break;
        case 9: log('invalid session, re-identify'); sessionId = null; seq = null; ws.close(4000); break;
        case 0:
          if (m.t === 'READY') { sessionId = m.d.session_id; backoff = 1000; lastAliveAt = Date.now(); log('READY as', m.d.user && m.d.user.username); readyWd.disarm(); }
          else if (m.t === 'RESUMED') { backoff = 1000; lastAliveAt = Date.now(); log('RESUMED'); readyWd.disarm(); }
          else {
            if (process.env.QQ_DEBUG_RAW_EVENTS === '1') {
              try { fs.appendFileSync(path.join(__dirname, 'logs', 'raw-events.jsonl'), JSON.stringify(redact({ t: m.t, d: m.d })) + '\n'); }
              catch (e) { log('raw event dump error', e.message); }
            }
            const p = toPayload(m.t, m.d); if (!p) { log('unhandled event', m.t); break; }
            if (jobs && !(p.type === 'group' && p.at === false)) {
              const { job, added } = jobs.enqueue(p);
              log(added ? 'queued' : 'dup', p.type, job.id);
              runWorker();
              break;
            }
            // p.recent_context is set by toPayload (QQ's auto-attached group messages, message_type 103)
            if (seen.check(p.msg_id)) { log('dup', m.t, p.msg_id); break; }
            await prepareInbound(p);
            if (p.type === 'group' && p.at === false) break;
            log('recv', p.type, p.msg_id);
            forward(p);
          }
      }
    });
    ws.on('close', (c, r) => { clearInterval(hb); readyWd.disarm(); log('ws closed', c, String(r)); if ([4914, 4915].includes(c)) { log('bot offline/banned, exit'); process.exit(1); } if ([4004, 4006, 4007, 4009].includes(c) || c >= 4900) { sessionId = null; seq = null; } schedule(); });
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
