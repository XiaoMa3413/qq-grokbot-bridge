'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { JobStore, ForwardWorker, digest } = require('../jobs');
const { RemoteAccess, decodeImages, replyFingerprint } = require('../remote');
const { createReplyServer } = require('../reply_server');
const { GatewaySession } = require('../gateway_session');
const TOKEN = 'test-reliability-0123456789abcdef0123456789';
const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-durable-'));
  const before = { QQ_MEMORY_DIR: process.env.QQ_MEMORY_DIR, QQ_HISTORY_DIR: process.env.QQ_HISTORY_DIR };
  process.env.QQ_MEMORY_DIR = path.join(dir, 'memory'); process.env.QQ_HISTORY_DIR = path.join(dir, 'history');
  t.after(() => {
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let now = Date.now();
  const options = { dir: path.join(dir, 'jobs'), now: () => now };
  return { dir, options, store: new JobStore(options), advance: ms => now += ms };
}
function payload(msg_id = 'm1', openid = 'U') {
  return { type: 'c2c', openid, msg_id, content: 'hello', timestamp: new Date().toISOString(), attachments: [] };
}
async function server(t, store, access, api) {
  const app = createReplyServer(api, TOKEN, () => ({ ok: true, jobs: store.summary() }), { remote: true, store, access });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  return `http://127.0.0.1:${app.address().port}`;
}
function request(base, url, body, { method = 'POST', token = TOKEN, headers = {} } = {}) {
  return fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Reply-Token': token, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('durable queue restores retries, honors Retry-After and never replays an accepted webhook', async t => {
  const f = setup(t), first = f.store.enqueue(payload());
  assert.equal(f.store.enqueue(payload()).added, false);
  const second = f.store.enqueue(payload('m2'));
  const other = f.store.enqueue(payload('m3', 'OTHER'));
  const calls = [];
  const worker = new ForwardWorker(f.store, { send: async (p, job) => {
    calls.push(job.id);
    return job.id === first.job.id ? { ok: false, status: 429, retryAfterMs: 20000 } : { ok: true, status: 202 };
  } });
  await Promise.all([worker.runOnce(), worker.runOnce()]);
  assert.deepEqual(calls, [first.job.id, other.job.id]);
  assert.equal(second.job.attempts, 0);
  const restored = new JobStore(f.options);
  let retryCount = 0;
  const resumed = new ForwardWorker(restored, { send: async () => { retryCount++; return { ok: true, status: 200 }; } });
  f.advance(19999); await resumed.runOnce(); assert.equal(retryCount, 0);
  f.advance(1); await resumed.runOnce(); assert.equal(retryCount, 1);
  await resumed.runOnce(); assert.equal(retryCount, 1);
  const accepted = restored.get(first.job.id);
  restored.beginReply(accepted, 'first'); restored.finishReply(accepted, 200, { ok: true });
  await resumed.runOnce(); assert.equal(retryCount, 2);
  assert.equal(restored.get(second.job.id).delivery, 'accepted');
});

test('a failed dispatch intent recovers without restart and preserves conversation order', async t => {
  const f = setup(t), first = f.store.enqueue(payload()).job;
  const second = f.store.enqueue(payload('m2')).job;
  const save = f.store.save.bind(f.store), calls = [];
  let failNextSave = true, preparations = 0;
  f.store.save = job => {
    if (failNextSave) {
      failNextSave = false;
      throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });
    }
    save(job);
  };
  const worker = new ForwardWorker(f.store, {
    prepare: async p => { preparations++; return p; },
    send: async (p, job) => {
      const persisted = JSON.parse(fs.readFileSync(path.join(f.store.dir, job.id + '.json'), 'utf8'));
      assert.equal(persisted.delivery, 'dispatching');
      assert.equal(persisted.attempts, 1);
      calls.push(p.msg_id);
      return { ok: true, status: 200 };
    },
  });
  await assert.rejects(worker.runOnce(), { code: 'ENOSPC' });
  const persisted = JSON.parse(fs.readFileSync(path.join(f.store.dir, first.id + '.json'), 'utf8'));
  assert.equal(first.delivery, 'pending'); assert.equal(first.attempts, 0);
  assert.equal(persisted.delivery, 'pending'); assert.equal(persisted.attempts, 0);
  assert.equal(preparations, 0); assert.deepEqual(calls, []);

  // The same worker/store must recover; restarting would hide the original bug.
  await worker.runOnce();
  assert.deepEqual(calls, ['m1']); assert.equal(first.attempts, 1);
  assert.equal(second.delivery, 'pending'); assert.equal(second.attempts, 0);
  await worker.runOnce(); assert.deepEqual(calls, ['m1']);
  f.store.beginReply(first, 'final'); f.store.finishReply(first, 200, { ok: true });
  await worker.runOnce();
  assert.deepEqual(calls, ['m1', 'm2']); assert.equal(preparations, 2);
  assert.equal(second.delivery, 'accepted');
});

