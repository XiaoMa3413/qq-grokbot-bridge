'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { assembleContext, speakerId } = require('../context');
const { append, readAll, normalizeEntry, mergeRecent } = require('../history');
const { loadConfig } = require('../configuration');
const { parseElements } = require('../events');
const { fixture, waitFor, event, TOKEN } = require('./helpers/gateway');
const user = (id, content, openid = 'U') => ({ role: 'user', msg_id: id, content, openid, nickname: 'same-name' });
const bot = (id, content, openid = 'U') => ({ role: 'bot', reply_to_msg_id: id, reply_to_openid: openid, content });
const message = extra => ({ type: 'c2c', openid: 'U', msg_id: 'CURRENT', content: 'follow up', quoted: [], recent_context: [], ...extra });

test('context keeps complete linked turns and chronological order while excluding progress and the current message', () => {
  const stored = [user('OLD', 'old'), bot('OLD', 'old answer'), user('LATEST', 'latest'),
    { ...bot('LATEST', 'working'), reply_kind: 'progress' }, bot('LATEST', 'latest answer'), user('CURRENT', 'follow up')];
  const before = structuredClone(stored), result = assembleContext(message(), stored, { maxEntries: 3 });
  assert.deepEqual(result.history.map(e => e.content), ['latest', 'latest answer']);
  assert.equal(result.context.history.omitted_entries, 2);
  assert.equal(result.context.speaker.id, 'U'); assert.equal(result.context.memory.platform_sync, 'not_configured');
  assert.deepEqual(stored, before);
});

test('text budget bounds quotes/history/recent together and marks truncation without splitting emoji', () => {
  const p = message({ content: 'CURRENT TEXT IS NOT TRUNCATED', quoted: [{ content: 'q'.repeat(30) }], recent_context: [{ content: 'r'.repeat(40) }] });
  const result = assembleContext(p, [user('Q', '😀'.repeat(30)), bot('Q', 'a'.repeat(60))], { maxChars: 31 });
  const texts = [...result.quoted, ...result.history, ...result.recent_context].map(e => e.content);
  assert.ok(texts.reduce((n, text) => n + text.length, 0) <= 31);
  assert.equal(result.history.length, 2); assert.ok(result.history.every(e => e.content_truncated));
  assert.ok(texts.every(text => !/[\uD800-\uDBFF]$/.test(text)));
  assert.equal(p.content, 'CURRENT TEXT IS NOT TRUNCATED'); assert.equal(p.quoted[0].content.length, 30);
  assert.ok(result.context.budget.used_chars <= result.context.budget.max_chars);
  const zero = assembleContext(message(), [user('Q', 'x')], { maxChars: 0 });
  assert.equal(zero.history.length, 0); assert.equal(zero.context.budget.used_chars, 0);
});

test('group relevance uses stable IDs, keeps explicitly quoted turns first and never equates identical nicknames', () => {
  const p = message({ type: 'group', group_openid: 'G', openid: undefined, author: { member_openid: 'A' }, nickname: 'renamed' });
  const stored = [user('A1', 'A question', 'A'), bot('A1', 'A answer', 'A'), user('B1', 'B question', 'B'), bot('B1', 'B answer', 'B')];
  const direct = assembleContext(p, stored, { maxEntries: 2 });
  assert.deepEqual(direct.history.map(e => e.content), ['A question', 'A answer']);
  assert.equal(direct.context.speaker.id, 'A');
  const quoted = assembleContext({ ...p, quoted: [{ msg_id: 'B1', content: 'B question' }] }, stored, { maxEntries: 2 });
  assert.deepEqual(quoted.history.map(e => e.content), ['B question', 'B answer']);
  const unknown = assembleContext({ ...p, author: {}, nickname: 'same-name' }, stored, { maxEntries: 2 });
  assert.equal(unknown.context.speaker.id, null);
  assert.deepEqual(unknown.history.map(e => e.content), ['B question', 'B answer']);
  assert.equal(speakerId({ ...p, author: { id: 'not-an-openid' } }), null);
});

test('orphaned or mismatched explicit replies are omitted while legacy unknown associations are disclosed', () => {
  const stored = [bot('MISSING', 'orphan'), user('Q', 'question'), bot('Q', 'wrong user', 'OTHER'), { role: 'bot', content: 'legacy' }];
  const result = assembleContext(message(), stored);
  assert.deepEqual(result.history.map(e => e.content), ['question', 'legacy']);
  assert.equal(result.context.history.orphaned_entries, 2); assert.equal(result.context.history.unlinked_bot_entries, 1);
  assert.equal(assembleContext(message(), [], { historyAvailable: false }).context.history.available, false);
});

