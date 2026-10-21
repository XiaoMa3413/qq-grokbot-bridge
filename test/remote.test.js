'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createReplyServer } = require('../reply_server');
const { loadConfig, loadReplyToken } = require('../lib');
const { createProbeServer } = require('../scripts/tunnel-probe');
const TOKEN = 'test-only-token-0123456789abcdef0123456789';

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
function post(url, body, token = TOKEN) {
  return fetch(url, { method: 'POST', headers: { 'X-Reply-Token': token }, body: JSON.stringify(body) });
}
function withEnv(t, values) {
  const before = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) v === undefined ? delete process.env[k] : process.env[k] = v;
  t.after(() => { for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : process.env[k] = v; });
}
function client(env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../scripts/reply.js')], {
      env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('remote reply rejects local file access, active messages and malformed inputs before sending', async t => {
  const calls = [];
  const api = { seq: new Map(), send: async (...args) => { calls.push(args); return { id: 'mock' }; } };
  const base = await listen(createReplyServer(api, TOKEN, null, { remote: true }), t);
  const reply = { type: 'c2c', openid: 'U', msg_id: 'm1', content: 'hello' };
  assert.equal((await post(base + '/reply', reply, 'bad')).status, 401);
  for (const invalid of [null, [], 42, { ...reply, openid: {} }, { ...reply, msg_id: undefined },
    { ...reply, msg_id: '  ' }, { ...reply, image: path.join(os.tmpdir(), 'private.png') },
    { ...reply, images: [] }]) {
    assert.equal((await post(base + '/reply', invalid)).status, 400);
  }
  assert.equal((await post(base + '/reply', { ...reply, content: '界'.repeat(340000) })).status, 413);
  assert.deepEqual(calls, []);

  const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-remote-test-'));
  t.after(() => fs.rmSync(historyDir, { recursive: true, force: true }));
  withEnv(t, { QQ_HISTORY_DIR: historyDir });
  // A multi-byte character split across TCP chunks must arrive intact.
  const bytes = Buffer.from(JSON.stringify({ ...reply, content: '你好' }));
  const split = bytes.indexOf(Buffer.from('你')) + 1;
  const result = await new Promise((resolve, reject) => {
    const req = http.request(base + '/reply', { method: 'POST', headers: { 'X-Reply-Token': TOKEN } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write(bytes.subarray(0, split));
    setImmediate(() => req.end(bytes.subarray(split)));
  });
  assert.equal(result, 200);
  assert.deepEqual(calls, [['c2c', 'U', '你好', 'm1']]);

  const success = await client({ QQ_REPLY_URL: base + '/reply', QQ_REPLY_TOKEN: TOKEN }, JSON.stringify(reply));
  assert.equal(success.code, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).ok, true);
  const failure = await client({ QQ_REPLY_URL: base + '/reply', QQ_REPLY_TOKEN: 'wrong-token-012345678901234567890123' }, JSON.stringify(reply));
  assert.equal(failure.code, 1);
  assert.equal(JSON.parse(failure.stdout).ok, false);
});

test('public endpoint and remote client reject plaintext, URL credentials and redirects', async t => {
  withEnv(t, { QQ_REPLY_PUBLIC_URL: 'https://bridge.example:12345/reply' });
  assert.equal(loadConfig().replyPublicUrl, 'https://bridge.example:12345/reply');
  for (const bad of ['http://bridge.example/reply', 'https://user:password@bridge.example/reply',
    'https://bridge.example/reply?token=x', 'https://bridge.example/reply#x', 'https://bridge.example/other']) {
    process.env.QQ_REPLY_PUBLIC_URL = bad;
    assert.throws(loadConfig);
  }
  const unsafe = await client({ QQ_REPLY_URL: 'http://bridge.example/reply', QQ_REPLY_TOKEN: TOKEN }, '{}');
  assert.equal(unsafe.code, 1);
  assert.match(unsafe.stderr, /HTTPS/);
  let leaked = false;
  const target = await listen(http.createServer((req, res) => { leaked = true; res.end('{}'); }), t);
  const source = await listen(http.createServer((req, res) => { res.writeHead(307, { Location: target + '/reply' }); res.end(); }), t);
  const redirected = await client({ QQ_REPLY_URL: source + '/reply', QQ_REPLY_TOKEN: TOKEN }, '{}');
  assert.equal(redirected.code, 1);
  assert.equal(leaked, false);
});

test('shared token rejects empty and weak configured values', t => {
  withEnv(t, { QQ_REPLY_TOKEN: TOKEN });
  assert.equal(loadReplyToken(), TOKEN);
  for (const weak of ['', ' ', 'short']) {
    process.env.QQ_REPLY_TOKEN = weak;
    assert.throws(loadReplyToken, /32 characters/);
  }
});

test('tunnel probe distinguishes connectivity from QQ health and requires authentication', async t => {
  const base = await listen(createProbeServer(TOKEN), t);
  assert.deepEqual(await (await fetch(base + '/health')).json(), { ok: true, mode: 'probe', qq_connected: false });
  assert.equal((await post(base + '/probe', { nonce: 'n' }, 'bad')).status, 401);
  assert.equal((await post(base + '/reply', { content: 'never sent' })).status, 404);
  for (const body of [null, {}, { nonce: 12 }, { nonce: 'x'.repeat(129) }])
    assert.equal((await post(base + '/probe', body)).status, 400);
  assert.equal((await post(base + '/probe', { nonce: 'x'.repeat(5000) })).status, 413);
  const reply = await (await post(base + '/probe', { nonce: 'unique-测试' })).json();
  assert.equal(reply.mode, 'probe');
  assert.equal(reply.nonce, 'unique-测试');
  assert.ok(Number.isFinite(Date.parse(reply.timestamp)));
});
