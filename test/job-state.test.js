'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { JobStore } = require('../jobs');
const { diagnose } = require('../scripts/doctor');
const { fixture: gatewayFixture } = require('./helpers/gateway');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-job-state-'));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('qq-job-state-'))
      throw new Error('unexpected cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const options = { dir: path.join(root, 'jobs') }, store = new JobStore(options);
  const job = store.enqueue({ type: 'c2c', openid: 'U', msg_id: 'M', content: 'not-for-diagnostic-output' }).job;
  const file = path.join(options.dir, job.id + '.json');
  return { root, options, store, job, file };
}

test('legacy replies normalize without inventing metadata or resending, including after another restart', t => {
  const f = fixture(t);
  for (const state of ['done', 'sending']) {
    const legacy = { ...f.job, extraMetadata: { preserved: true }, reply: { state, fingerprint: 'legacy',
      ...(state === 'done' ? { httpStatus: 200, body: { ok: true } } : {}) } };
    delete legacy.replies;
    const original = JSON.stringify(legacy); fs.writeFileSync(f.file, original);
    const restored = new JobStore(f.options), job = restored.get(f.job.id);
    assert.equal(job.reply.seq, 1); assert.equal(job.reply.final, true);
    assert.equal(job.reply.startedAt, undefined);
    assert.deepEqual(job.extraMetadata, { preserved: true });
    if (state === 'done') {
      assert.equal(fs.readFileSync(f.file, 'utf8'), original);
      assert.equal(restored.beginReply(job, 'legacy').body.replayed, true);
    } else {
      assert.equal(job.reply.state, 'uncertain');
      assert.equal(restored.beginReply(job, 'legacy').status, 409);
    }
    restored.save(job);
    const again = new JobStore(f.options);
    assert.equal(again.get(job.id).reply.state, state === 'sending' ? 'uncertain' : 'done');
  }
});

test('malformed task fields fail with field diagnostics and leave original files intact', t => {
  const f = fixture(t), pending = structuredClone(f.job);
  f.store.beginReply(f.job, 'reply'); f.store.finishReply(f.job, 200, { ok: true });
  const completed = structuredClone(f.job);
  const cases = [
    ['schema', j => j.schema = 2],
    ['payload', j => j.payload = null],
    ['payload.route', j => j.payload.type = 'unknown'],
    ['payload.route', j => j.payload.openid = ''],
    ['id', j => j.id = '0'.repeat(64)],
    ['order', j => j.order = 0],
    ['createdAt', j => delete j.createdAt],
    ['deadline', j => j.deadline = 'tomorrow'],
    ['deadline', j => j.deadline = null],
    ['deadline', j => j.deadline = Number.MAX_SAFE_INTEGER],
    ['nextAttemptAt', j => j.nextAttemptAt = -1],
    ['attempts', j => j.attempts = 0.5],
    ['acceptedAt', j => j.acceptedAt = 'invalid'],
    ['delivery', j => j.delivery = 'unknown'],
    ['prepared', j => j.prepared = 'true'],
    ['assets', j => j.assets = []],
    ['assets', j => j.assets = { ['a'.repeat(64)]: 12 }],
    ['lastError', j => j.lastError = {}],
    ['sentCount', j => j.sentCount = 5],
    ['replies', j => j.replies = {}],
    ['replies[0].seq', j => j.replies[0].seq = 2, completed],
    ['replies[0].final', j => j.replies[0].final = 'false', completed],
    ['replies[0].state', j => j.replies[0].state = 'unknown', completed],
    ['replies[0].fingerprint', j => j.replies[0].fingerprint = {}, completed],
    ['replies[0].startedAt', j => j.replies[0].startedAt = null, completed],
    ['replies[0].httpStatus', j => j.replies[0].httpStatus = 999, completed],
    ['replies[0].body', j => j.replies[0].body.ok = 'yes', completed],
    ['reply.mirror', j => j.reply.body = { ok: false }, completed],
    ['replies[0].closed', j => j.replies.push({ ...j.replies[0], seq: 2 }), completed],
  ];
  for (const [field, mutate, base = pending] of cases) {
    const job = JSON.parse(JSON.stringify(base)); mutate(job);
    const raw = JSON.stringify(job); fs.writeFileSync(f.file, raw);
    assert.throws(() => new JobStore(f.options), { code: 'EJOBSTATE', field }, field);
    assert.equal(fs.readFileSync(f.file, 'utf8'), raw, field);
  }
  fs.writeFileSync(f.file, '{"content":"not-for-diagnostic-output",');
  assert.throws(() => new JobStore(f.options), error => error.code === 'EJOBSTATE' && error.field === 'json'
    && !error.message.includes('not-for-diagnostic-output'));
});

