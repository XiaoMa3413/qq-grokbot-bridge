'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { JobStore } = require('../jobs');
const { validateJob } = require('../job_state');
const { RemoteAccess, replyFingerprint } = require('../remote');
const { createReplyServer } = require('../reply_server');
const { MEDIA_LIMITS, sha256, uploadId, decodeMedia, voiceFormat } = require('../outbound_format');
const { cleanupTemporaryUploads } = require('../outbound_store');
const { uploadMedia, presignedUrl } = require('../qq_media');
const { diagnose } = require('../scripts/doctor');
const { QQApi } = require('../lib');
const { waitFor, fixture: gatewayFixture, event, TOKEN: FIXTURE_TOKEN } = require('./helpers/gateway');
const TOKEN = 'outbound-test-token-0123456789abcdef0123456789';
const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-outbound-'));
  const before = { QQ_MEMORY_DIR: process.env.QQ_MEMORY_DIR, QQ_HISTORY_DIR: process.env.QQ_HISTORY_DIR };
  process.env.QQ_MEMORY_DIR = path.join(root, 'memory'); process.env.QQ_HISTORY_DIR = path.join(root, 'history');
  t.after(() => {
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('qq-outbound-')) throw new Error('unsafe cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  });
  let now = Date.now(); const options = { dir: path.join(root, 'jobs'), now: () => now }, store = new JobStore(options);
  const p = { type: 'c2c', openid: 'U', msg_id: 'M', content: 'source question', attachments: [] }, job = store.enqueue(p).job;
  const access = new RemoteAccess(store, 'https://bridge.example/reply');
  return { root, options, store, p, job, access, advance: ms => now += ms };
}
async function listen(t, app) {
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  return `http://127.0.0.1:${app.address().port}`;
}
function fakeApi(calls = []) {
  return { seq: new Map(), send: async (...args) => { calls.push(['text', ...args]); return { id: 'TEXT' }; },
    uploadMedia: async (type, target, item) => { calls.push(['upload', type, target, item.kind, item.name]); return { file_info: 'FI' }; },
    sendMedia: async (...args) => { calls.push(['media', ...args]); return { id: 'MEDIA' }; } };
}
async function server(t, f, api = fakeApi()) {
  return listen(t, createReplyServer(api, TOKEN, null, { remote: true, store: f.store, access: f.access }));
}
function post(base, body, token = TOKEN) {
  return fetch(base + '/reply', { method: 'POST', headers: { 'X-Reply-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function metadata(kind = 'file', name = '报告.txt', data = Buffer.from('report')) { return { kind, name, bytes: data.length, sha256: sha256(data) }; }
function headers(item) { return { 'X-Reply-Token': TOKEN, 'Content-Type': 'application/octet-stream', 'Content-Length': String(item.bytes),
  'X-Media-Kind': item.kind, 'X-Media-Name': encodeURIComponent(item.name), 'X-Content-SHA256': item.sha256 }; }
function put(base, job, item, data, changes = {}) {
  return fetch(base + `/jobs/${job.id}/uploads/${uploadId(item)}`, { method: 'PUT', headers: { ...headers(item), ...changes }, body: data });
}
function inline(kind, name, data) { return { kind, name, data: data.toString('base64') }; }

test('inline media validates names, strict base64 and matching voice signatures without interpreting ordinary files', () => {
  for (const [name, bytes] of [['voice.silk', Buffer.from('\x02#!SILK_V3data')], ['v.wav', wav], ['v.mp3', Buffer.from('ID3data')], ['v.flac', Buffer.from('fLaCdata')]])
    assert.ok(voiceFormat(name, bytes));
  for (const item of [inline('voice', 'wrong.mp3', wav), inline('voice', 'v.ogg', Buffer.from('OggS')), inline('file', '../secret.txt', wav),
    inline('file', 'bad\nname', wav), { kind: 'file', name: 'x.txt', data: 'AB==' }, inline('video', 'v.mp4', wav)])
    assert.ok(decodeMedia({ media_base64: [item] }).error);
  const valid = decodeMedia({ media_base64: [inline('file', '报告.pdf', Buffer.from('%PDF-report')), inline('voice', 'v.wav', wav)] });
  assert.equal(valid.files.length, 2); assert.equal(valid.files[0].sha256, sha256(Buffer.from('%PDF-report')));
  assert.ok(decodeMedia({ media_base64: [inline('file', 'big.bin', Buffer.alloc(MEDIA_LIMITS.inlineBytes + 1))] }).error);
});
for (const type of ['c2c', 'group']) test(`${type} file and voice callbacks share text quota, record history and replay without another upload`, async t => {
  const f = fixture(t), calls = [];
  const p = type === 'c2c' ? f.p : { ...f.p, type, group_openid: 'G' }, job = f.store.enqueue(p).job;
  const base = await server(t, f, fakeApi(calls));
  const body = { ...p, job_id: job.id, content: 'results', media_base64: [inline('file', '报告.pdf', Buffer.from('%PDF-result')), inline('voice', 'voice.wav', wav)] };
  const response = await post(base, body); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.files_sent, 1); assert.equal(result.voices_sent, 1); assert.equal(result.messages_used, 3);
  assert.deepEqual(calls.map(c => c[0]), ['text', 'upload', 'media', 'upload', 'media']);
  assert.equal(calls[1][1], type); assert.equal(calls[1][3], 'file'); assert.equal(calls[3][3], 'voice');
  assert.equal((await (await post(base, body)).json()).replayed, true); assert.equal(calls.length, 5);
  const changed = structuredClone(body); changed.media_base64[0].name = 'different.pdf';
  assert.equal((await post(base, changed)).status, 409);
  const histories = fs.readdirSync(process.env.QQ_HISTORY_DIR).map(name => fs.readFileSync(path.join(process.env.QQ_HISTORY_DIR, name), 'utf8')).join('\n');
  assert.match(histories, /报告.pdf/); assert.match(histories, /语音/); assert.ok(!histories.includes(wav.toString('base64')));
});
test('progress forbids media and final replies reject insufficient quota before consuming an intent', async t => {
  const f = fixture(t), calls = [], base = await server(t, f, fakeApi(calls));
  const body = { ...f.p, job_id: f.job.id, reply_seq: 1, final: false, content: 'working' };
  assert.equal((await post(base, { ...body, media_base64: [inline('file', 'a.txt', wav)] })).status, 400);
  assert.equal(f.job.reply, null);
  assert.equal((await post(base, body)).status, 200);
  const final = { ...body, reply_seq: 2, final: true, content: 'x'.repeat(3001), media_base64: [inline('file', 'a.txt', wav)] };
  assert.equal((await post(base, final)).status, 409); assert.equal(f.job.replies.length, 1);
  assert.equal((await post(base, { ...final, content: 'done' })).status, 200);
  assert.equal(f.job.sentCount, 3);
});
test('uploads are authenticated, immutable, checksum checked and confined to the registered task', async t => {
  const f = fixture(t), base = await server(t, f), data = Buffer.from('private file'), item = metadata('file', '报告.txt', data);
  assert.equal((await put(base, f.job, item, data, { 'X-Reply-Token': 'wrong' })).status, 401);
  assert.equal((await put(base, f.job, item, Buffer.from('wrong length'))).status, 400);
  assert.equal(f.job.uploads, undefined);
  assert.equal((await put(base, f.job, item, data)).status, 200);
  assert.equal((await (await put(base, f.job, item, data)).json()).replayed, true);
  const status = await fetch(base + `/jobs/${f.job.id}/uploads/${uploadId(item)}`, { headers: { 'X-Reply-Token': TOKEN } });
  assert.deepEqual((await status.json()).media, { upload_id: uploadId(item), ...item });
  const second = f.store.enqueue({ ...f.p, msg_id: 'SECOND' }).job;
  assert.equal((await post(base, { ...second.payload, job_id: second.id, media: [{ upload_id: uploadId(item) }] })).status, 404);
  const reply = { ...f.p, job_id: f.job.id, media: [{ upload_id: uploadId(item) }] };
  assert.equal((await post(base, reply)).status, 200);
  assert.equal((await put(base, f.job, metadata('file', 'next.txt', data), data)).status, 409);
  assert.equal((await (await post(base, reply)).json()).replayed, true);
  f.advance(60 * 60000);
  assert.equal((await put(base, f.job, item, data)).status, 410);
});
test('upload rejects invalid headers, mismatched voice and unsupported methods without publishing files', async t => {
  const f = fixture(t), base = await server(t, f), item = metadata('voice', 'voice.wav', wav);
  for (const changes of [{ 'X-Media-Name': '%ZZ' }, { 'X-Media-Kind': 'video' }, { 'Content-Type': 'text/plain' }, { 'X-Content-SHA256': '0'.repeat(64) }])
    assert.equal((await put(base, f.job, item, wav, changes)).status, 400);
  const bad = metadata('voice', 'voice.mp3', wav);
  assert.equal((await put(base, f.job, bad, wav)).status, 400);
  const response = await fetch(base + `/jobs/${f.job.id}/uploads/${uploadId(item)}`, { method: 'DELETE', headers: { 'X-Reply-Token': TOKEN } });
  assert.equal(response.status, 405); assert.equal(f.job.uploads, undefined);
  assert.deepEqual(fs.readdirSync(path.join(f.store.dir, 'outbound')), []);
});
test('aborted and concurrent uploads clean temporary state and never create a reply intent', async t => {
  const f = fixture(t), base = await server(t, f), data = Buffer.alloc(1024 * 1024, 1), item = metadata('file', 'large.bin', data);
  const req = http.request(base + `/jobs/${f.job.id}/uploads/${uploadId(item)}`, { method: 'PUT', headers: headers(item) });
  req.on('error', () => {}); req.write(data.subarray(0, 100));
  await waitFor(() => f.access.outbound.active.has(f.job.id), 'upload started');
  assert.equal((await put(base, f.job, item, data)).status, 409);
  req.destroy(); await waitFor(() => !f.access.outbound.active.size, 'abort cleanup');
  assert.equal(f.job.reply, null); assert.equal(f.job.uploads, undefined);
  assert.deepEqual(fs.readdirSync(path.join(f.store.dir, 'outbound')), []);
});
for (const state of ['expired', 'closed']) test(`upload cannot publish after task becomes ${state} during transfer`, async t => {
  const f = fixture(t), base = await server(t, f), data = Buffer.alloc(1000, 1), item = metadata('file', 'file.bin', data);
  const result = new Promise(resolve => {
    const req = http.request(base + `/jobs/${f.job.id}/uploads/${uploadId(item)}`, { method: 'PUT', headers: headers(item) }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => {}); req.write(data.subarray(0, 100));
    waitFor(() => f.access.outbound.active.has(f.job.id), 'upload started').then(() => {
      if (state === 'expired') f.advance(60 * 60000);
      else { f.store.beginReply(f.job, 'finished'); f.store.finishReply(f.job, 200, { ok: true }); }
      req.end(data.subarray(100));
    });
  });
  assert.equal(await result, state === 'expired' ? 410 : 409);
  assert.equal(f.job.uploads, undefined); assert.deepEqual(fs.readdirSync(path.join(f.store.dir, 'outbound')), []);
});
test('global upload concurrency is bounded and aborted streams release every slot', async t => {
  const f = fixture(t), base = await server(t, f), data = Buffer.alloc(1000), item = metadata('file', 'file.bin', data), requests = [];
  for (let i = 0; i < 4; i++) {
    const job = f.store.enqueue({ ...f.p, msg_id: 'UPLOAD' + i }).job;
    const req = http.request(base + `/jobs/${job.id}/uploads/${uploadId(item)}`, { method: 'PUT', headers: headers(item) });
    req.on('error', () => {}); req.write(data.subarray(0, 100)); requests.push(req);
  }
  await waitFor(() => f.access.outbound.active.size === 4, 'four upload slots');
  assert.equal((await put(base, f.job, item, data)).status, 503);
  for (const req of requests) req.destroy();
  await waitFor(() => f.access.outbound.active.size === 0, 'released upload slots');
  assert.equal((await put(base, f.job, item, data)).status, 200);
});
test('doctor refuses linked upload storage without modifying files or leaking its destination', async t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.store.dir, 'outbound'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(outside, 'keep'), 'private'); fs.writeFileSync(path.join(f.root, 'config.json'), '{}');
  const report = await diagnose({ dir: f.root, env: { QQ_JOBS_DIR: f.store.dir, QQ_REPLY_PUBLIC_URL: 'https://bridge.example/reply' } });
  assert.equal(report.checks.find(c => c.id === 'outbound_storage').status, 'fail');
  assert.ok(!JSON.stringify(report).includes(outside)); assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'private');
});
test('registry failures before and after commit can be retried across restart without another QQ send', async t => {
  const f = fixture(t), base = await server(t, f), data = Buffer.from('artifact'), item = metadata('file', 'a.txt', data);
  const save = f.store.save.bind(f.store); let mode = 'before';
  f.store.save = job => { if (mode === 'before') throw new Error('private path must not leak'); save(job); if (mode === 'after') throw new Error('confirmation lost'); };
  let response = await put(base, f.job, item, data); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('private path'));
  assert.equal(f.job.uploads, undefined);
  mode = 'after'; response = await put(base, f.job, item, data); assert.equal(response.status, 503);
  const restored = new JobStore(f.options), access = new RemoteAccess(restored, 'https://bridge.example/reply');
  const restarted = await listen(t, createReplyServer(fakeApi(), TOKEN, null, { remote: true, store: restored, access }));
  assert.equal((await (await put(restarted, restored.get(f.job.id), item, data)).json()).replayed, true);
  assert.equal(restored.get(f.job.id).reply, null);
});
test('media failures preserve partial send results and never resend completed text or attachments', async t => {
  const f = fixture(t), calls = [], api = fakeApi(calls); let uploads = 0;
  api.uploadMedia = async () => { if (++uploads === 2) throw Object.assign(new Error('secret-url'), { body: { code: 403, raw: 'private' } }); return { file_info: 'FI' }; };
  const base = await server(t, f, api), body = { ...f.p, media_base64: [inline('file', 'one.txt', wav), inline('voice', 'v.wav', wav)], content: 'done' };
  const response = await post(base, body); assert.equal(response.status, 502); const result = await response.json();
  assert.equal(result.parts_sent, 1); assert.equal(result.files_sent, 1); assert.equal(result.voices_sent, 0);
  assert.ok(!JSON.stringify(result).includes('secret-url')); assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal((await (await post(base, body)).json()).replayed, true); assert.equal(uploads, 2);
  assert.equal(f.job.reply.body.ok, false);
});
test('inline and uploaded references for identical media share the same replay fingerprint', async t => {
  const f = fixture(t), calls = [], base = await server(t, f, fakeApi(calls)), data = Buffer.from('artifact'), item = metadata('file', '报告.txt', data);
  assert.equal((await put(base, f.job, item, data)).status, 200);
  const body = { ...f.p, media_base64: [inline('file', '报告.txt', data)] };
  assert.equal((await post(base, body)).status, 200);
  const replay = { ...f.p, media: [{ upload_id: uploadId(item) }] };
  assert.equal((await (await post(base, replay)).json()).replayed, true);
  assert.equal(calls.filter(c => c[0] === 'upload').length, 1);
});
test('upload sources reject storage escapes and changed content; completed references still replay from cache', async t => {
  const f = fixture(t), base = await server(t, f), data = Buffer.from('artifact'), item = metadata('file', 'a.txt', data);
  await put(base, f.job, item, data);
  const source = f.access.outbound.source(f.job, f.access.outbound.describe(f.job, uploadId(item)));
  const secret = path.join(f.root, 'private.txt'); fs.writeFileSync(secret, 'secrets!');
  fs.unlinkSync(source.path); fs.symlinkSync(secret, source.path);
  assert.throws(() => f.access.outbound.source(f.job, f.access.outbound.describe(f.job, uploadId(item))));
  fs.unlinkSync(source.path); fs.writeFileSync(source.path, data);
  const reply = { ...f.p, media: [{ upload_id: uploadId(item) }] };
  assert.equal((await post(base, reply)).status, 200);
  fs.unlinkSync(source.path);
  assert.equal((await (await post(base, reply)).json()).replayed, true);
});
test('upload retention and crash cleanup remove only this queue job artifacts', async t => {
  const f = fixture(t), base = await server(t, f), data = Buffer.from('artifact'), item = metadata('file', 'a.txt', data);
  await put(base, f.job, item, data);
  const root = path.join(f.store.dir, 'outbound'), temp = `${f.job.id}.${uploadId(item)}.bin.${crypto.randomUUID()}.part`;
  fs.writeFileSync(path.join(root, temp), 'partial'); fs.writeFileSync(path.join(root, 'keep.txt'), 'keep');
  cleanupTemporaryUploads(f.store.dir); assert.ok(!fs.existsSync(path.join(root, temp))); assert.ok(fs.existsSync(path.join(root, 'keep.txt')));
  f.advance(8 * 86400000); f.store.prune();
  assert.deepEqual(fs.readdirSync(root), ['keep.txt']); assert.equal(f.store.get(f.job.id), undefined);
});
test('upload registry limits and persisted metadata are checked, including orphan disk usage', async t => {
  const f = fixture(t), base = await server(t, f), data = Buffer.from('artifact');
  for (let i = 0; i < 5; i++) assert.equal((await put(base, f.job, metadata('file', `f${i}.txt`, data), data)).status, 200);
  assert.equal((await put(base, f.job, metadata('file', 'six.txt', data), data)).status, 413);
  const record = structuredClone(f.job); record.uploads[Object.keys(record.uploads)[0]].bytes = -1;
  assert.throws(() => validateJob(record, record.id + '.json'), { code: 'EJOBSTATE' });
  const other = f.store.enqueue({ ...f.p, msg_id: 'ORPHAN' }).job;
  const id = 'a'.repeat(64); const file = path.join(f.store.dir, 'outbound', `${other.id}.${id}.bin`);
  const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, MEDIA_LIMITS.jobBytes); fs.closeSync(fd);
  assert.equal((await put(base, other, metadata('file', 'new.txt', data), data)).status, 413);
});
test('QQ wire upload sends file_type 3/4 without auto-send, then msg_type 7 with the original message sequence', async t => {
  const requests = [];
  const base = await listen(t, http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      assert.equal(req.headers.authorization, 'QQBot MOCK'); const parsed = JSON.parse(body); requests.push({ url: req.url, body: parsed });
      res.setHeader('Content-Type', 'application/json'); res.end(req.url.endsWith('/files') ? '{"file_info":"FI"}' : '{"id":"SENT"}');
    });
  }));
  const api = new QQApi({ apiBase: base }, { get: async () => 'MOCK' });
  for (const type of ['c2c', 'group']) for (const kind of ['file', 'voice']) {
    const item = { ...metadata(kind, kind === 'file' ? '报告.txt' : 'v.wav', wav), buf: wav };
    const uploaded = await api.uploadMedia(type, 'U /', item); await api.sendMedia(type, 'U /', uploaded.file_info, 'M');
  }
  assert.deepEqual(requests.filter(r => r.url.endsWith('/files')).map(r => r.body.file_type), [4, 3, 4, 3]);
  for (const r of requests.filter(r => r.url.endsWith('/files'))) { assert.equal(r.body.srv_send_msg, false); assert.equal(r.body.file_data, wav.toString('base64')); }
  assert.deepEqual(requests.filter(r => r.url.endsWith('/messages')).map(r => r.body.msg_seq), [1, 2, 3, 4]);
  assert.ok(requests.every(r => r.url.includes('U%20%2F')));
});
for (const kind of ['file', 'voice']) test(`large QQ ${kind} uploads validate part plans, checksum every stage and never put credentials on the presigned URL`, async () => {
  const bytes = Buffer.alloc(MEDIA_LIMITS.inlineBytes + 7, 1);
  if (kind === 'voice') Buffer.from('\x02#!SILK_V3').copy(bytes);
  const item = { ...metadata(kind, kind === 'voice' ? 'large.silk' : 'large.bin', bytes), buf: bytes };
  const requests = [], parts = [];
  const api = { req: async (method, route, body) => {
    requests.push({ route, body });
    if (route.endsWith('/upload_prepare')) return { upload_id: 'UP', block_size: MEDIA_LIMITS.inlineBytes,
      parts: [{ index: 2, presigned_url: 'https://bucket.cos.ap-test.myqcloud.com/2?sign=private' }, { index: 1, presigned_url: 'https://bucket.cos.ap-test.myqcloud.com/1?sign=private' }] };
    return route.endsWith('/files') ? { file_info: 'FI' } : {};
  } };
  const result = await uploadMedia(api, 'group', 'G', item, { put: async (url, data, timeout) => { parts.push({ url: url.href, data: Buffer.from(data), timeout }); } });
  assert.equal(result.file_info, 'FI'); assert.deepEqual(Buffer.concat(parts.map(p => p.data)), bytes);
  assert.equal(requests[0].body.md5, crypto.createHash('md5').update(bytes).digest('hex'));
  assert.equal(requests[0].body.sha1, crypto.createHash('sha1').update(bytes).digest('hex'));
  assert.equal(requests[0].body.file_type, kind === 'voice' ? 3 : 4);
  assert.deepEqual(requests.at(-1).body, { upload_id: 'UP' }); assert.equal(parts.length, 2);
  for (const bad of ['http://bucket.myqcloud.com/x', 'https://localhost/x', 'https://bucket.myqcloud.com.evil.test/x', 'https://user:pass@bucket.myqcloud.com/x']) assert.throws(() => presignedUrl(bad));
  await assert.rejects(uploadMedia(api, 'group', 'G', { ...item, sha256: '0'.repeat(64) }, { put: async () => {} }), { code: 'EMEDIAUPLOAD' });
});
test('large QQ upload rejects unsupported plans and stops on deadline or business permission failure without fallback send', async () => {
  const bytes = Buffer.alloc(MEDIA_LIMITS.inlineBytes, 1), item = { ...metadata('file', 'large.bin', bytes), buf: bytes }; let puts = 0;
  for (const plan of [null, { upload_id: 'UP', block_size: 0, parts: [] }, { upload_id: 'UP', block_size: bytes.length,
    parts: [{ index: 1, presigned_url: 'https://evil.test/x' }] }]) {
    await assert.rejects(uploadMedia({ req: async () => plan }, 'c2c', 'U', item, { put: async () => puts++ }), { code: 'EMEDIAUPLOAD' });
  }
  assert.equal(puts, 0);
  await assert.rejects(uploadMedia({ req: async () => { throw new Error('must not call'); } }, 'c2c', 'U', item, { deadline: 1, now: () => 1 }), { code: 'EMEDIAUPLOAD' });
  const error = await uploadMedia({ req: async () => { throw Object.assign(new Error('secret'), { status: 403, body: { code: 123, secret: 'hidden' } }); } },
    'c2c', 'U', { ...metadata('file', 'a.txt', wav), buf: wav }).catch(e => e);
  assert.deepEqual(error.body, { http_status: 403, code: 123 }); assert.ok(!error.message.includes('secret'));
  const businessError = await uploadMedia({ req: async () => ({ code: 321, message: 'private' }) }, 'c2c', 'U', { ...metadata('file', 'a.txt', wav), buf: wav }).catch(e => e);
  assert.deepEqual(businessError.body, { code: 321 });
});
test('100 MiB artifact streams through the bridge and QQ chunk pipeline; oversized metadata is rejected before writing', async t => {
  const f = fixture(t), file = path.join(f.root, 'large.bin');
  const handle = fs.openSync(file, 'w'); fs.ftruncateSync(handle, MEDIA_LIMITS.fileBytes); fs.closeSync(handle);
  const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const item = { kind: 'file', name: 'large.bin', bytes: MEDIA_LIMITS.fileBytes, sha256: hash.digest('hex') };
  let putBytes = 0, parts = 0, sends = 0, prepare;
  const api = new QQApi({}, {}, { putMediaPart: async (url, data) => { putBytes += data.length; parts++; } });
  api.req = async (method, route, body) => {
    if (route.endsWith('/upload_prepare')) {
      prepare = body;
      return { upload_id: 'UP', block_size: 10 * 1024 * 1024, parts: Array.from({ length: 10 }, (_, i) => ({ index: i + 1,
        presigned_url: `https://bucket.cos.ap-test.myqcloud.com/${i + 1}` })) };
    }
    if (route.endsWith('/files')) return { file_info: 'FI' };
    if (route.endsWith('/messages')) { sends++; return { id: 'SENT' }; }
    return {};
  };
  const base = await server(t, f, api), stream = fs.createReadStream(file);
  const response = await fetch(base + `/jobs/${f.job.id}/uploads/${uploadId(item)}`, { method: 'PUT', headers: headers(item), body: stream, duplex: 'half' });
  assert.equal(response.status, 200); assert.equal(f.job.uploads[uploadId(item)].bytes, MEDIA_LIMITS.fileBytes);
  const reply = await post(base, { ...f.p, content: undefined, media: [{ upload_id: uploadId(item) }] });
  assert.equal(reply.status, 200); assert.equal((await reply.json()).files_sent, 1);
  assert.equal(putBytes, MEDIA_LIMITS.fileBytes); assert.equal(parts, 10); assert.equal(sends, 1);
  assert.equal(prepare.md5_10m, crypto.createHash('md5').update(Buffer.alloc(10002432)).digest('hex'));
  const other = f.store.enqueue({ ...f.p, msg_id: 'BIG' }).job;
  const bad = { ...item, bytes: MEDIA_LIMITS.fileBytes + 1 };
  const rejected = await new Promise(resolve => {
    const req = http.request(base + `/jobs/${other.id}/uploads/${uploadId(bad)}`, { method: 'PUT', headers: headers(bad) }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => {}); req.end();
  });
  assert.equal(rejected, 400); assert.equal(other.uploads, undefined);
});
test('upload client uses fixed origin, streams a local artifact and outputs a checked reference without sending QQ', async t => {
  const f = fixture(t), calls = [], base = await server(t, f, fakeApi(calls)), file = path.join(f.root, 'report.txt');
  fs.writeFileSync(file, 'report');
  const cli = env => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '../scripts/upload-media.js'), '--job', f.job.id, '--kind', 'file', '--file', file],
      { env: { ...process.env, QQ_REPLY_URL: base + '/reply', QQ_REPLY_TOKEN: TOKEN, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  const result = await cli({}); assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).media.sha256, sha256(Buffer.from('report'))); assert.equal(calls.length, 0); assert.equal(f.job.reply, null);
  const failed = await cli({ QQ_REPLY_URL: 'http://remote.example/reply' }); assert.equal(failed.code, 1); assert.ok(!failed.stderr.includes(f.root));
  let leaked = false;
  const target = await listen(t, http.createServer((req, res) => { leaked = true; res.end('{}'); }));
  const redirect = await listen(t, http.createServer((req, res) => { req.resume(); res.writeHead(307, { Location: target + '/upload' }); res.end(); }));
  const redirected = await cli({ QQ_REPLY_URL: redirect + '/reply' }); assert.equal(redirected.code, 1); assert.equal(leaked, false);
});
for (const type of ['c2c', 'group']) test(`real ${type} bridge advertises media, sends file/voice and restores cached results after restart`, { timeout: 20000 }, async t => {
  const incoming = type === 'c2c' ? event('MEDIA', 2) : { op: 0, s: 2, t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'MEDIA', group_openid: 'G', content: 'test', timestamp: new Date().toISOString(), author: { member_openid: 'U' } } };
  const f = await gatewayFixture(t, { events: [incoming] }), child = await f.start();
  await waitFor(() => f.deliveries.length === 1, 'media-enabled task');
  const p = f.deliveries[0];
  assert.deepEqual(p.reply_policy.media.kinds, ['file', 'voice']); assert.equal(p.reply_policy.media.file_max_bytes, MEDIA_LIMITS.fileBytes);
  const body = { job_id: p.job_id, type: p.type, msg_id: p.msg_id, ...(type === 'c2c' ? { openid: p.openid } : { group_openid: p.group_openid }),
    content: 'result', media_base64: [inline('file', '报告.txt', Buffer.from('report')), inline('voice', 'v.wav', wav)] };
  // The process fixture uses its own credential, independent of this unit server.
  const reply = url => fetch(url + '/reply', { method: 'POST', headers: { 'X-Reply-Token': FIXTURE_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const response = await reply(child.url); assert.equal(response.status, 200); assert.equal((await response.json()).voices_sent, 1);
  assert.deepEqual(f.uploads.map(u => u.file_type), [4, 3]); assert.ok(f.uploads.every(u => u.srv_send_msg === false));
  assert.deepEqual(f.sends.map(s => s.msg_type), [0, 7, 7]); assert.deepEqual(f.sends.map(s => s.msg_seq), [1, 2, 3]);
  await f.stop(child); const restarted = await f.start();
  await waitFor(async () => (await f.health(restarted)).jobs?.completed === 1, 'restored media task');
  assert.equal((await (await reply(restarted.url)).json()).replayed, true); assert.equal(f.uploads.length, 2); assert.equal(f.sends.length, 3);
});
test('crash during a file message preserves uncertain state and blocks another upload or send', { timeout: 20000 }, async t => {
  const f = await gatewayFixture(t, { events: [event('CRASH_FILE', 2)], holdSend: true }), child = await f.start();
  await waitFor(() => f.deliveries.length === 1, 'file task'); const p = f.deliveries[0];
  const body = { job_id: p.job_id, type: p.type, openid: p.openid, msg_id: p.msg_id, media_base64: [inline('file', 'report.txt', Buffer.from('report'))] };
  const reply = url => fetch(url + '/reply', { method: 'POST', headers: { 'X-Reply-Token': FIXTURE_TOKEN }, body: JSON.stringify(body) });
  const pending = reply(child.url).catch(() => null);
  await waitFor(() => f.sends.length === 1, 'file send started');
  await f.stop(child, 'SIGKILL'); await pending;
  const restarted = await f.start(); await waitFor(async () => (await f.health(restarted)).jobs?.uncertain === 1, 'uncertain file recovery');
  const blocked = await reply(restarted.url); assert.equal(blocked.status, 409); assert.equal(f.sends.length, 1); assert.equal(f.uploads.length, 1);
});
