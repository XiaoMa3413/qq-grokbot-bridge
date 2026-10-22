'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { JobStore } = require('../jobs');
const { RemoteAccess } = require('../remote');
const { createReplyServer, splitContent } = require('../reply_server');
const { MEDIA_LIMITS } = require('../outbound_format');
const { waitFor } = require('./helpers/gateway');
const CLIENT = path.resolve(__dirname, '../client/qq_bridge.py');
const TOKEN = 'client-test-only-token-0123456789abcdef0123456789';
const cleanEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('QQ_'))), PYTHONUTF8: '1' });
async function fixture(t, type = 'c2c') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-client-'));
  const calls = [], requests = [], history = [], controls = {};
  const store = new JobStore({ dir: path.join(root, 'jobs') });
  const p = { type, [type === 'c2c' ? 'openid' : 'group_openid']: 'ORIGINAL', msg_id: 'MESSAGE', content: 'original' };
  const job = store.enqueue(p).job, access = new RemoteAccess(store, 'https://bridge.example/reply');
  const api = { seq: new Map(),
    async send(...args) { calls.push(['text', ...args]); if (controls.gate) await controls.gate; return { id: 'SENT' }; },
    async uploadImage() { return { file_info: 'IMAGE' }; },
    async uploadMedia(type, target, item) { calls.push(['upload', type, target, item.kind, item.name]); return { file_info: 'FILE' }; },
    async sendMedia(...args) { calls.push(['media', ...args]); return { id: 'MEDIA' }; } };
  const handler = createReplyServer(api, TOKEN, () => ({ ok: true, version: '1.8.0', ws_state: 'OPEN' }), {
    remote: true, store, access, history: { append: (...args) => history.push(args), readAll: () => [] },
  }).listeners('request')[0];
  const app = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, token: req.headers['x-reply-token'] });
    if (controls.redirect) { res.writeHead(302, { Location: controls.redirect }); res.end('private proxy ' + TOKEN); return; }
    if ((controls.dropReply && req.url === '/reply') || (controls.dropUpload && req.method === 'PUT')) {
      controls.dropReply = controls.dropUpload = false; res.end = () => { req.socket.destroy(); };
    }
    handler(req, res);
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  fs.writeFileSync(path.join(root, 'token'), TOKEN, { mode: 0o600 });
  const config = path.join(root, 'client.json'), task = path.join(root, 'task.json'), state = path.join(root, 'state');
  fs.writeFileSync(config, JSON.stringify({ reply_url: base + '/reply', reply_token_file: 'token' }), { mode: 0o600 });
  const payload = { ...p, job_id: job.id, reply_deadline: new Date(job.deadline).toISOString(),
    reply_url: 'https://attacker.example/reply', reply_policy: { segmented: true, media: { kinds: ['file', 'voice'],
      inline_max_bytes: MEDIA_LIMITS.inlineBytes, file_max_bytes: MEDIA_LIMITS.fileBytes, voice_max_bytes: MEDIA_LIMITS.voiceBytes,
      max_items: 5, job_upload_max_bytes: MEDIA_LIMITS.jobBytes } } };
  fs.writeFileSync(task, JSON.stringify(payload), { mode: 0o600 });
  function start(args, extra = {}) {
    const child = spawn(process.env.PYTHON || 'python', [CLIENT, '--config', config, '--task', task, '--state-dir', state, ...args], {
      cwd: root, env: { ...cleanEnv(), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => {
        try { resolve({ code, value: stdout ? JSON.parse(stdout) : null, stdout, stderr }); } catch (e) { reject(new Error(stderr + stdout)); }
      });
    });
    return { child, done };
  }
  const cli = async (args, extra) => start(args, extra).done;
  t.after(async () => {
    if (controls.release) controls.release();
    app.closeAllConnections(); await new Promise(resolve => app.close(resolve));
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('qq-client-')) throw new Error('unsafe cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, calls, requests, controls, store, job, payload, state, config, task, cli, start, history, api };
}

test('standalone client reads an explicit URL and existing token file, probes without token and reports timings', async t => {
  const f = await fixture(t);
  const result = await f.cli(['doctor', '--live']);
  assert.equal(result.code, 0); assert.equal(result.value.client_version, '1.0.0');
  assert.equal(result.value.bridge_version, '1.8.0'); assert.equal(result.value.reply_token_available, true);
  assert.equal(f.requests[0].path, '/health'); assert.equal(f.requests[0].token, undefined);
  assert.equal(result.value.timings[0].http_status, 200); assert.ok(result.value.timings[0].duration_ms >= 0);
  assert.equal(f.calls.length, 0); assert.ok(!result.stdout.includes(TOKEN)); assert.equal(result.stderr, '');
  fs.writeFileSync(f.config, '{}');
  assert.equal((await f.cli(['doctor'])).value.error, 'missing_reply_url');
  assert.equal(f.requests.length, 1);
});

for (const type of ['c2c', 'group']) test(`client ${type} progress and final fill routing and sequence without model JSON and replay locally`, async t => {
  const f = await fixture(t, type);
  assert.equal((await f.cli(['progress', '--text', '正在处理'])).code, 0);
  fs.writeFileSync(path.join(f.root, 'answer.txt'), '最终回答', 'utf8');
  const result = await f.cli(['final', '--text-file', path.join(f.root, 'answer.txt')]);
  assert.equal(result.code, 0); assert.equal(result.value.reply_seq, 2);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1][1], type); assert.equal(f.calls[1][2], 'ORIGINAL');
  assert.equal(f.calls[1][3], '最终回答'); assert.equal(f.calls[1][4], 'MESSAGE');
  const requests = f.requests.length;
  assert.equal((await f.cli(['final', '--text', '最终回答'])).value.local_replayed, true);
  assert.equal(f.requests.length, requests); assert.equal(f.calls.length, 2);
  assert.equal((await f.cli(['final', '--text', 'changed'])).value.error, 'operation_content_conflict');
  assert.equal(f.calls.length, 2);
  const journal = JSON.parse(fs.readFileSync(path.join(f.state, f.job.id, 'final.json')));
  assert.equal(journal.body.reply_url, undefined); assert.equal(journal.body.reply_seq, 2);
  assert.ok(!JSON.stringify(journal).includes(TOKEN));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.state, f.job.id, 'final.json')).mode & 0o777, 0o600);
});

