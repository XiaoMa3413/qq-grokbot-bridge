'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fixture, waitFor, event, TOKEN } = require('./helpers/gateway');
const { JobStore } = require('../jobs');
const { GatewaySession } = require('../gateway_session');
const { toPayload } = require('../lib');

function injectStorageFailure(f, kind) {
  const marker = path.join(f.root, 'disk-unavailable'); fs.writeFileSync(marker, '');
  const preload = path.join(f.root, 'storage-failure.cjs');
  fs.writeFileSync(preload, `
    const fs=require('node:fs'),path=require('node:path');const open=fs.openSync;
    const marker=${JSON.stringify(marker)},kind=${JSON.stringify(kind)};
    fs.openSync=function(file,...args){
      const name=path.basename(String(file)),inQueue=path.dirname(String(file))===process.env.QQ_JOBS_DIR;
      const task=/^[a-f0-9]{64}\\./.test(name);
      const checkpoint=name.startsWith('gateway-session.json.')&&fs.readdirSync(process.env.QQ_JOBS_DIR).some(n=>/^[a-f0-9]{64}\\.json$/.test(n));
      if(inQueue&&name.endsWith('.tmp')&&fs.existsSync(marker)&&(kind==='job'?task:checkpoint))
        throw Object.assign(new Error('simulated full disk'),{code:'ENOSPC'});
      return open.call(this,file,...args);
    };
  `);
  return { marker, preload };
}
function checkpoint(f) { return JSON.parse(fs.readFileSync(path.join(f.root, 'jobs', 'gateway-session.json'), 'utf8')); }
function jobs(f) { return fs.readdirSync(path.join(f.root, 'jobs')).filter(n => /^[a-f0-9]{64}\.json$/.test(n)); }

for (const kind of ['job', 'checkpoint']) test(`${kind} write failure stops acknowledgments, reports unhealthy, and recovers without duplicate delivery`, { timeout: 15000 }, async t => {
  const f = await fixture(t, { events: [event('first', 2), event('second', 3, 'OTHER')] });
  const fault = injectStorageFailure(f, kind), child = await f.start({ preload: fault.preload });
  await waitFor(() => child.output.includes('ingress persistence failed'), 'storage error');
  const unhealthy = await f.health(child);
  assert.equal(unhealthy.status, 503); assert.equal(unhealthy.reason, 'ingress-persistence-failed');
  assert.equal(checkpoint(f).seq, 1);
  assert.equal(jobs(f).length, kind === 'job' ? 0 : 1);
  assert.equal(f.deliveries.length, 0);
  assert.ok(f.heartbeats.every(seq => seq === null || seq <= 1));
  await waitFor(() => child.output.includes('ingress retry failed'), 'retained dispatch retry');
  assert.equal((await f.health(child)).status, 503); assert.equal(checkpoint(f).seq, 1);
  fs.unlinkSync(fault.marker);
  await waitFor(async () => f.deliveries.length === 2 && (await f.health(child)).ok, 'recovered dispatches');
  assert.equal(f.identifies, 1); assert.equal(f.resumes.length, 1); assert.equal(f.resumes[0].seq, 2);
  assert.deepEqual(f.deliveries.map(p => p.msg_id).sort(), ['first', 'second']);
  assert.equal(jobs(f).length, 2); assert.equal(checkpoint(f).seq, 3);
  assert.doesNotMatch(child.output, /unhandledRejection/);
});

test('crash after an inbound write failure resumes from the durable checkpoint and replays the missing events', { timeout: 15000 }, async t => {
  const f = await fixture(t, { events: [event('first', 2), event('second', 3, 'OTHER')] });
  const fault = injectStorageFailure(f, 'job'), first = await f.start({ preload: fault.preload });
  await waitFor(() => first.output.includes('ingress persistence failed'), 'failed first write');
  await f.stop(first, 'SIGKILL');
  assert.equal(checkpoint(f).seq, 1);
  const second = await f.start();
  await waitFor(async () => f.deliveries.length === 2 && (await f.health(second)).ok, 'resume after crash');
  assert.equal(f.identifies, 1); assert.equal(f.resumes[0].seq, 1);
  assert.deepEqual(f.deliveries.map(p => p.msg_id).sort(), ['first', 'second']);
  assert.equal(jobs(f).length, 2);
});

