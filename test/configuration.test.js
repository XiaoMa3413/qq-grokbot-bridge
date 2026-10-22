'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { loadConfig } = require('../configuration');
const { createHistory } = require('../history');
const { assembleContext } = require('../context');
const { createReplyServer } = require('../reply_server');
const { fixture: gatewayFixture, event, waitFor, TOKEN } = require('./helpers/gateway');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-snapshot-'));
  t.after(() => {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('qq-config-snapshot-'))
      throw new Error('unexpected cleanup path');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('history and context share a validated startup snapshot until configuration is loaded again', t => {
  const dir = fixture(t), file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ historyLimitC2c: 2, historyLimitGroup: 1, contextTextMaxChars: 256 }));
  const cfg = loadConfig({ dir, env: {} });
  const history = createHistory({ dir: path.join(dir, 'history'), config: cfg });
  assert.ok(Object.isFrozen(cfg));
  fs.writeFileSync(file, '{broken');
  for (let i = 0; i < 16; i++) history.append('c2c', 'U', { role: 'user', msg_id: String(i), content: 'x'.repeat(200) });
  assert.equal(history.historyLimit('c2c'), 2); assert.equal(history.historyLimit('group'), 1);
  assert.deepEqual(history.getHistory('c2c', 'U').map(e => e.msg_id), ['14', '15']);
  assert.ok(history.readAll('c2c', 'U').length <= history.trimAt('c2c'));
  const assembled = assembleContext({ type: 'c2c', openid: 'U', msg_id: 'CURRENT' }, history.readAll('c2c', 'U'),
    { maxChars: cfg.contextTextMaxChars, maxEntries: history.historyLimit('c2c') });
  assert.equal(assembled.context.history.max_entries, 2); assert.equal(assembled.context.budget.max_chars, 256);
  assert.ok(assembled.context.budget.used_chars <= 256);
  assert.throws(() => loadConfig({ dir, env: {} }));
  fs.writeFileSync(file, JSON.stringify({ historyLimitC2c: 4 }));
  assert.equal(loadConfig({ dir, env: {} }).historyLimitC2c, 4);
  assert.equal(history.historyLimit('c2c'), 2);
  for (const invalid of ['null', '[]', '1']) {
    fs.writeFileSync(file, invalid);
    assert.throws(() => loadConfig({ dir, env: {} }), { code: 'ECONFIG' });
  }
});

test('history instances isolate storage and limits, and reject invalid limits before writing', t => {
  const dir = fixture(t), input = { historyLimitC2c: 1 };
  const one = createHistory({ dir: path.join(dir, 'one'), config: input });
  const two = createHistory({ dir: path.join(dir, 'two'), config: { historyLimitC2c: 3 } });
  input.historyLimitC2c = 99;
  for (const history of [one, two]) for (let i = 0; i < 4; i++) history.append('c2c', 'U', { role: 'user', content: String(i) });
  assert.deepEqual(one.getHistory('c2c', 'U').map(e => e.content), ['3']);
  assert.deepEqual(two.getHistory('c2c', 'U').map(e => e.content), ['1', '2', '3']);
  const invalidDir = path.join(dir, 'invalid');
  assert.throws(() => createHistory({ dir: invalidDir, config: { historyLimitGroup: '2' } }), { code: 'ECONTEXTLIMIT' });
  assert.equal(fs.existsSync(invalidDir), false);
});

test('reply handling records answers through the injected history instance', async t => {
  const dir = fixture(t), history = createHistory({ dir, config: { historyLimitC2c: 1 } });
  const api = { seq: new Map(), send: async () => ({ id: 'SENT' }) };
  const app = createReplyServer(api, 'test-token', null, { history });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const r = await fetch(`http://127.0.0.1:${app.address().port}/reply`, { method: 'POST',
    headers: { 'X-Reply-Token': 'test-token' }, body: JSON.stringify({ type: 'c2c', openid: 'U', content: 'answer' }) });
  assert.equal(r.status, 200); await r.json();
  assert.deepEqual(history.getHistory('c2c', 'U').map(e => e.content), ['answer']);
});

test('real bridge shares custom history limits across ingress, callbacks and config edits', { timeout: 20000 }, async t => {
  const f = await gatewayFixture(t, { events: [event('CUSTOM', 2)] });
  const configFile = path.join(f.root, 'config.json');
  const config = { ...JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8')),
    historyLimitC2c: 2, contextTextMaxChars: 256 };
  fs.writeFileSync(configFile, JSON.stringify(config));
  const preload = path.join(f.root, 'custom-config.cjs');
  fs.writeFileSync(preload, `const c = require(${JSON.stringify(path.join(__dirname, '../configuration'))});
    const load = c.loadConfig; c.loadConfig = () => load({ dir: ${JSON.stringify(f.root)} });`);
  const history = createHistory({ dir: path.join(f.root, 'history') });
  for (let i = 0; i < 20; i++) history.append('c2c', 'U', { role: 'user', openid: 'U', msg_id: 'OLD' + i, content: 'x'.repeat(200) });
  const child = await f.start({ preload });
  await waitFor(() => f.deliveries.length === 1, 'custom context');
  const p = f.deliveries[0];
  assert.equal(p.context.history.max_entries, 2); assert.equal(p.context.budget.max_chars, 256);
  assert.equal(p.history.length, 2); assert.ok(p.context.budget.used_chars <= 256);
  // Make trimming necessary during the callback, independently of ingress trimming.
  for (let i = 0; i < 15; i++) history.append('c2c', 'U', { role: 'user', msg_id: 'AMBIENT' + i, content: 'ambient' });
  const r = await fetch(child.url + '/reply', { method: 'POST', headers: { 'X-Reply-Token': TOKEN },
    body: JSON.stringify({ type: p.type, openid: p.openid, msg_id: p.msg_id, content: 'answer' }) });
  assert.equal(r.status, 200); await r.json();
  assert.ok(history.readAll('c2c', 'U').length <= 3);
  assert.ok(history.readAll('c2c', 'U').some(e => e.reply_to_msg_id === 'CUSTOM'));
  fs.writeFileSync(configFile, '{broken');
  f.dispatch(event('AFTER_EDIT', 3));
  await waitFor(() => f.deliveries.length === 2, 'unchanged startup snapshot');
  assert.equal(f.deliveries[1].context.history.max_entries, 2);
  assert.equal(f.deliveries[1].context.budget.max_chars, 256);
});
