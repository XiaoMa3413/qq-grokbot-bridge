'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { KnowledgeStore, LIMITS } = require('../knowledge');
const { diagnose } = require('../scripts/doctor');
const { JobStore } = require('../jobs');
const { fixture: gatewayFixture, event, waitFor, TOKEN } = require('./helpers/gateway');
const source = { id: 'selected', label: 'Selected facts', version: '1' };
const imported = extra => ({ schema: 1, source, profile: 'private-role-body', facts: [{ id: 'style', content: 'private-fact-body' }], ...extra });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-knowledge-test-'));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('qq-knowledge-test-'))
      throw new Error('unexpected cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'knowledge');
  return { root, dir, store: new KnowledgeStore({ dir }) };
}
async function commit(store, input = imported(), options) {
  const plan = store.preview('c2c', 'U', input);
  return store.commit('c2c', 'U', plan, options);
}
function cli(dir, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '../scripts/knowledge.js'), ...args],
      { env: { ...process.env, QQ_KNOWLEDGE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}

test('preview is read-only; commit, replay, unchanged import and restart preserve provenance', async t => {
  const f = fixture(t), plan = f.store.preview('c2c', 'U', imported());
  assert.deepEqual(plan.changes.map(c => c.action), ['add', 'add']);
  assert.equal(fs.existsSync(f.dir), false);
  assert.deepEqual(await f.store.commit('c2c', 'U', plan), { ok: true, revision: 1, changed: true });
  const snapshot = new KnowledgeStore({ dir: f.dir }).snapshot('c2c', 'U');
  assert.equal(snapshot.read_only, true); assert.equal(snapshot.platform_sync, 'not_configured');
  assert.deepEqual(snapshot.facts[0].source, source); assert.equal(snapshot.profile.batch, plan.id);
  assert.match(snapshot.profile.version, /^[a-f0-9]{64}$/);
  assert.equal((await f.store.commit('c2c', 'U', plan)).replayed, true);
  const before = fs.readFileSync(f.store.file({ type: 'c2c', id: 'U' }), 'utf8');
  assert.equal((await commit(f.store)).changed, false);
  assert.equal(fs.readFileSync(f.store.file({ type: 'c2c', id: 'U' }), 'utf8'), before);
  assert.equal(f.store.check(), 1);
});

test('content and source conflicts require explicit replacement; provenance-only refresh is visible', async t => {
  const f = fixture(t); await commit(f.store);
  const plan = f.store.preview('c2c', 'U', imported({ profile: 'new-role', facts: [{ id: 'style', content: 'new-fact' }] }));
  assert.deepEqual(plan.changes.map(c => c.action), ['conflict', 'conflict']);
  assert.equal(plan.changes[1].before.content, 'private-fact-body');
  await assert.rejects(f.store.commit('c2c', 'U', plan), { code: 'EKNOWLEDGECONFLICT' });
  assert.equal(f.store.snapshot('c2c', 'U').revision, 1);
  await f.store.commit('c2c', 'U', plan, { replaceConflicts: true });
  const version = f.store.snapshot('c2c', 'U').profile.version;
  const refresh = f.store.preview('c2c', 'U', imported({ source: { ...source, version: '2' }, profile: 'new-role', facts: [] }));
  assert.equal(refresh.changes[0].action, 'update');
  await f.store.commit('c2c', 'U', refresh);
  assert.equal(f.store.snapshot('c2c', 'U').profile.version, version);
  const foreign = f.store.preview('c2c', 'U', imported({ source: { ...source, id: 'another' }, profile: 'new-role', facts: [] }));
  assert.equal(foreign.changes[0].action, 'conflict');
});

test('deletions leave no body in state; old imports cannot resurrect facts or profiles without explicit restore', async t => {
  const f = fixture(t); await commit(f.store);
  const oldPlan = f.store.preview('c2c', 'U', imported({ profile: 'older-plan' }));
  await commit(f.store, imported({ source: { ...source, version: '2' }, profile: null, facts: [], delete: ['style'] }));
  const state = f.store.read('c2c', 'U').state;
  assert.equal(state.profile, null); assert.deepEqual(state.facts, []);
  assert.equal(state.tombstones[0].id, 'style'); assert.equal(state.profileDeleted.source.id, source.id);
  const raw = fs.readFileSync(f.store.file(state.scope), 'utf8');
  assert.equal(raw.includes('private-role-body'), false); assert.equal(raw.includes('private-fact-body'), false);
  const staleImport = f.store.preview('c2c', 'U', imported());
  assert.ok(staleImport.changes.every(c => c.action === 'skip'));
  assert.equal((await f.store.commit('c2c', 'U', staleImport)).changed, false);
  await assert.rejects(f.store.commit('c2c', 'U', oldPlan, { replaceConflicts: true }), { code: 'EKNOWLEDGESTALE' });
  const restore = f.store.preview('c2c', 'U', imported({ restore: ['style'], restore_profile: true }));
  assert.ok(restore.changes.every(c => c.action === 'restore'));
  await f.store.commit('c2c', 'U', restore);
  assert.equal(f.store.snapshot('c2c', 'U').facts[0].content, 'private-fact-body');
});

test('scope binding isolates chats, groups and target IDs that would collide after sanitizing', async t => {
  const f = fixture(t), plan = f.store.preview('c2c', 'A/B', imported());
  await assert.rejects(f.store.commit('group', 'A/B', plan), { code: 'EKNOWLEDGEPLAN' });
  assert.equal(fs.existsSync(f.dir), false);
  await f.store.commit('c2c', 'A/B', plan);
  for (const [type, id] of [['c2c', 'A_B'], ['group', 'A/B'], ['c2c', 'OTHER']])
    assert.deepEqual(f.store.snapshot(type, id).facts, []);
});

test('stale or edited plans fail and concurrent processes cannot overwrite each other', async t => {
  const f = fixture(t), first = f.store.preview('c2c', 'U', imported());
  const second = f.store.preview('c2c', 'U', imported({ facts: [{ id: 'second', content: 'different' }] }));
  const edited = structuredClone(first); edited.changes[0].after.content = 'edited';
  await assert.rejects(f.store.commit('c2c', 'U', edited), { code: 'EKNOWLEDGEPLAN' });
  const file = path.join(f.root, 'plan.json'), secondFile = path.join(f.root, 'second-plan.json');
  fs.writeFileSync(file, JSON.stringify(first)); fs.writeFileSync(secondFile, JSON.stringify(second));
  const results = await Promise.all([cli(f.dir, ['commit', '--type', 'c2c', '--id', 'U', '--plan', file, '--json']),
    cli(f.dir, ['commit', '--type', 'c2c', '--id', 'U', '--plan', secondFile, '--json'])]);
  assert.equal(results.filter(r => r.code === 0).length, 1);
  for (const r of results) if (r.code !== 0) assert.ok(['EKNOWLEDGEBUSY', 'EKNOWLEDGESTALE'].includes(JSON.parse(r.stderr).code));
  assert.equal(f.store.snapshot('c2c', 'U').revision, 1);
  await assert.rejects(f.store.commit('c2c', 'U', results[0].code === 0 ? second : first), { code: 'EKNOWLEDGESTALE' });
});

test('failed atomic commit preserves previous state and releases the writer lock', async t => {
  const f = fixture(t); await commit(f.store);
  const file = f.store.file({ type: 'c2c', id: 'U' }), before = fs.readFileSync(file, 'utf8');
  const plan = f.store.preview('c2c', 'U', imported({ facts: [{ id: 'new', content: 'new' }] }));
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('full'), { code: 'ENOSPC' }); return rename(from, to); };
  try { await assert.rejects(f.store.commit('c2c', 'U', plan), { code: 'ENOSPC' }); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  await f.store.commit('c2c', 'U', plan);
  assert.equal(f.store.snapshot('c2c', 'U').revision, 2);
  assert.equal(fs.readdirSync(f.dir).some(n => n.endsWith('.tmp')), false);
  const uncertain = f.store.preview('c2c', 'U', imported({ facts: [{ id: 'another', content: 'another' }] }));
  fs.renameSync = (from, to) => { rename(from, to); if (to === file) throw Object.assign(new Error('lost confirmation'), { code: 'EIO' }); };
  try { await assert.rejects(f.store.commit('c2c', 'U', uncertain), { code: 'EIO' }); }
  finally { fs.renameSync = rename; }
  assert.equal((await f.store.commit('c2c', 'U', uncertain)).replayed, true);
  assert.equal(f.store.snapshot('c2c', 'U').revision, 3);
});