test('client creates inline image/file/voice data from local artifacts and respects the shared remaining quota', async t => {
  const f = await fixture(t, 'group');
  const image = path.join(f.root, 'image.png'), file = path.join(f.root, '报告.txt'), voice = path.join(f.root, 'voice.wav');
  fs.writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex')); fs.writeFileSync(file, 'report');
  fs.writeFileSync(voice, 'RIFF1234WAVEaudio');
  assert.equal((await f.cli(['progress', '--text', 'working'])).code, 0);
  const result = await f.cli(['final', '--text', 'done', '--image', image, '--file', file, '--voice', voice]);
  assert.equal(result.code, 0); assert.equal(result.value.messages_used, 5);
  assert.equal(result.value.images_sent, 1); assert.equal(result.value.files_sent, 1); assert.equal(result.value.voices_sent, 1);
  assert.deepEqual(f.calls.filter(c => c[0] === 'upload').map(c => c[3]), ['file', 'voice']);
});

test('client streams larger files with deterministic upload IDs and then sends their references', async t => {
  const f = await fixture(t), file = path.join(f.root, '大文件.bin'); fs.writeFileSync(file, Buffer.alloc(6 * 1024 * 1024, 3));
  const result = await f.cli(['final', '--file', file]);
  assert.equal(result.code, 0); assert.equal(result.value.files_sent, 1);
  assert.deepEqual(result.value.timings.map(v => v.operation), ['status', 'upload', 'reply']);
  assert.equal(Object.values(f.job.uploads)[0].bytes, 6 * 1024 * 1024);
  const journal = JSON.parse(fs.readFileSync(path.join(f.state, f.job.id, 'final.json')));
  assert.equal(journal.body.media.length, 1); assert.equal(journal.body.media_base64, undefined);
  assert.equal(f.requests.find(r => r.method === 'PUT').token, TOKEN);
});

test('losing an upload response can retry the same bytes without another upload entry or premature QQ send', async t => {
  const f = await fixture(t), file = path.join(f.root, 'large.bin'); fs.writeFileSync(file, Buffer.alloc(6 * 1024 * 1024, 4));
  f.controls.dropUpload = true;
  assert.equal((await f.cli(['final', '--file', file])).value.error, 'network_error');
  assert.equal(f.calls.length, 0); assert.equal(Object.keys(f.job.uploads).length, 1);
  const retry = await f.cli(['final', '--file', file]);
  assert.equal(retry.value.files_sent, 1, JSON.stringify(retry.value));
  assert.deepEqual(retry.value.timings.map(v => v.operation), ['status', 'upload_status', 'reply']);
  assert.equal(Object.keys(f.job.uploads).length, 1); assert.equal(f.calls.filter(c => c[0] === 'media').length, 1);
});

test('malformed or edited outbox is preserved and never bypassed with a fresh segment', async t => {
  const f = await fixture(t); f.controls.dropReply = true;
  await f.cli(['final', '--text', 'answer']);
  const file = path.join(f.state, f.job.id, 'final.json'), journal = JSON.parse(fs.readFileSync(file));
  journal.body.content = 'edited'; fs.writeFileSync(file, JSON.stringify(journal));
  const count = f.requests.length;
  assert.equal((await f.cli(['resume', '--operation', 'final'])).value.error, 'invalid_outbox');
  assert.equal(f.requests.length, count); assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file)).body.content, 'edited');
});