test('recent context is deduplicated against selected history without dropping attachment evidence', () => {
  const imported = { role: 'user', nickname: 'same-name', openid: null, source: 'qq_recent_context', content: 'same' };
  const result = assembleContext(message({ recent_context: [{ author: 'same-name', content: 'same' }, { content: 'same', attachments: [{ url: 'https://media.example/photo.png' }] }] }), [imported]);
  assert.equal(result.recent_context.length, 1); assert.equal(result.recent_context[0].attachments.length, 1);
  assert.equal(result.context.recent_context.deduplicated_entries, 1);
  const noTextRoom = assembleContext(message({ recent_context: [{ content: 'photo', attachments: [{ url: 'https://media.example/photo.png' }] }] }), [], { maxChars: 0 });
  assert.equal(noTextRoom.recent_context.length, 1); assert.equal(noTextRoom.recent_context[0].content, '');
  assert.equal(noTextRoom.recent_context[0].content_truncated, true);
  const differentUser = assembleContext(message({ recent_context: [{ author: 'same-name', openid: 'OTHER', content: 'same' }] }), [user('Q', 'same')]);
  assert.equal(differentUser.recent_context.length, 1); assert.equal(differentUser.context.recent_context.deduplicated_entries, 0);
});

test('quote parser only exposes supplied IDs, and does not promote temporary reference indices or names to identity', () => {
  const { quoted } = parseElements({ msg_elements: [
    { msg_id: 'REAL', content: 'one', author: { username: 'name', member_openid: 'M' } },
    { msg_id: 'TMP_context-pointer', content: 'two', author: { username: 'name', id: 'display-id' } },
  ] });
  assert.equal(quoted[0].msg_id, 'REAL'); assert.equal(quoted[0].openid, 'M');
  assert.equal(quoted[1].msg_id, undefined); assert.equal(quoted[1].openid, undefined);
});

test('history pruning retains questions referenced by kept answers and reports original truncation', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-context-')), previous = process.env.QQ_HISTORY_DIR;
  process.env.QQ_HISTORY_DIR = dir;
  t.after(() => {
    previous === undefined ? delete process.env.QQ_HISTORY_DIR : process.env.QQ_HISTORY_DIR = previous;
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('qq-context-')) throw new Error('unexpected test path');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  append('group', 'G', user('Q', 'question'));
  for (let i = 0; i < 14; i++) append('group', 'G', user('OLD' + i, 'old ambient', 'OTHER'));
  append('group', 'G', bot('Q', 'answer'));
  for (let i = 0; i < 5; i++) append('group', 'G', user('NEW' + i, 'new ambient', 'OTHER'));
  const entries = readAll('group', 'G');
  assert.ok(entries.some(e => e.msg_id === 'Q')); assert.ok(entries.some(e => e.reply_to_msg_id === 'Q'));
  const result = assembleContext(message({ type: 'group', group_openid: 'G', author: { member_openid: 'U' } }), entries, { maxEntries: 2 });
  assert.deepEqual(result.history.map(e => e.content), ['question', 'answer']);
  const normalized = normalizeEntry({ role: 'bot', content: 'x'.repeat(2500), reply_to_msg_id: 'Q', reply_to_openid: 'U' });
  assert.equal(normalized.content.length, 2000); assert.equal(normalized.original_content_chars, 2500); assert.equal(normalized.content_truncated, true);
});

