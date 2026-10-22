'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');

test('real bridge process recovers a queued webhook after restart and accepts the legacy text callback', { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-process-'));
  const children = [], sockets = new Set(), sends = [], deliveries = [];
  let phase = 1, replyPort, accepted;
  const onAccepted = new Promise(resolve => accepted = resolve);
  const event = { type: 'c2c', openid: 'U', msg_id: 'restart-test', timestamp: new Date().toISOString(), content: 'hello' };
  const api = http.createServer((req, res) => {
    if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'MOCK', expires_in: 7200 }));
    if (req.url === '/gateway') return res.end(JSON.stringify({ url: `ws://127.0.0.1:${api.address().port}/ws` }));
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', async () => {
      if (req.url === '/webhook') {
        const payload = JSON.parse(raw); deliveries.push(payload);
        if (phase === 1) { res.writeHead(429); return res.end('{}'); }
        res.end('{}');
        try {
          const response = await fetch(`http://127.0.0.1:${replyPort}/reply`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Reply-Token': 'integration-token-0123456789abcdef0123456789' },
            body: JSON.stringify({ type: payload.type, openid: payload.openid, msg_id: payload.msg_id, content: 'recovered' }) });
          accepted({ status: response.status, body: await response.json() });
        } catch (error) { accepted({ error: error.message }); }
      } else if (req.url === '/v2/users/U/messages') {
        sends.push(JSON.parse(raw)); res.end('{"id":"SENT"}');
      } else { res.writeHead(404); res.end('{}'); }
    });
  });
  const ws = new WebSocketServer({ server: api, path: '/ws' });
  ws.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.op === 1) socket.send(JSON.stringify({ op: 11 }));
      if (message.op === 6) socket.send(JSON.stringify({ op: 0, t: 'RESUMED', s: message.d.seq, d: {} }));
      if (message.op === 2) {
        socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'S', user: { username: 'test' } } }));
        socket.send(JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2,
          d: { id: event.msg_id, content: event.content, timestamp: event.timestamp, author: { user_openid: event.openid } } }));
      }
    });
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && !child.signalCode) child.kill();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode ? undefined : new Promise(resolve => child.once('exit', resolve))));
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => api.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Reserve an unused loopback port before starting the child.
  const portServer = http.createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  replyPort = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const base = `http://127.0.0.1:${api.address().port}`;
  let output = '';
  function start() {
    const child = spawn(process.execPath, [path.join(__dirname, '../bridge.js')], { env: {
      ...process.env, QQ_APP_ID: 'MOCK', QQ_APP_SECRET: 'MOCK', QQ_API_BASE: base, QQ_TOKEN_URL: base + '/token',
      QQ_FORWARD_WEBHOOK_URL: base + '/webhook', QQ_REPLY_PORT: String(replyPort), QQ_REPLY_PUBLIC_URL: 'https://bridge.example/reply',
      QQ_REPLY_TOKEN: 'integration-token-0123456789abcdef0123456789', QQ_JOBS_DIR: path.join(root, 'jobs'),
      QQ_HISTORY_DIR: path.join(root, 'history'), QQ_MEMORY_DIR: path.join(root, 'memory'), QQ_MEDIA_DIR: path.join(root, 'media'),
      QQ_KNOWLEDGE_DIR: path.join(root, 'knowledge'),
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
    return child;
  }
  const first = start();
  const deadline = Date.now() + 7000;
  while (!output.includes('forward retry') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(output, /forward retry/);
  const firstClosed = new Promise(resolve => first.once('exit', resolve)); first.kill(); await firstClosed;
  phase = 2; start();
  const result = await onAccepted;
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.ok, true);
  assert.equal(deliveries.length, 2); assert.equal(deliveries[0].job_id, deliveries[1].job_id);
  assert.equal(deliveries[1].memory.content, ''); assert.ok(deliveries[1].memory_url);
  assert.equal(sends.length, 1); assert.equal(sends[0].content, 'recovered');
  const health = await (await fetch(`http://127.0.0.1:${replyPort}/health`)).json();
  assert.equal(health.jobs.completed, 1); assert.equal(health.jobs.pending, 0); assert.equal(health.version, require('../package.json').version);
});