test('invalid input and capacity failures are caught in preview without touching storage', t => {
  const f = fixture(t);
  for (const value of [imported({ schema: 2 }), imported({ facts: [{ id: '../x', content: 'x' }] }),
    imported({ facts: [{ id: 'same', content: 'x' }, { id: 'same', content: 'y' }] }),
    imported({ delete: ['style'] }), imported({ restore: ['missing'] }), imported({ profile: '' }),
    imported({ profile: 'x'.repeat(LIMITS.profileChars + 1) }), imported({ route: 'another chat' })])
    assert.throws(() => f.store.preview('c2c', 'U', value), { code: 'EKNOWLEDGEINPUT' });
  assert.throws(() => f.store.preview('c2c', 'U', imported({ facts: Array.from({ length: 20 }, (_, i) => ({ id: 'F' + i, content: 'x'.repeat(2000) })) })), { code: 'EKNOWLEDGESIZE' });
  assert.equal(fs.existsSync(f.dir), false);
});

test('deletion-marker capacity fails without clearing older protections', async t => {
  const f = fixture(t);
  for (let batch = 0; batch < 5; batch++) await commit(f.store, { schema: 1, source,
    delete: Array.from({ length: 100 }, (_, i) => 'D' + (batch * 100 + i)) });
  assert.equal(f.store.read('c2c', 'U').state.tombstones.length, LIMITS.tombstones);
  assert.throws(() => f.store.preview('c2c', 'U', { schema: 1, source, delete: ['OVER'] }), { code: 'EKNOWLEDGESIZE' });
  assert.equal(f.store.read('c2c', 'U').state.tombstones.length, LIMITS.tombstones);
  assert.equal(f.store.preview('c2c', 'U', { schema: 1, source, facts: [{ id: 'D0', content: 'old' }] }).changes[0].action, 'skip');
});