test('pending jobs expire at QQ deadlines and a permanent webhook error is not retried', async t => {
  const f = setup(t);
  const group = f.store.enqueue({ type: 'group', group_openid: 'G', msg_id: 'g1', timestamp: new Date().toISOString() }).job;
  const failed = f.store.enqueue(payload()).job;
  let sends = 0;
  const worker = new ForwardWorker(f.store, { send: async () => { sends++; return { ok: false, status: 401 }; } });
  f.advance(5 * 60000);
  await worker.runOnce(); await worker.runOnce();
  assert.equal(group.delivery, 'expired'); assert.equal(failed.delivery, 'failed'); assert.equal(sends, 1);
  assert.equal(f.store.summary().expired, 1);
});

test('a crash during webhook dispatch is recovered, but a crash during QQ send is uncertain', async t => {
  const f = setup(t), job = f.store.enqueue(payload()).job;
  job.delivery = 'dispatching'; f.store.save(job);
  const recovered = new JobStore(f.options);
  assert.equal(recovered.get(job.id).delivery, 'pending');
  recovered.beginReply(recovered.get(job.id), 'same');
  const crashed = new JobStore(f.options), record = crashed.get(job.id);
  assert.equal(record.reply.state, 'uncertain');
  assert.equal(crashed.beginReply(record, 'same').status, 409);
  assert.equal(crashed.summary().uncertain, 1);
});

test('concurrent callbacks and callbacks after restart send exactly one completed reply', async t => {
  const f = setup(t), job = f.store.enqueue(payload()).job;
  let sends = 0, release;
  const gate = new Promise(resolve => release = resolve);
  const api = { seq: new Map(), send: async () => { sends++; await gate; return { id: 'sent' }; } };
  const base = await server(t, f.store, null, api);
  const body = { ...payload(), content: 'reply' };
  const pending = request(base, '/reply', body);
  while (!sends) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await request(base, '/reply', body)).status, 409);
  release(); assert.equal((await pending).status, 200);
  const replay = await (await request(base, '/reply', body)).json();
  assert.equal(replay.replayed, true); assert.equal(sends, 1);
  assert.equal((await request(base, '/reply', { ...body, content: 'different' })).status, 409);
  assert.equal((await request(base, '/reply', { ...body, openid: 'somebody-else' })).status, 404);
  assert.equal((await request(base, '/reply', { ...body, job_id: 'wrong' })).status, 404);
  const restored = new JobStore(f.options);
  const restarted = await server(t, restored, null, api);
  assert.equal((await (await request(restarted, '/reply', body)).json()).replayed, true);
  assert.equal(restored.get(job.id).reply.state, 'done'); assert.equal(sends, 1);
});

test('partially failed replies retain their outcome and are never sent again by a callback retry', async t => {
  const f = setup(t); f.store.enqueue(payload());
  let sends = 0;
  const api = { seq: new Map(), send: async () => { if (++sends === 2) throw new Error('QQ error'); return { id: 'part' }; } };
  const base = await server(t, f.store, null, api), body = { ...payload(), content: 'x'.repeat(1600) };
  const response = await request(base, '/reply', body);
  assert.equal(response.status, 502); assert.equal((await response.json()).parts_sent, 1);
  const retry = await request(base, '/reply', body);
  assert.equal(retry.status, 502); assert.equal((await retry.json()).replayed, true); assert.equal(sends, 2);
});

