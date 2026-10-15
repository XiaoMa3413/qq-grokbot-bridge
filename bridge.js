'use strict';
const WebSocket = require('ws');
const { loadConfig, log, toPayload, loadReplyToken, TokenManager, QQApi } = require('./lib');
const { createReplyServer } = require('./reply_server');
const APP_ID = process.env.QQ_APP_ID, SECRET = process.env.QQ_APP_SECRET;
if (!APP_ID || !SECRET) { console.error('FATAL: env QQ_APP_ID and QQ_APP_SECRET are required (not set). Exiting.'); process.exit(78); }
const cfg = loadConfig();
if (!cfg.forwardWebhookUrl) log('WARN: no forward webhook URL (QQ_FORWARD_WEBHOOK_URL / config.json); messages will only be logged');
const tm = new TokenManager(cfg, APP_ID, SECRET), api = new QQApi(cfg, tm);
const srv = createReplyServer(api, loadReplyToken());
srv.listen(cfg.replyPort, cfg.replyHost, () => log(`reply server on http://${cfg.replyHost}:${cfg.replyPort}`));
setInterval(() => tm.get().catch(e => log('token refresh error', e.message)), 30000);

async function forward(p) {
  if (!cfg.forwardWebhookUrl) return;
  const h = { 'Content-Type': 'application/json' };
  if (process.env.QQ_FORWARD_WEBHOOK_SECRET) { const hn = process.env.QQ_FORWARD_WEBHOOK_HEADER || 'Authorization'; h[hn] = hn.toLowerCase() === 'authorization' ? 'Bearer ' + process.env.QQ_FORWARD_WEBHOOK_SECRET : process.env.QQ_FORWARD_WEBHOOK_SECRET; }
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(cfg.forwardWebhookUrl, { method: 'POST', headers: h, body: JSON.stringify(p) });
      if (r.ok) return log('forwarded', p.type, p.msg_id); log('forward HTTP', r.status); }
    catch (e) { log('forward error', e.message); }
    await new Promise(r => setTimeout(r, 1000 * 2 ** i));
  }
}

let sessionId = null, seq = null, hb = null, backoff = 1000;
async function connect() {
  try {
    const g = await api.req('GET', '/gateway');
    const ws = new WebSocket(g.url); let acked = true;
    ws.on('open', () => log('ws open'));
    ws.on('message', async raw => {
      const m = JSON.parse(raw); if (m.s) seq = m.s;
      switch (m.op) {
        case 10: {
          clearInterval(hb);
          hb = setInterval(() => { if (!acked) { log('heartbeat not acked, reconnect'); return ws.terminate(); } acked = false; ws.send(JSON.stringify({ op: 1, d: seq })); }, m.d.heartbeat_interval);
          const token = 'QQBot ' + await tm.get();
          if (sessionId) ws.send(JSON.stringify({ op: 6, d: { token, session_id: sessionId, seq } }));
          else ws.send(JSON.stringify({ op: 2, d: { token, intents: cfg.intents, shard: [0, 1] } }));
          break; }
        case 11: acked = true; break;
        case 7: log('server requested reconnect'); ws.close(4000); break;
        case 9: log('invalid session, re-identify'); sessionId = null; seq = null; ws.close(4000); break;
        case 0:
          if (m.t === 'READY') { sessionId = m.d.session_id; backoff = 1000; log('READY as', m.d.user && m.d.user.username); }
          else if (m.t === 'RESUMED') { backoff = 1000; log('RESUMED'); }
          else { const p = toPayload(m.t, m.d); if (p) { log('recv', p.type, p.msg_id); forward(p); } }
      }
    });
    ws.on('close', (c, r) => { clearInterval(hb); log('ws closed', c, String(r)); if ([4914, 4915].includes(c)) { log('bot offline/banned, exit'); process.exit(1); } if ([4004, 4006, 4007, 4009].includes(c) || c >= 4900) { sessionId = null; seq = null; } schedule(); });
    ws.on('error', e => log('ws error', e.message));
  } catch (e) { log('connect error', e.message, JSON.stringify(e.body || '')); schedule(); }
}
function schedule() { log(`reconnect in ${backoff}ms`); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60000); }
process.on('unhandledRejection', e => log('unhandledRejection', e && e.message));
connect();