test('client checks quota and voice format before any upload or QQ send', async t => {
  const f = await fixture(t), voice = path.join(f.root, 'fake.wav'); fs.writeFileSync(voice, 'not audio');
  assert.equal((await f.cli(['final', '--voice', voice])).value.error, 'invalid_voice_format');
  assert.equal(f.requests.length, 0);
  assert.equal((await f.cli(['progress', '--text', 'working'])).code, 0);
  const before = f.requests.length;
  assert.equal((await f.cli(['final', '--text', 'x'.repeat(4501)])).value.error, 'insufficient_reply_quota');
  assert.equal(f.requests.length, before + 1); assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(path.join(f.state, f.job.id, 'final.json')), false);
});

test('a lost POST response leaves an immutable outbox; explicit resume replays the exact segment without another QQ send', async t => {
  const f = await fixture(t); f.controls.dropReply = true;
  const result = await f.cli(['final', '--text', 'answer']);
  assert.equal(result.value.error, 'network_error'); assert.equal(f.calls.length, 1);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal((await f.cli(['final', '--text', 'different'])).value.error, 'operation_content_conflict');
  const resumed = await f.cli(['resume', '--operation', 'final']);
  assert.equal(resumed.code, 0); assert.equal(resumed.value.replayed, true); assert.equal(f.calls.length, 1);
  assert.equal((await f.cli(['resume', '--operation', 'final'])).value.local_replayed, true);
});

test('kernel lock blocks concurrent clients and is released after a crash; a sending reply still cannot be resumed', async t => {
  const f = await fixture(t); f.controls.gate = new Promise(resolve => f.controls.release = resolve);
  const first = f.start(['final', '--text', 'answer']);
  await waitFor(() => f.calls.length === 1, 'client send intent');
  assert.equal((await f.cli(['final', '--text', 'answer'])).value.error, 'client_busy');
  first.child.kill(); await first.done;
  assert.equal((await f.cli(['resume', '--operation', 'final'])).value.error, 'reply_needs_review');
  f.controls.release(); await waitFor(() => f.job.reply.state === 'done', 'finished reply');
  assert.equal((await f.cli(['resume', '--operation', 'final'])).value.replayed, true);
  assert.equal(f.calls.length, 1);
});

test('client rejects redirects, task expiry and credential mistakes without leaking proxy bodies or sending QQ', async t => {
  const f = await fixture(t);
  f.controls.redirect = 'http://127.0.0.1:1/' + TOKEN;
  const result = await f.cli(['status']);
  assert.equal(result.code, 1); assert.equal(f.requests.length, 1);
  assert.ok(!result.stdout.includes(TOKEN)); assert.equal(result.stderr, '');
  delete f.controls.redirect;
  assert.equal((await f.cli(['status'], { QQ_REPLY_TOKEN: 'wrong-token-0123456789abcdef0123456789' })).code, 1);
  fs.writeFileSync(f.task, JSON.stringify({ ...f.payload, reply_deadline: new Date(0).toISOString() }));
  assert.equal((await f.cli(['final', '--text', 'answer'])).value.error, 'task_expired');
  assert.equal(f.calls.length, 0);
});

test('cached QQ failures are reported once and never automatically resent or assigned a new sequence', async t => {
  const f = await fixture(t); f.api.send = async () => { f.calls.push(['failure']); throw new Error('private ' + TOKEN); };
  const result = await f.cli(['final', '--text', 'answer']);
  assert.equal(result.code, 1); assert.equal(result.value.error, 'reply_rejected');
  assert.ok(!result.stdout.includes(TOKEN)); assert.equal(result.value.result.http_status, 502);
  assert.equal((await f.cli(['final', '--text', 'answer'])).value.error, 'operation_failed_needs_review');
  assert.equal((await f.cli(['resume', '--operation', 'final'])).value.error, 'operation_failed_needs_review');
  assert.equal(f.calls.length, 1);
});

test('client text quota uses the same UTF-16 and paragraph splitting as the bridge', async () => {
  const samples = ['', 'x'.repeat(3001), '🙂'.repeat(2000), 'x'.repeat(1499) + '\n\n' + 'y'.repeat(1500),
    'a\n\n' + 'b'.repeat(3000), 'a'.repeat(1500) + '\n' + 'b'.repeat(1500)];
  const code = `import importlib.util,json; s=importlib.util.spec_from_file_location('client',${JSON.stringify(CLIENT)}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps([m.text_parts(t) for t in json.loads(input())]))`;
  const child = spawn(process.env.PYTHON || 'python', ['-c', code], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', stderr = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => stderr += c);
  child.stdin.end(JSON.stringify(samples));
  assert.equal(await new Promise(resolve => child.on('close', resolve)), 0, stderr);
  assert.deepEqual(JSON.parse(output), samples.map(s => s ? splitContent(s, 1500).length : 0));
});