test('remote payload hides local paths, and authenticated media access is confined to the job', async t => {
  const f = setup(t), media = path.join(f.dir, 'media'); fs.mkdirSync(media);
  const image = path.join(media, 'photo.png'); fs.writeFileSync(image, png);
  const raw = { ...payload(), memory_path: '/private/notes', attachments: [{ local_path: image, content_type: 'image/png' }],
    quoted: [{ attachments: [{ local_path: path.join(f.dir, 'secret.png') }] }] };
  fs.writeFileSync(path.join(f.dir, 'secret.png'), png);
  const job = f.store.enqueue(raw).job;
  const access = new RemoteAccess(f.store, 'https://bridge.example/reply', { mediaRoot: media });
  const transformed = access.payload(raw, job); f.store.save(job);
  assert.equal(transformed.memory_path, undefined);
  assert.equal(transformed.attachments[0].local_path, undefined);
  assert.equal(transformed.quoted[0].attachments[0].download_url, undefined);
  assert.equal(transformed.memory.content, '');
  // Directory symlinks / Windows junctions must not expose a file outside mediaRoot.
  fs.symlinkSync(f.dir, path.join(media, 'escape'), 'junction');
  const escaped = access.payload({ ...raw, attachments: [{ local_path: path.join(media, 'escape', 'secret.png') }] }, job);
  assert.equal(escaped.attachments[0].download_url, undefined);
  const base = await server(t, f.store, access, { seq: new Map() });
  const asset = new URL(transformed.attachments[0].download_url).pathname;
  assert.equal((await request(base, asset, undefined, { method: 'GET', token: 'wrong' })).status, 401);
  assert.deepEqual(Buffer.from(await (await request(base, asset, undefined, { method: 'GET' })).arrayBuffer()), png);
  const foreign = f.store.enqueue(payload('foreign')).job;
  assert.equal((await request(base, asset.replace(job.id, foreign.id), undefined, { method: 'GET' })).status, 404);
  assert.equal((await request(base, `/jobs/${job.id}/media/${'a'.repeat(64)}`, undefined, { method: 'GET' })).status, 404);
  f.advance(60 * 60000);
  assert.equal((await request(base, asset, undefined, { method: 'GET' })).status, 410);
});

test('remote memory survives restart and optimistic locking prevents stale overwrites', async t => {
  const f = setup(t), job = f.store.enqueue(payload()).job;
  const access = new RemoteAccess(f.store, 'https://bridge.example/reply');
  const base = await server(t, f.store, access, { seq: new Map() });
  const url = `/jobs/${job.id}/memory`;
  const initial = await (await request(base, url, undefined, { method: 'GET' })).json();
  assert.equal((await request(base, url, { content: 'first' }, { method: 'PUT' })).status, 428);
  const updated = await request(base, url, { content: '记忆 first' }, { method: 'PUT', headers: { 'If-Match': initial.etag } });
  assert.equal(updated.status, 200);
  assert.equal((await request(base, url, { content: 'stale' }, { method: 'PUT', headers: { 'If-Match': initial.etag } })).status, 412);
  const read = await (await request(base, url, undefined, { method: 'GET' })).json();
  assert.equal(read.content, '记忆 first');
  assert.equal((await request(base, url, { content: 'x'.repeat(65537) }, { method: 'PUT', headers: { 'If-Match': read.etag } })).status, 413);
  const restored = new JobStore(f.options);
  const restart = await server(t, restored, new RemoteAccess(restored, 'https://bridge.example/reply'), { seq: new Map() });
  assert.equal((await (await request(restart, url, undefined, { method: 'GET' })).json()).content, '记忆 first');
});

test('remote base64 images upload without server paths and share the text reply quota', async t => {
  const f = setup(t); f.store.enqueue(payload());
  const calls = [];
  const api = { seq: new Map(), uploadImage: async (type, target, buf, name) => { calls.push(['upload', name, buf.length]); return { file_info: 'FI' }; },
    send: async () => { calls.push(['text']); return { id: 'text' }; }, sendMedia: async () => { calls.push(['media']); return { id: 'image' }; } };
  const base = await server(t, f.store, null, api);
  const image = { name: 'photo.png', data: png.toString('base64') };
  assert.ok(decodeImages({ images_base64: [{ ...image, name: '../photo.png' }] }).error);
  assert.ok(decodeImages({ images_base64: [{ data: 'not base64' }] }).error);
  assert.ok(decodeImages({ images_base64: [{ data: Buffer.from('not an image').toString('base64') }] }).error);
  const body = { ...payload(), content: 'caption', images_base64: [image] };
  const response = await request(base, '/reply', body);
  assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.images_sent, 1);
  assert.deepEqual(calls, [['text'], ['upload', 'photo.png', png.length], ['media']]);
  const fingerprint = replyFingerprint(body, decodeImages(body).files);
  assert.equal(fingerprint.length, 64);
  assert.equal((await (await request(base, '/reply', body)).json()).replayed, true); assert.equal(calls.length, 3);
  f.store.enqueue(payload('quota'));
  const quota = await (await request(base, '/reply', { ...payload('quota'), content: 'x'.repeat(3001), images_base64: [image, image] })).json();
  assert.equal(quota.parts_sent, 3); assert.equal(quota.images_sent, 1); assert.equal(quota.images_skipped, 1);
});

