'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { JobStore, ForwardWorker } = require('../jobs');
const { RemoteAccess } = require('../remote');
const { createReplyServer } = require('../reply_server');
const { QQApi } = require('../lib');
const { getHistory, historyFile, append } = require('../history');
const { fixture: gatewayFixture, waitFor, event, TOKEN: GATEWAY_TOKEN } = require('./helpers/gateway');
const TOKEN = 'segment-test-only-0123456789abcdef0123456789';
async function fixture(t, type = 'c2c') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-segments-'));
  const previous = process.env.QQ_HISTORY_DIR; process.env.QQ_HISTORY_DIR = path.join(dir, 'history');
  const options = { dir: path.join(dir, 'jobs') };
  let store = new JobStore(options);
  const route = { type, ...(type === 'group' ? { group_openid: 'G' } : { openid: 'U' }), msg_id: 'M', timestamp: new Date().toISOString(), content: 'question' };
  const job = store.enqueue(route).job; job.delivery = 'accepted'; store.save(job);
  const servers = [], calls = [];
  async function start(current = store, custom) {
    store = current;
    const api = custom || new QQApi({}, {});
    if (!custom) api.req = async (method, url, body) => { calls.push(body); return { id: 'sent-' + calls.length }; };
    const app = createReplyServer(api, TOKEN, null, { remote: true, store, access: new RemoteAccess(store, 'https://bridge.example/reply') });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); servers.push(app);
    const base = `http://127.0.0.1:${app.address().port}`;
    return {
      async post(body) { const r = await fetch(base + '/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reply-Token': TOKEN }, body: JSON.stringify({ ...route, job_id: job.id, ...body }) }); return { status: r.status, ...await r.json() }; },
      async status() { return (await fetch(base + '/jobs/' + job.id, { headers: { 'X-Reply-Token': TOKEN } })).json(); },
    };
  }
  t.after(async () => {
    await Promise.all(servers.map(app => new Promise(resolve => app.close(resolve))));
    previous === undefined ? delete process.env.QQ_HISTORY_DIR : process.env.QQ_HISTORY_DIR = previous;
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('qq-segments-')) throw new Error('unexpected test path');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, options, store, route, job, calls, start };
}

test('progress, restart, final and replay preserve QQ sequences, history and conversation ordering', async t => {
  const f = await fixture(t), first = await f.start();
  const progress = { reply_seq: 1, final: false, content: '好的，我这就给你找。' };
  assert.equal((await first.post(progress)).messages_remaining, 3);
  assert.equal(f.store.summary().awaiting_reply, 1); assert.equal(f.store.summary().completed, 0);
  assert.equal((await first.status()).reply, 'awaiting_final');
  f.store.enqueue({ ...f.route, msg_id: 'NEXT' });
  let forwarded = 0;
  const worker = new ForwardWorker(f.store, { send: async () => { forwarded++; return { ok: true }; } });
  await worker.runOnce(); assert.equal(forwarded, 0);
  assert.equal((await first.post(progress)).replayed, true);
  assert.equal((await first.post({ ...progress, content: 'changed' })).status, 409);
  assert.equal((await first.post({ reply_seq: 3, content: 'skip' })).status, 409);
  const restored = new JobStore(f.options), restarted = await f.start(restored);
  assert.equal((await restarted.post(progress)).replayed, true);
  const final = { reply_seq: 2, final: true, content: '找到这些新闻。' };
  assert.equal((await restarted.post(final)).status, 200);
  assert.equal((await restarted.post(progress)).replayed, true);
  assert.equal((await restarted.post(final)).replayed, true);
  assert.equal((await restarted.post({ reply_seq: 3, content: 'extra' })).status, 409);
  assert.deepEqual(f.calls.map(c => [c.content, c.msg_seq]), [[progress.content, 1], [final.content, 2]]);
  assert.deepEqual(getHistory('c2c', 'U').map(e => e.content), [final.content]);
  const raw = fs.readFileSync(historyFile('c2c', 'U'), 'utf8'); assert.match(raw, /"reply_kind":"progress"/);
  assert.equal(restored.summary().completed, 1);
  await new ForwardWorker(restored, { send: async () => { forwarded++; return { ok: true }; } }).runOnce();
  assert.equal(forwarded, 1);
  const state = await restarted.status(); assert.equal(state.reply_final, true); assert.equal(state.replies.length, 2); assert.equal(state.messages_used, 2);
});

