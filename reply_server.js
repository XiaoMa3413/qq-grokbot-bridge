'use strict';
const http = require('http');
const { log } = require('./lib');
function createReplyServer(api, token) {
  return http.createServer((req, res) => {
    const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/reply') return send(404, { ok: false, error: 'not found' });
    if (req.headers['x-reply-token'] !== token) return send(401, { ok: false, error: 'bad token' });
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let j; try { j = JSON.parse(b); } catch { return send(400, { ok: false, error: 'invalid json' }); }
      const target = j.type === 'c2c' ? j.openid : j.type === 'group' ? j.group_openid : null;
      if (!target || typeof j.content !== 'string' || !j.content)
        return send(400, { ok: false, error: 'need type(c2c|group), openid|group_openid, content' });
      try { const r = await api.send(j.type, target, j.content, j.msg_id); log('reply sent', j.type, j.msg_id || '(active)'); send(200, { ok: true, result: r }); }
      catch (e) { log('reply failed', e.message, JSON.stringify(e.body || '')); send(502, { ok: false, error: e.message, detail: e.body }); }
    });
  });
}
module.exports = { createReplyServer };