test('full size images are bounded without regex recursion or permissive base64 decoding', () => {
  const image = Buffer.alloc(5 * 1024 * 1024); png.copy(image);
  assert.equal(decodeImages({ images_base64: [{ data: image.toString('base64') }] }).files[0].buf.length, image.length);
  assert.ok(decodeImages({ images_base64: [{ data: 'AB==' }] }).error);
  const threeMiB = image.subarray(0, 3 * 1024 * 1024).toString('base64');
  assert.ok(decodeImages({ images_base64: [{ data: threeMiB }, { data: threeMiB }] }).error);
});

for (const [type, cap] of [['c2c', 4], ['group', 5]]) test(`${type} advertised reply policy matches enforced limits and remaining quota`, async t => {
  const f = setup(t), p = type === 'c2c' ? payload() : { ...payload(), type, group_openid: 'G' };
  const job = f.store.enqueue(p).job, access = new RemoteAccess(f.store, 'https://bridge.example/reply');
  const policy = access.payload(p, job).reply_policy;
  assert.equal(policy.message_limit, cap);
  let sends = 0;
  const base = await server(t, f.store, access, { seq: new Map(), send: async () => { sends++; return { id: 'SENT' }; } });
  const reply = (seq, final, content = 'working') => request(base, '/reply', { ...p, reply_seq: seq, final, content });
  assert.equal((await reply(1, false, 'x'.repeat(policy.progress_max_chars + 1))).status, 400);
  for (let seq = 1; seq <= cap - policy.reserve_final; seq++) {
    const r = await reply(seq, false, 'x'.repeat(policy.progress_max_chars));
    assert.equal(r.status, 200); assert.equal((await r.json()).messages_remaining, cap - seq);
  }
  assert.equal((await reply(cap, false)).status, 409);
  const final = await reply(cap, true, 'done');
  assert.equal(final.status, 200); assert.equal((await final.json()).messages_remaining, 0);
  assert.equal(sends, cap);
  const status = await (await request(base, `/jobs/${job.id}`, undefined, { method: 'GET' })).json();
  assert.equal(status.messages_remaining, 0); assert.equal(status.reply_closed, true);
});

test('queue capacity, retention and corrupt-state handling are explicit', t => {
  const f = setup(t), store = new JobStore({ ...f.options, maxJobs: 1, retentionMs: 1000 });
  const job = store.enqueue(payload()).job;
  assert.throws(() => store.enqueue(payload('overflow')), /capacity/);
  f.advance(60 * 60000 + 1001);
  store.prune(); assert.equal(store.jobs.size, 0);
  assert.equal(fs.existsSync(path.join(store.dir, job.id + '.json')), false);
  const second = store.enqueue(payload('second')).job;
  const file = path.join(store.dir, second.id + '.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new JobStore(f.options));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('gateway checkpoints preserve sequence zero, reject another app and corrupt data, and do not advance on write failure', t => {
  const f = setup(t), session = new GatewaySession(f.options.dir, 'APP');
  session.commit('SESSION', 0);
  const restored = new GatewaySession(f.options.dir, 'APP');
  assert.equal(restored.sessionId, 'SESSION'); assert.equal(restored.seq, 0);
  assert.throws(() => new GatewaySession(f.options.dir, 'OTHER'), /does not match/);
  fs.unlinkSync(restored.file); fs.mkdirSync(restored.file);
  assert.throws(() => restored.commit('SESSION', 1));
  assert.equal(restored.seq, 0);
  fs.rmdirSync(restored.file);
  restored.commit(null, null);
  const cleared = new GatewaySession(f.options.dir, 'APP');
  assert.equal(cleared.sessionId, null); assert.equal(cleared.seq, null);
  fs.writeFileSync(restored.file, '{broken');
  assert.throws(() => new GatewaySession(f.options.dir, 'APP'));
  assert.equal(fs.readFileSync(restored.file, 'utf8'), '{broken');
});
