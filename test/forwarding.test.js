'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { JobStore, ForwardWorker } = require('../jobs');
const { validateJob } = require('../job_state');
const { inspectJobs, scheduleRedrive, revisionOf } = require('../job_control');
const { transportOutcome, responseOutcome } = require('../forwarding');
const { acquireInstanceLock } = require('../instance_lock');
const { fixture: gatewayFixture, waitFor, event, TOKEN } = require('./helpers/gateway');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-forwarding-'));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('qq-forwarding-')) throw new Error('unsafe cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  });
  let now = Date.now();
  const options = { dir: path.join(root, 'jobs'), now: () => now }, store = new JobStore(options);
  const job = store.enqueue({ type: 'c2c', openid: 'PRIVATE_USER', msg_id: 'M', content: 'PRIVATE_CONTENT' }).job;
  return { root, options, store, job, advance: ms => now += ms,
    retry(extra = {}) { return { ...options, id: job.id, revision: revisionOf(store.get(job.id)),
      requestId: 'retry-request-0001', reason: 'remote execution checked', ...extra }; } };
}
test('only known connection failures retry; unknown, timeout, reset and mixed aggregate errors are uncertain', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
    assert.equal(transportOutcome(new TypeError('fetch failed', { cause: Object.assign(new Error(), { code }) })).outcome, 'retryable');
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'ABORT_ERR', undefined])
    assert.equal(transportOutcome(Object.assign(new Error('secret must not escape'), { code })).outcome, 'uncertain');
  assert.equal(transportOutcome(new AggregateError([{ code: 'ECONNREFUSED' }, { code: 'ENETUNREACH' }])).outcome, 'retryable');
  assert.equal(transportOutcome(new AggregateError([{ code: 'ECONNREFUSED' }, { code: 'ECONNRESET' }])).outcome, 'uncertain');
  const circular = {}; circular.cause = circular;
  assert.equal(transportOutcome(circular).outcome, 'uncertain');
  assert.equal(transportOutcome({ code: 'EFORWARDNOTSENT' }).code, 'not_sent');
  for (const status of [408, 500, 502, 503, 504]) assert.equal(responseOutcome({ status }).outcome, 'uncertain');
  assert.equal(responseOutcome({ status: 429 }).outcome, 'retryable');
  assert.equal(responseOutcome({ status: 401 }).outcome, 'failed');
  assert.equal(responseOutcome({ status: 302 }).outcome, 'failed');
  assert.equal(responseOutcome({ status: 202 }).outcome, 'accepted');
  assert.equal(responseOutcome({ ok: true }).outcome, 'uncertain');
});
test('lost webhook acknowledgment blocks automatic repeats and later same-conversation jobs, including after restart', async t => {
  const f = fixture(t), next = f.store.enqueue({ ...f.job.payload, msg_id: 'NEXT' }).job;
  const other = f.store.enqueue({ ...f.job.payload, openid: 'OTHER', msg_id: 'OTHER' }).job;
  const calls = [];
  await new ForwardWorker(f.store, { send: async (p, j) => {
    calls.push(j.id); if (j.id === f.job.id) throw new Error('PRIVATE_WEBHOOK'); return { status: 202 };
  } }).runOnce();
  assert.deepEqual(calls, [f.job.id, other.id]); assert.equal(next.attempts, 0);
  assert.equal(f.job.delivery, 'uncertain'); assert.equal(f.job.forward.code, 'transport_ambiguous');
  assert.equal(f.store.summary().forward_uncertain, 1); assert.equal(f.store.summary().uncertain, 1);
  const restored = new JobStore(f.options);
  await new ForwardWorker(restored, { send: async () => { throw new Error('must not send'); } }).runOnce();
  assert.equal(restored.get(next.id).attempts, 0);
  const output = JSON.stringify(inspectJobs(f.options));
  for (const secret of ['PRIVATE_USER', 'PRIVATE_CONTENT', 'PRIVATE_WEBHOOK']) assert.ok(!output.includes(secret));
});
test('preparation failures and connection refusal retry, while HTTP failures have distinct outcomes', async t => {
  const f = fixture(t); let preparations = 0, sends = 0;
  const worker = new ForwardWorker(f.store, { prepare: async p => { if (++preparations === 1) throw new Error(); return p; },
    send: async () => { if (++sends === 1) throw Object.assign(new Error(), { code: 'ECONNREFUSED' }); return { status: 503 }; } });
  await worker.runOnce(); assert.equal(sends, 0); assert.equal(f.job.forward.code, 'preparation_failed');
  f.advance(10000); await worker.runOnce(); assert.equal(f.job.forward.code, 'connection_failed');
  f.advance(10000); await worker.runOnce(); assert.equal(f.job.delivery, 'uncertain'); assert.equal(f.job.forward.httpStatus, 503);
  f.advance(10000); await worker.runOnce(); assert.equal(sends, 2);
});
test('interrupted preparation is safe to resume; sending and legacy dispatch recovery stay uncertain', t => {
  const f = fixture(t);
  for (const phase of ['preparing', 'sending', null]) {
    const record = { ...f.job, delivery: 'dispatching' };
    if (phase) record.forward = { phase, code: phase, startedAt: f.options.now() };
    f.store.save(record);
    const restored = new JobStore(f.options).get(record.id);
    assert.equal(restored.delivery, phase === 'preparing' ? 'pending' : 'uncertain');
    assert.equal(restored.forward.code, phase === 'preparing' ? 'preparation_failed' : 'interrupted');
  }
});
test('callback evidence wins over webhook errors, and a late callback can finish an uncertain forward', async t => {
  const f = fixture(t);
  await new ForwardWorker(f.store, { send: async () => {
    f.store.beginReply(f.job, 'reply'); f.store.finishReply(f.job, 200, { ok: true });
    return { status: 503 };
  } }).runOnce();
  assert.equal(f.job.delivery, 'accepted'); assert.equal(f.store.summary().completed, 1);
  const late = f.store.enqueue({ ...f.job.payload, msg_id: 'LATE' }).job;
  await new ForwardWorker(f.store, { send: async () => { throw new Error(); } }).runOnce();
  assert.equal(late.delivery, 'uncertain');
  assert.equal(f.store.beginReply(late, 'late'), null);
  f.store.finishReply(late, 200, { ok: true });
  assert.equal(late.delivery, 'accepted'); assert.equal(late.forward.code, 'callback_received');
});
test('failed send-intent writes never call the network and recover in the same worker', async t => {
  const f = fixture(t), save = f.store.save.bind(f.store); let fail = true, sends = 0;
  f.store.save = job => { if (job.forward?.phase === 'sending' && fail) { fail = false; throw new Error('disk'); } save(job); };
  const worker = new ForwardWorker(f.store, { send: async () => { sends++; return { status: 202 }; } });
  await assert.rejects(worker.runOnce(), /disk/); assert.equal(sends, 0);
  f.advance(10000); await worker.runOnce(); assert.equal(sends, 1); assert.equal(f.job.delivery, 'accepted');
});
test('failure to persist an acknowledgment leaves a conservative sending intent, never an automatic repeat', async t => {
  const f = fixture(t), save = f.store.save.bind(f.store); let sends = 0;
  f.store.save = job => { if (job.forward?.phase === 'settled') throw new Error('disk'); save(job); };
  const worker = new ForwardWorker(f.store, { send: async () => { sends++; return { status: 202 }; } });
  await assert.rejects(worker.runOnce(), /disk/); await worker.runOnce(); assert.equal(sends, 1);
  assert.equal(new JobStore(f.options).get(f.job.id).delivery, 'uncertain');
});
test('manual retry requires a reviewed revision and duplicate acknowledgment, and preserves the exact original task', async t => {
  const f = fixture(t);
  await new ForwardWorker(f.store, { prepare: async p => ({ ...p, knowledge: { revision: 1 }, history: ['snapshot'] }),
    send: async () => { throw new Error(); } }).runOnce();
  const original = structuredClone(f.job), request = f.retry();
  await assert.rejects(scheduleRedrive(request), { code: 'EJOBDUPLICATERISK' });
  await assert.rejects(scheduleRedrive({ ...request, revision: '0'.repeat(64), ackDuplicateRisk: true }), { code: 'EJOBSTALE' });
  const result = await scheduleRedrive({ ...request, ackDuplicateRisk: true });
  assert.equal(result.scheduled, true);
  const restored = new JobStore(f.options), scheduled = restored.get(f.job.id);
  for (const key of ['id', 'payload', 'deadline', 'order', 'attempts', 'assets', 'prepared']) assert.deepEqual(scheduled[key], original[key]);
  assert.equal(scheduled.delivery, 'pending'); assert.equal(scheduled.redrives.length, 1);
  assert.equal(scheduled.redrives[0].previousDelivery, 'uncertain');
  let sends = 0;
  await new ForwardWorker(restored, { prepare: async () => { throw new Error('must reuse snapshot'); }, send: async p => {
    assert.deepEqual(p, original.payload); sends++; return { status: 202 };
  } }).runOnce();
  assert.equal(sends, 1);
  const repeat = await scheduleRedrive({ ...request, ackDuplicateRisk: true });
  assert.equal(repeat.replayed, true); assert.equal(repeat.scheduled, false);
  assert.equal(new JobStore(f.options).get(f.job.id).delivery, 'accepted');
  await assert.rejects(scheduleRedrive({ ...request, ackDuplicateRisk: true, reason: 'changed' }), { code: 'EJOBREPLAY' });
});
test('manual retry rejects active queues, all reply states, accepted/pending jobs and expired windows', async t => {
  const f = fixture(t);
  f.job.delivery = 'failed'; f.store.save(f.job);
  const lock = await acquireInstanceLock(f.options.dir);
  try { await assert.rejects(scheduleRedrive(f.retry()), { code: 'EINSTANCELOCKED' }); }
  finally { await new Promise(resolve => lock.close(resolve)); }
  const failed = structuredClone(f.job);
  for (const delivery of ['pending', 'accepted', 'expired']) {
    Object.assign(f.job, failed, { delivery }); f.store.save(f.job);
    await assert.rejects(scheduleRedrive(f.retry()), { code: 'EJOBINELIGIBLE' });
  }
  for (const state of ['sending', 'uncertain', 'done']) {
    Object.assign(f.job, failed); delete f.job.replies; f.job.reply = null;
    f.store.beginReply(f.job, 'progress', { final: false });
    if (state === 'done') f.store.finishReply(f.job, 200, { ok: true });
    else { f.job.reply.state = state; f.store.save(f.job); }
    f.job.delivery = 'failed'; f.store.save(f.job);
    await assert.rejects(scheduleRedrive(f.retry()), { code: 'EJOBINELIGIBLE' });
  }
  const record = { ...failed, deadline: f.options.now() - 1 };
  f.store.save(record);
  await assert.rejects(scheduleRedrive(f.retry({ revision: revisionOf(validateJob(record, record.id + '.json')) })), { code: 'EJOBINELIGIBLE' });
});
test('concurrent manual retries schedule once and repeated commands do not schedule again', async t => {
  const f = fixture(t); f.job.delivery = 'failed'; f.store.save(f.job);
  const request = f.retry();
  const results = await Promise.allSettled([scheduleRedrive(request), scheduleRedrive(request)]);
  assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.scheduled).length, 1);
  assert.equal(new JobStore(f.options).get(f.job.id).redrives.length, 1);
  // The retry caller may not have received the successful acknowledgment.
  assert.equal((await scheduleRedrive(request)).replayed, true);
});
test('manual retry write failures before and after atomic rename preserve recovery and replay semantics', async t => {
  const f = fixture(t), originalRename = fs.renameSync;
  f.job.delivery = 'failed'; f.store.save(f.job);
  const request = f.retry(), file = path.join(f.options.dir, f.job.id + '.json'), before = fs.readFileSync(file, 'utf8');
  fs.renameSync = () => { throw Object.assign(new Error('disk unavailable'), { code: 'EIO' }); };
  try { await assert.rejects(scheduleRedrive(request), { code: 'EIO' }); }
  finally { fs.renameSync = originalRename; }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.renameSync = (...args) => { originalRename(...args); throw Object.assign(new Error('confirmation lost'), { code: 'EIO' }); };
  try { await assert.rejects(scheduleRedrive(request), { code: 'EIO' }); }
  finally { fs.renameSync = originalRename; }
  assert.equal(inspectJobs({ ...f.options, id: f.job.id }).redrive.count, 1);
  assert.equal((await scheduleRedrive(request)).replayed, true);
  assert.equal(inspectJobs({ ...f.options, id: f.job.id }).delivery, 'pending');
});
test('manual retry limit, deadline races and corrupt unrelated records do not modify the queue', async t => {
  const f = fixture(t); f.job.delivery = 'failed'; f.store.save(f.job);
  const request = f.retry(); let times = 0;
  await assert.rejects(scheduleRedrive({ ...request, now: () => ++times === 1 ? f.job.deadline - 1 : f.job.deadline }), { code: 'EJOBINELIGIBLE' });
  const file = path.join(f.options.dir, f.job.id + '.json');
  const before = fs.readFileSync(file, 'utf8');
  const second = f.store.enqueue({ ...f.job.payload, msg_id: 'BROKEN' }).job;
  const secondFile = path.join(f.options.dir, second.id + '.json'); fs.writeFileSync(secondFile, '{broken');
  await assert.rejects(scheduleRedrive(request), { code: 'EJOBSTATE' });
  assert.equal(fs.readFileSync(file, 'utf8'), before); assert.equal(fs.readFileSync(secondFile, 'utf8'), '{broken');
  f.store.save(second);
  f.job.redrives = Array.from({ length: 20 }, (_, i) => ({ requestId: 'old-request-' + String(i).padStart(5, '0'), revision: '0'.repeat(64),
    at: f.options.now(), reason: 'checked', previousDelivery: 'failed', ackDuplicateRisk: false })); f.store.save(f.job);
  assert.equal(inspectJobs({ ...f.options, id: f.job.id }).redrive.blocked_reason, 'retry_limit');
  await assert.rejects(scheduleRedrive(f.retry()), { code: 'EJOBRETRYLIMIT' });
});
test('Retry-After beyond the reply window expires without invalid timestamps or another send', async t => {
  const f = fixture(t); let sends = 0;
  const worker = new ForwardWorker(f.store, { send: async () => { sends++; return { status: 429, retryAfterMs: Infinity }; } });
  await worker.runOnce(); assert.equal(f.job.nextAttemptAt, f.job.deadline);
  const restored = new JobStore(f.options); assert.equal(restored.get(f.job.id).nextAttemptAt, f.job.deadline);
  f.advance(60 * 60000); await worker.runOnce(); assert.equal(sends, 1); assert.equal(f.job.delivery, 'expired');
});
test('CLI inspection is read-only and redacted; CLI retry only schedules and rejects unknown flags', t => {
  const f = fixture(t); f.job.delivery = 'failed'; f.store.save(f.job);
  const file = path.join(f.options.dir, f.job.id + '.json'), before = fs.readFileSync(file, 'utf8');
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, '../scripts/jobs.js'), ...args],
    { env: { ...process.env, QQ_JOBS_DIR: f.options.dir }, encoding: 'utf8' });
  const shown = cli('show', '--job', f.job.id, '--json'); assert.equal(shown.status, 0, shown.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.ok(!shown.stdout.includes('PRIVATE_'));
  const revision = JSON.parse(shown.stdout).job.revision;
  const retry = cli('retry', '--job', f.job.id, '--revision', revision, '--request-id', 'cli-request-00001', '--reason', 'checked');
  assert.equal(retry.status, 0, retry.stderr); assert.equal(JSON.parse(retry.stdout).scheduled, true);
  assert.equal(new JobStore(f.options).get(f.job.id).attempts, 0);
  assert.equal(cli('retry', '--force').status, 1);
});
test('new persistent metadata is validated, and malformed records are never rewritten', t => {
  const f = fixture(t);
  const record = { ...f.job, forward: { phase: 'settled', outcome: 'uncertain', code: 'transport_ambiguous', startedAt: 1, completedAt: 2 } };
  for (const [field, value] of [['phase', 'other'], ['outcome', 'other'], ['code', 'private text'], ['startedAt', NaN], ['completedAt', -1], ['httpStatus', 999]]) {
    const damaged = structuredClone(record); damaged.forward[field] = value;
    assert.throws(() => validateJob(damaged, damaged.id + '.json'), { code: 'EJOBSTATE' });
  }
  assert.throws(() => validateJob({ ...record, redrives: [{}] }, record.id + '.json'), { code: 'EJOBSTATE' });
});
test('real bridge holds a remotely accepted request with lost ack; offline retry resumes exactly the same job', { timeout: 20000 }, async t => {
  let count = 0;
  const f = await gatewayFixture(t, { events: [event('LOST_ACK', 2)], webhook(req, res) {
    if (++count === 1) return req.socket.destroy();
    res.end('{}');
  } });
  const child = await f.start();
  await waitFor(async () => (await f.health(child)).jobs?.forward_uncertain === 1, 'uncertain delivery');
  assert.equal(f.deliveries.length, 1);
  const first = f.deliveries[0], dir = path.join(f.root, 'jobs');
  const statusResponse = await fetch(child.url + '/jobs/' + first.job_id, { headers: { 'X-Reply-Token': TOKEN } });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.delivery, 'uncertain'); assert.equal(status.forward.code, 'transport_ambiguous');
  assert.ok(!JSON.stringify(status).includes('PRIVATE_'));
  await assert.rejects(scheduleRedrive({ dir, id: first.job_id, revision: inspectJobs({ dir, id: first.job_id }).revision,
    requestId: 'live-request-0001', reason: 'checked', ackDuplicateRisk: true }), { code: 'EINSTANCELOCKED' });
  await f.stop(child);
  const inspected = inspectJobs({ dir, id: first.job_id });
  await scheduleRedrive({ dir, id: first.job_id, revision: inspected.revision,
    requestId: 'real-request-0001', reason: 'remote execution inspected', ackDuplicateRisk: true });
  const restarted = await f.start();
  await waitFor(async () => (await f.health(restarted)).jobs?.awaiting_reply === 1, 'manual retry accepted');
  assert.equal(f.deliveries.length, 2); assert.deepEqual(f.deliveries[1], first);
  assert.equal(inspectJobs({ dir, id: first.job_id }).redrive.count, 1);
});
test('real HTTP callback after a lost webhook ack completes once and releases the next queued turn', { timeout: 20000 }, async t => {
  let calls = 0;
  const f = await gatewayFixture(t, { events: [event('FIRST', 2), event('SECOND', 3)], webhook(req, res) {
    if (++calls === 1) return req.socket.destroy();
    res.end('{}');
  } });
  const child = await f.start();
  await waitFor(async () => (await f.health(child)).jobs?.forward_uncertain === 1, 'uncertain webhook');
  const p = f.deliveries[0], body = JSON.stringify({ job_id: p.job_id, type: p.type, openid: p.openid, msg_id: p.msg_id, content: 'late result' });
  const reply = () => fetch(child.url + '/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reply-Token': TOKEN }, body });
  const completed = await reply(); assert.equal(completed.status, 200); assert.equal((await completed.json()).ok, true);
  assert.equal((await (await reply()).json()).replayed, true);
  await waitFor(() => f.deliveries.length === 2, 'next turn released');
  assert.equal(f.sends.length, 1); assert.equal(f.deliveries[1].msg_id, 'SECOND');
  const health = await f.health(child); assert.equal(health.jobs.completed, 1); assert.equal(health.jobs.forward_uncertain, 0);
});