test('CLI preview requires a new output file, preserves inputs, and commits only the reviewed scope', async t => {
  const f = fixture(t), input = path.join(f.root, 'selected.json'), output = path.join(f.root, 'plan.json');
  const raw = JSON.stringify(imported()); fs.writeFileSync(input, raw);
  const args = ['preview', '--type', 'c2c', '--id', 'U', '--file', input, '--out', output, '--json'];
  assert.equal((await cli(f.dir, args)).code, 0); assert.equal(fs.existsSync(f.dir), false);
  assert.equal((await cli(f.dir, args)).code, 1);
  assert.equal(fs.readFileSync(input, 'utf8'), raw);
  assert.equal((await cli(f.dir, ['commit', '--type', 'group', '--id', 'U', '--plan', output])).code, 1);
  assert.equal((await cli(f.dir, ['commit', '--type', 'c2c', '--id', 'U', '--plan', output])).code, 0);
  const shown = await cli(f.dir, ['show', '--type', 'c2c', '--id', 'U', '--json']);
  assert.equal(JSON.parse(shown.stdout).state.revision, 1);
  fs.writeFileSync(input, '{"secret":"never-print-invalid-json",');
  const invalid = await cli(f.dir, args);
  assert.equal(invalid.code, 1); assert.equal((invalid.stdout + invalid.stderr).includes('never-print-invalid-json'), false);
});

