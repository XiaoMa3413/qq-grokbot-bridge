'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const TOKEN = 'integration-only-token-0123456789abcdef0123456789';
async function waitFor(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('timed out: ' + message);
}
async function freePort() {
  const app = http.createServer(); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const port = app.address().port; await new Promise(resolve => app.close(resolve)); return port;
}
async function fixture(t, { events = [], holdSend = false, holdResume = false, rejectResume = false, webhook } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ingress-test-'));
  const children = [], sockets = new Set(), resumes = [], heartbeats = [], deliveries = [], sends = [];
  let identifies = 0, connections = 0, release, releaseResume;
  const gate = new Promise(resolve => release = resolve);
  const resumeGate = new Promise(resolve => releaseResume = resolve);
  const app = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/token') return res.end('{"access_token":"MOCK","expires_in":7200}');
    if (req.url === '/gateway') return res.end(JSON.stringify({ url: `ws://127.0.0.1:${app.address().port}/ws` }));
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      if (req.url === '/webhook') {
        deliveries.push(JSON.parse(body));
        if (webhook) return webhook(req, res, deliveries.at(-1));
        return res.end('{}');
      }
      if (/^\/v2\/users\/[^/]+\/messages$/.test(req.url)) {
        sends.push(JSON.parse(body)); if (holdSend) await gate;
        return res.end('{"id":"SENT"}');
      }
      res.writeHead(404); res.end('{}');
    });
  });
  const wss = new WebSocketServer({ server: app, path: '/ws' });
  wss.on('connection', socket => {
    connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }));
    socket.on('message', async raw => {
      const m = JSON.parse(raw);
      if (m.op === 1) { heartbeats.push(m.d); socket.send('{"op":11}'); }
      if (m.op === 2) {
        identifies++; socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'TEST-SESSION' } }));
        for (const event of events) socket.send(JSON.stringify(event));
      }
      if (m.op === 6) {
        resumes.push(m.d);
        if (rejectResume && resumes.length === 1) { socket.send('{"op":9,"d":false}'); return; }
        if (holdResume) await resumeGate;
        if (socket.readyState !== 1) return;
        for (const event of events) if (event.s > m.d.seq) socket.send(JSON.stringify(event));
        socket.send(JSON.stringify({ op: 0, t: 'RESUMED', s: Math.max(1, m.d.seq, ...events.map(e => e.s)), d: {} }));
      }
    });
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  async function stop(child, signal = 'SIGTERM') {
    if (child.exitCode !== null || child.signalCode) return;
    const closed = new Promise(resolve => child.once('exit', resolve)); child.kill(signal); await closed;
  }
  t.after(async () => {
    release(); releaseResume(); await Promise.all(children.map(child => stop(child)));
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => app.close(resolve));
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('qq-ingress-test-'))
      throw new Error('unexpected test cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('QQ_')));
  async function start({ preload, overrides = {} } = {}) {
    const port = await freePort();
    const args = [...(preload ? ['--require', preload] : []), path.join(__dirname, '../../bridge.js')];
    const child = spawn(process.execPath, args, { env: { ...environment,
      QQ_APP_ID: 'MOCK', QQ_APP_SECRET: 'MOCK', QQ_API_BASE: base, QQ_TOKEN_URL: base + '/token',
      QQ_FORWARD_WEBHOOK_URL: base + '/webhook', QQ_REPLY_PORT: String(port), QQ_REPLY_PUBLIC_URL: 'https://bridge.example/reply',
      QQ_REPLY_TOKEN: TOKEN, QQ_JOBS_DIR: path.join(root, 'jobs'), QQ_HISTORY_DIR: path.join(root, 'history'),
      QQ_MEMORY_DIR: path.join(root, 'memory'), QQ_MEDIA_DIR: path.join(root, 'media'), QQ_KNOWLEDGE_DIR: path.join(root, 'knowledge'), ...overrides,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.output = ''; child.url = `http://127.0.0.1:${port}`;
    child.stdout.on('data', c => child.output += c); child.stderr.on('data', c => child.output += c);
    child.closed = new Promise(resolve => child.once('exit', code => resolve(code)));
    children.push(child); return child;
  }
  async function health(child) {
    try { const r = await fetch(child.url + '/health', { signal: AbortSignal.timeout(500) }); return { status: r.status, ...await r.json() }; }
    catch { return {}; }
  }
  return { root, start, stop, health, resumes, heartbeats, deliveries, sends, release, releaseResume,
    dispatch(message) { for (const socket of sockets) if (socket.readyState === 1) socket.send(JSON.stringify(message)); },
    get identifies() { return identifies; }, get connections() { return connections; } };
}
function event(id, sequence, user = 'U') {
  return { op: 0, t: 'C2C_MESSAGE_CREATE', s: sequence,
    d: { id, content: 'test', timestamp: new Date().toISOString(), author: { user_openid: user } } };
}
module.exports = { fixture, waitFor, event, TOKEN };