test('simultaneous startup gives exactly one process ownership of the queue', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const children = await Promise.all([f.start(), f.start()]);
  await waitFor(() => children.some(child => child.exitCode === 78), 'duplicate startup rejected');
  const owner = children.find(child => child.exitCode === null);
  assert.ok(owner);
  await waitFor(async () => (await f.health(owner)).ok, 'owner ready');
  assert.equal(f.connections, 1);
});

test('restored sessions stay unhealthy and do not forward queued work before RESUMED', { timeout: 10000 }, async t => {
  const f = await fixture(t, { holdResume: true }), dir = path.join(f.root, 'jobs');
  const store = new JobStore({ dir });
  store.enqueue(toPayload('C2C_MESSAGE_CREATE', event('waiting', 2).d));
  new GatewaySession(dir, 'MOCK').commit('TEST-SESSION', 1);
  const child = await f.start();
  await waitFor(() => f.resumes.length === 1 && f.heartbeats.length > 0, 'resume request and heartbeat');
  const health = await f.health(child);
  assert.equal(health.status, 503); assert.equal(health.reason, 'gateway-not-ready');
  assert.equal(f.deliveries.length, 0);
  f.releaseResume();
  await waitFor(async () => f.deliveries.length === 1 && (await f.health(child)).ok, 'authenticated resume');
});

test('a rejected persisted session is cleared before identifying a fresh connection', { timeout: 10000 }, async t => {
  const f = await fixture(t, { rejectResume: true, events: [event('fresh-session', 2)] });
  const dir = path.join(f.root, 'jobs'); new JobStore({ dir });
  new GatewaySession(dir, 'MOCK').commit('OLD-SESSION', 8);
  const child = await f.start();
  await waitFor(async () => f.deliveries.length === 1 && (await f.health(child)).ok, 'fresh identify after invalid session');
  assert.equal(f.resumes.length, 1); assert.equal(f.identifies, 1);
  assert.equal(checkpoint(f).session_id, 'TEST-SESSION'); assert.equal(checkpoint(f).seq, 2);
});

test('duplicate instances, including a directory alias and local mode, cannot mutate an active reply; crash releases the lock', { timeout: 15000 }, async t => {
  const f = await fixture(t, { events: [event('lock-test', 2)], holdSend: true });
  const owner = await f.start();
  await waitFor(() => f.deliveries.length === 1, 'initial delivery');
  const payload = f.deliveries[0];
  const reply = fetch(owner.url + '/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reply-Token': TOKEN },
    body: JSON.stringify({ job_id: payload.job_id, type: payload.type, openid: payload.openid, msg_id: payload.msg_id, content: 'reply' }) });
  await waitFor(() => f.sends.length === 1, 'QQ send in progress');
  const file = path.join(f.root, 'jobs', payload.job_id + '.json'), before = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(before).reply.state, 'sending');
  const alias = path.join(f.root, 'queue-alias');
  fs.symlinkSync(path.join(f.root, 'jobs'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const overrides of [{}, { QQ_JOBS_DIR: alias, QQ_REPLY_PUBLIC_URL: '' }]) {
    const duplicate = await f.start({ overrides });
    assert.equal(await duplicate.closed, 78); assert.match(duplicate.output, /queue directory is already in use/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  assert.equal(f.connections, 1); assert.equal((await f.health(owner)).jobs.replying, 1);
  f.release(); assert.equal((await (await reply).json()).ok, true);
  await f.stop(owner, 'SIGKILL');
  const replacement = await f.start();
  await waitFor(async () => (await f.health(replacement)).ok, 'lock release after crash');
  assert.equal(f.sends.length, 1); assert.equal((await f.health(replacement)).jobs.completed, 1);
});