test('doctor reports corrupt knowledge read-only and preserves its body', async t => {
  const f = fixture(t); await commit(f.store);
  fs.writeFileSync(path.join(f.root, 'config.json'), '{}');
  const file = f.store.file({ type: 'c2c', id: 'U' }), before = fs.readFileSync(file, 'utf8');
  let report = await diagnose({ dir: f.root, env: { QQ_KNOWLEDGE_DIR: f.dir } });
  assert.equal(report.checks.find(c => c.id === 'knowledge_state').status, 'pass');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.writeFileSync(file, '{"secret":"do-not-echo-state",');
  report = await diagnose({ dir: f.root, env: { QQ_KNOWLEDGE_DIR: f.dir } });
  assert.equal(report.checks.find(c => c.id === 'knowledge_state').status, 'fail');
  assert.equal(JSON.stringify(report).includes('do-not-echo-state'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"secret":"do-not-echo-state",');
});

test('real tasks pin imports across restart; later tasks see updates and other chats stay isolated', { timeout: 20000 }, async t => {
  const f = await gatewayFixture(t, { events: [event('FIRST', 2), event('NEXT', 3), event('OTHER', 4, 'OTHER')] });
  const jobs = new JobStore({ dir: path.join(f.root, 'jobs') });
  const legacy = jobs.enqueue({ type: 'c2c', openid: 'LEGACY', msg_id: 'LEGACY' }).job;
  legacy.delivery = 'accepted'; jobs.save(legacy);
  const store = new KnowledgeStore({ dir: path.join(f.root, 'knowledge') }); await commit(store);
  let child = await f.start(); await waitFor(() => f.deliveries.length === 2, 'first scoped snapshots');
  const first = f.deliveries.find(p => p.msg_id === 'FIRST'), other = f.deliveries.find(p => p.msg_id === 'OTHER');
  assert.equal((await fetch(child.url + `/jobs/${legacy.id}/knowledge`, { headers: { 'X-Reply-Token': TOKEN } })).status, 404);
  assert.equal(first.knowledge.revision, 1); assert.equal(first.knowledge.profile.content, 'private-role-body');
  assert.deepEqual(other.knowledge.facts, []); assert.equal(other.knowledge.profile, null);
  await commit(store, imported({ profile: 'new-role', facts: [{ id: 'style', content: 'new-fact' }] }), { replaceConflicts: true });
  await f.stop(child); child = await f.start(); await waitFor(async () => (await f.health(child)).ok, 'restart');
  const endpoint = child.url + new URL(first.knowledge_url).pathname;
  assert.equal((await fetch(endpoint)).status, 401);
  const pinned = await (await fetch(endpoint, { headers: { 'X-Reply-Token': TOKEN } })).json();
  assert.equal(pinned.knowledge.revision, 1); assert.equal(pinned.knowledge.profile.version, first.knowledge.profile.version);
  assert.equal((await fetch(endpoint, { method: 'PUT', headers: { 'X-Reply-Token': TOKEN }, body: '{}' })).status, 405);
  const reply = await fetch(child.url + '/reply', { method: 'POST', headers: { 'X-Reply-Token': TOKEN },
    body: JSON.stringify({ type: 'c2c', openid: 'U', msg_id: 'FIRST', content: 'answer' }) });
  assert.equal(reply.status, 200); await reply.json();
  await waitFor(() => f.deliveries.some(p => p.msg_id === 'NEXT'), 'next version');
  const next = f.deliveries.find(p => p.msg_id === 'NEXT');
  assert.equal(next.knowledge.revision, 2); assert.equal(next.knowledge.profile.content, 'new-role');
  assert.equal(f.deliveries.filter(p => p.msg_id === 'FIRST').length, 1);
  await f.stop(child);
  const file = path.join(jobs.dir, first.job_id + '.json'), completed = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...completed, deadline: Date.now() - 1 }));
  child = await f.start(); await waitFor(async () => (await f.health(child)).ok, 'expired snapshot restart');
  assert.equal((await fetch(child.url + new URL(first.knowledge_url).pathname, { headers: { 'X-Reply-Token': TOKEN } })).status, 410);
});

test('corrupt imported data prevents startup without contacting QQ or printing its contents', { timeout: 20000 }, async t => {
  const f = await gatewayFixture(t), store = new KnowledgeStore({ dir: path.join(f.root, 'knowledge') });
  await commit(store);
  const file = store.file({ type: 'c2c', id: 'U' }), value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.profile.version = '0'.repeat(64); const raw = JSON.stringify(value); fs.writeFileSync(file, raw);
  const child = await f.start(); assert.equal(await child.closed, 78);
  assert.equal(f.connections, 0); assert.equal(child.output.includes('private-role-body'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});