test('the entire queue is validated before dispatch recovery or retention can modify files', t => {
  const f = fixture(t);
  f.store.enqueue({ type: 'c2c', openid: 'U', msg_id: 'SECOND' });
  const files = fs.readdirSync(f.options.dir).sort();
  const firstPath = path.join(f.options.dir, files[0]), lastPath = path.join(f.options.dir, files[1]);
  const first = JSON.parse(fs.readFileSync(firstPath, 'utf8'));
  first.delivery = 'dispatching'; const raw = JSON.stringify(first); fs.writeFileSync(firstPath, raw);
  const last = JSON.parse(fs.readFileSync(lastPath, 'utf8'));
  last.deadline = 'invalid'; fs.writeFileSync(lastPath, JSON.stringify(last));
  assert.throws(() => new JobStore(f.options), { code: 'EJOBSTATE', field: 'deadline' });
  assert.equal(fs.readFileSync(firstPath, 'utf8'), raw);
  last.deadline = first.deadline; last.order = first.order;
  fs.writeFileSync(lastPath, JSON.stringify(last));
  assert.throws(() => new JobStore(f.options), { code: 'EJOBSTATE', field: 'order.duplicate' });
  assert.equal(fs.readFileSync(firstPath, 'utf8'), raw);
});

test('doctor diagnoses corrupt jobs without leaking contents or rewriting legacy records', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'config.json'), '{}');
  const env = { QQ_REPLY_PUBLIC_URL: 'https://bridge.example/reply', QQ_JOBS_DIR: f.options.dir };
  const original = fs.readFileSync(f.file, 'utf8');
  const healthy = await diagnose({ dir: f.root, env });
  assert.equal(healthy.checks.find(c => c.id === 'job_state').status, 'pass');
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  const bad = { ...f.job, deadline: 'not-for-diagnostic-output' }, raw = JSON.stringify(bad);
  fs.writeFileSync(f.file, raw);
  const report = await diagnose({ dir: f.root, env });
  const check = report.checks.find(c => c.id === 'job_state');
  assert.equal(check.status, 'fail'); assert.match(check.message, /deadline/);
  assert.equal(JSON.stringify(report).includes('not-for-diagnostic-output'), false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), raw);
});

test('real bridge stops on corrupt tasks before connecting to QQ or modifying the queue', { timeout: 20000 }, async t => {
  const f = await gatewayFixture(t), store = new JobStore({ dir: path.join(f.root, 'jobs') });
  const job = store.enqueue({ type: 'c2c', openid: 'U', msg_id: 'CORRUPT', content: 'not-for-diagnostic-output' }).job;
  const file = path.join(store.dir, job.id + '.json'), raw = JSON.stringify({ ...job, deadline: 'invalid' });
  fs.writeFileSync(file, raw);
  const child = await f.start();
  assert.equal(await child.closed, 78);
  assert.equal(f.connections, 0); assert.equal(f.deliveries.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  assert.match(child.output, /invalid persisted job.*deadline/);
  assert.equal(child.output.includes('not-for-diagnostic-output'), false);
});
