'use strict';
// Network-only probe: no QQ credentials, no webhook calls, no file access endpoints.
const http = require('http');
const { loadReplyToken } = require('../lib');

function createProbeServer(token) {
  return http.createServer({ requestTimeout: 10000, headersTimeout: 5000 }, (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health')
      return send(200, { ok: true, mode: 'probe', qq_connected: false });
    if (req.method !== 'POST' || req.url !== '/probe') return send(404, { ok: false, error: 'not found' });
    if (req.headers['x-reply-token'] !== token) return send(401, { ok: false, error: 'bad token' });
    let chunks = [], size = 0, tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > 4096) { tooLarge = true; chunks = []; return send(413, { ok: false, error: 'body too large' }); }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return send(400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body.nonce !== 'string' || body.nonce.length > 128)
        return send(400, { ok: false, error: 'need a nonce string of at most 128 characters' });
      send(200, { ok: true, mode: 'probe', nonce: body.nonce, timestamp: new Date().toISOString() });
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.QQ_REPLY_PORT || 8787);
  const server = createProbeServer(loadReplyToken());
  server.on('error', e => { console.error(e.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Tunnel probe on http://127.0.0.1:${port}; no QQ connection`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
module.exports = { createProbeServer };