test('progress reserves a final slot; final text and images share the remaining durable quota', async t => {
  const f = await fixture(t), app = await f.start();
  for (let seq = 1; seq <= 3; seq++) assert.equal((await app.post({ reply_seq: seq, final: false, content: 'progress ' + seq })).status, 200);
  assert.equal((await app.post({ reply_seq: 4, final: false, content: 'too many' })).status, 409);
  assert.equal(f.job.replies.length, 3);
  const result = await app.post({ reply_seq: 4, content: 'x'.repeat(1600), images_base64: [{ name: 'result.png', data: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64') }] });
  assert.equal(result.ok, true); assert.equal(result.parts_sent, 1); assert.equal(result.truncated, true); assert.equal(result.images_sent, 0);
  assert.equal(result.messages_remaining, 0); assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls.map(c => c.msg_seq), [1, 2, 3, 4]);
});

test('group segments retain five slots across restart, including a final image', async t => {
  const f = await fixture(t, 'group'), first = await f.start();
  for (let seq = 1; seq < 5; seq++) assert.equal((await first.post({ reply_seq: seq, final: false, content: 'progress ' + seq })).ok, true);
  const restored = new JobStore(f.options), api = new QQApi({}, {});
  api.uploadImage = async () => ({ file_info: 'IMAGE' });
  api.req = async (method, url, body) => { f.calls.push(body); return { id: 'image' }; };
  const app = await f.start(restored, api);
  const result = await app.post({ reply_seq: 5, images_base64: [{ name: 'result.png', data: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64') }], content: '' });
  assert.equal(result.images_sent, 1); assert.equal(result.messages_remaining, 0);
  assert.deepEqual(f.calls.map(c => c.msg_seq), [1, 2, 3, 4, 5]);
});

test('segment validation does not consume a reply; legacy callbacks remain final and replayable', async t => {
  const f = await fixture(t), app = await f.start();
  for (const body of [{ final: false }, { reply_seq: 0 }, { reply_seq: '1' }, { final: 'false' },
    { reply_seq: 1, final: false, content: 'x'.repeat(1501) }, { reply_seq: 1, final: false, images_base64: [] }]) {
    assert.equal((await app.post(body)).status, 400);
  }
  assert.equal(f.job.reply, null); assert.equal(f.calls.length, 0);
  assert.equal((await app.post({ content: 'legacy final' })).final, true);
  assert.equal((await app.post({ content: 'legacy final' })).replayed, true);
  assert.equal((await app.post({ content: 'different' })).status, 409);
});

test('concurrent segments and uncertain outcomes block subsequent sends', async t => {
  const f = await fixture(t); let release, entered;
  const gate = new Promise(r => release = r), started = new Promise(r => entered = r);
  const api = { seq: new Map(), send: async () => { entered(); await gate; return { id: 'sent' }; } };
  const app = await f.start(f.store, api), body = { reply_seq: 1, final: false, content: 'working' };
  const pending = app.post(body); await started;
  try {
    assert.equal((await app.post(body)).status, 409);
    assert.equal((await app.post({ reply_seq: 2, content: 'final' })).status, 409);
    const restored = new JobStore(f.options), restarted = await f.start(restored);
    assert.equal(restored.summary().uncertain, 1);
    assert.match((await restarted.post(body)).error, /unknown/);
    assert.equal((await restarted.post({ reply_seq: 2, content: 'final' })).status, 409);
    assert.equal(f.calls.length, 0);
  } finally { release(); await pending; }
});

test('failed segment is cached and closes the job; expiry allows cached progress but no new final', async t => {
  const f = await fixture(t), api = { seq: new Map(), send: async () => { throw new Error('QQ failed'); } };
  const failed = await f.start(f.store, api), body = { reply_seq: 1, final: false, content: 'working' };
  assert.equal((await failed.post(body)).status, 502);
  assert.equal((await failed.post(body)).replayed, true);
  assert.equal((await failed.post({ reply_seq: 2, content: 'final' })).status, 409);
  assert.equal(f.store.summary().failed, 1);
  const other = await fixture(t), app = await other.start();
  assert.equal((await app.post(body)).ok, true);
  other.store.now = () => other.job.deadline + 1;
  assert.equal((await app.post(body)).replayed, true);
  assert.equal((await app.post({ reply_seq: 2, content: 'final' })).status, 410);
  assert.equal(other.calls.length, 1);
});

test('failed intent persistence leaves memory retryable; failed completion blocks resending', async t => {
  const f = await fixture(t), app = await f.start(), save = f.store.save.bind(f.store);
  f.store.save = () => { throw new Error('disk full'); };
  const body = { reply_seq: 1, final: false, content: 'working' };
  assert.equal((await app.post(body)).status, 503); assert.equal(f.job.reply, null); assert.equal(f.calls.length, 0);
  f.store.save = job => { if (job.reply?.state === 'done') throw new Error('disk full'); save(job); };
  assert.equal((await app.post(body)).status, 503); assert.equal(f.calls.length, 1); assert.equal(f.job.reply.state, 'uncertain');
  assert.equal((await app.post(body)).status, 409);
  const restored = new JobStore(f.options); assert.equal(restored.get(f.job.id).reply.state, 'uncertain');
});

test('legacy persisted completed jobs remain final and progress does not displace substantive history', async t => {
  const f = await fixture(t);
  f.job.reply = { state: 'done', fingerprint: 'old', httpStatus: 200, body: { ok: true } }; f.store.save(f.job);
  const restored = new JobStore(f.options), record = restored.get(f.job.id);
  assert.equal(restored.beginReply(record, 'old').body.replayed, true);
  assert.equal(restored.beginReply(record, 'new', { seq: 2 }).status, 409);
  append('c2c', 'U', { role: 'user', content: 'important question' });
  for (let i = 0; i < 50; i++) append('c2c', 'U', { role: 'bot', content: 'working', reply_kind: 'progress' });
  assert.deepEqual(getHistory('c2c', 'U').map(e => e.content), ['important question']);
  assert.ok(fs.readFileSync(historyFile('c2c', 'U'), 'utf8').trim().split('\n').length <= 30);
});

test('real bridge resumes after progress and supplies the final answer to the next queued conversation turn', { timeout: 20000 }, async t => {
  const f = await gatewayFixture(t, { events: [event('SEGMENT_FIRST', 2), event('SEGMENT_NEXT', 3)] });
  const first = await f.start(); await waitFor(() => f.deliveries.length === 1, 'first webhook');
  const p = f.deliveries[0]; assert.equal(p.reply_policy.segmented, true);
  async function post(child, body) {
    const r = await fetch(child.url + '/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reply-Token': GATEWAY_TOKEN },
      body: JSON.stringify({ type: p.type, openid: p.openid, msg_id: p.msg_id, job_id: p.job_id, ...body }) });
    assert.equal(r.status, 200); return r.json();
  }
  await post(first, { reply_seq: 1, final: false, content: 'search in progress' });
  assert.equal((await f.health(first)).jobs.awaiting_reply, 1);
  await f.stop(first);
  const second = await f.start(); await waitFor(async () => (await f.health(second)).ok, 'restarted gateway');
  assert.equal((await post(second, { reply_seq: 1, final: false, content: 'search in progress' })).replayed, true);
  await post(second, { reply_seq: 2, final: true, content: 'news result' });
  await waitFor(() => f.deliveries.length === 2, 'next turn after final');
  assert.deepEqual(f.sends.map(body => [body.content, body.msg_seq]), [['search in progress', 1], ['news result', 2]]);
  const history = f.deliveries[1].history;
  assert.ok(history.some(entry => entry.content === 'news result'));
  assert.ok(!history.some(entry => entry.content === 'search in progress'));
});