test('recent-context dedup prefers known IDs and only uses text fallback for user records', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-context-')), previous = process.env.QQ_HISTORY_DIR;
  process.env.QQ_HISTORY_DIR = dir;
  t.after(() => {
    previous === undefined ? delete process.env.QQ_HISTORY_DIR : process.env.QQ_HISTORY_DIR = previous;
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('qq-context-')) throw new Error('unexpected test path');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const timestamp = '2026-01-01T12:00:00.000Z';
  const cases = [
    { name: 'distinct-ids', stored: { msg_id: 'A' }, incoming: { msg_id: 'B' }, added: 1 },
    { name: 'same-id', stored: { msg_id: 'A' }, incoming: { msg_id: 'A', author: 'other', content: 'edited', timestamp: '2026-01-02T12:00:00.000Z' }, added: 0 },
    { name: 'incoming-id-missing', stored: { msg_id: 'A' }, incoming: {}, added: 0 },
    { name: 'stored-id-missing', stored: {}, incoming: { msg_id: 'B' }, added: 0 },
    { name: 'nickname-conflict', stored: {}, incoming: { author: 'other' }, added: 1 },
    { name: 'outside-window', stored: {}, incoming: { timestamp: '2026-01-02T12:00:00.000Z' }, added: 1 },
    { name: 'bot-is-not-user', stored: { role: 'bot' }, incoming: {}, added: 1 },
  ];
  for (const c of cases) {
    append('group', c.name, { role: 'user', nickname: 'same-name', content: '好', timestamp, ...c.stored });
    const incoming = { author: 'same-name', content: '好', timestamp, ...c.incoming };
    assert.equal(mergeRecent('group', c.name, [incoming]), c.added, c.name);
    const stored = readAll('group', c.name);
    assert.equal(stored.length, 1 + c.added, c.name);
    if (c.added) assert.equal(stored[1].msg_id, incoming.msg_id, c.name);
    assert.equal(mergeRecent('group', c.name, [incoming]), 0, c.name + ' replay');
  }
});

test('context budget defaults on older configuration and rejects invalid operator values', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-context-config-'));
  t.after(() => {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('qq-context-config-')) throw new Error('unexpected test path');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'config.json'); fs.writeFileSync(file, '{}');
  assert.equal(loadConfig({ dir, env: {} }).contextTextMaxChars, 12000);
  for (const value of [0, -1, '12000', 65537, 300.5]) {
    fs.writeFileSync(file, JSON.stringify({ contextTextMaxChars: value }));
    assert.throws(() => loadConfig({ dir, env: {} }), { code: 'ECONTEXTBUDGET' });
  }
  fs.writeFileSync(file, JSON.stringify({ historyLimitGroup: 2.5 }));
  assert.throws(() => loadConfig({ dir, env: {} }), { code: 'ECONTEXTLIMIT' });
});

test('real bridge carries a linked conversation through restart and isolates another private chat', { timeout: 20000 }, async t => {
  const f = await fixture(t, { events: [event('FIRST', 2), event('NEXT', 3), event('OTHER', 4, 'OTHER')] });
  const first = await f.start(); await waitFor(() => f.deliveries.length === 2, 'first user and isolated user webhooks');
  const p = f.deliveries.find(e => e.msg_id === 'FIRST'), other = f.deliveries.find(e => e.msg_id === 'OTHER');
  assert.deepEqual(other.history, []); assert.equal(other.context.speaker.id, 'OTHER');
  assert.equal(p.bridge_version, require('../package.json').version); assert.equal(p.context.memory.source, 'bridge_conversation');
  const r = await fetch(first.url + '/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reply-Token': TOKEN },
    body: JSON.stringify({ type: p.type, openid: p.openid, msg_id: p.msg_id, job_id: p.job_id, content: 'first answer' }) });
  assert.equal(r.status, 200); await r.json();
  await waitFor(() => f.deliveries.length === 3, 'next conversation turn');
  const next = f.deliveries.find(e => e.msg_id === 'NEXT');
  assert.deepEqual(next.history.map(e => e.content), ['test', 'first answer']);
  assert.equal(next.history[1].reply_to_msg_id, 'FIRST'); assert.equal(next.history[1].reply_to_openid, 'U');
  assert.equal(next.context.history.unlinked_bot_entries, 0);
  const nextResponse = await fetch(first.url + '/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reply-Token': TOKEN },
    body: JSON.stringify({ type: next.type, openid: next.openid, msg_id: next.msg_id, job_id: next.job_id, content: 'second answer' }) });
  assert.equal(nextResponse.status, 200); await nextResponse.json();
  await f.stop(first); const restarted = await f.start();
  await waitFor(async () => (await f.health(restarted)).ok, 'gateway restart');
  f.dispatch(event('AFTER_RESTART', 5)); await waitFor(() => f.deliveries.length === 4, 'follow-up after restart');
  const after = f.deliveries.find(e => e.msg_id === 'AFTER_RESTART');
  assert.deepEqual(after.history.map(e => e.content), ['test', 'first answer', 'test', 'second answer']);
  assert.ok(after.history.every(e => !e.openid || e.openid === 'U')); assert.equal(f.sends.length, 2);
});
