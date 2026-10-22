'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { GroupReception } = require('../group_reception');
const { fixture, waitFor, TOKEN } = require('./helpers/gateway');
const data = extra => ({ id: 'M', group_openid: 'G', author: { member_openid: 'MEMBER', bot: false }, content: 'hello', ...extra });
const state = mode => ({ member_openid: 'SELF_BOT', recv_msg_setting: mode });
const groupEvent = (id, s, extra = {}) => ({ op: 0, t: 'GROUP_MESSAGE_CREATE', s,
  d: data({ id, timestamp: new Date().toISOString(), ...extra }) });
const checkpoint = f => JSON.parse(fs.readFileSync(path.join(f.root, 'jobs/gateway-session.json'), 'utf8'));

test('group reception uses proven self mentions, not names, bot flags or textual mention lookalikes', async () => {
  const calls = [], reception = new GroupReception({ async req(...args) { calls.push(args); return state('all'); } });
  for (const extra of [
    {}, { content: '<@SELF_BOT> hello' }, { mentions: [{ member_openid: 'OTHER', username: 'same-name', bot: true }] },
    { mentions: [{ id: 'all' }] }, { mentions: [{ username: 'SELF_BOT', bot: true }] },
    { mentions: [{ member_openid: 'OTHER', id: 'SELF_BOT' }] },
  ]) assert.equal((await reception.payload('GROUP_MESSAGE_CREATE', data(extra))).at, false);
  for (const mention of [{ member_openid: 'SELF_BOT', bot: true }, { id: 'SELF_BOT' }]) {
    const p = await reception.payload('GROUP_MESSAGE_CREATE', data({ mentions: [mention] }));
    assert.equal(p.at, true); assert.equal(p.group_receive.trigger, 'self_mention');
    assert.equal(p.group_receive.setting, 'all'); assert.equal(p.group_receive.source, 'qq_bot_state');
  }
  const echo = await reception.payload('GROUP_MESSAGE_CREATE', data({ author: { member_openid: 'SELF_BOT' }, mentions: [{ id: 'SELF_BOT' }] }));
  assert.equal(echo.at, false); assert.equal(echo.group_receive.trigger, 'self_message');
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], ['GET', '/v2/groups/G/bot_state']);
  assert.equal(reception.payload('GROUP_MESSAGE_CREATE', data()).then, undefined, 'hot cache does not delay dispatch acknowledgments');
});

test('mode queries coalesce, expire, refresh on the first full event and obey a shared request interval', async () => {
  let now = 10000, mode = 'mention_and_context'; const starts = [];
  const reception = new GroupReception({ async req() { starts.push(now); return state(mode); } },
    { now: () => now, wait: async ms => { now += ms; }, ttlMs: 5000, minIntervalMs: 2100, maxGroups: 2 });
  const results = await Promise.all(Array.from({ length: 20 }, () => reception.get('G')));
  assert.equal(starts.length, 1); assert.ok(results.every(r => r.mode === 'mention_and_context'));
  mode = 'all';
  assert.equal((await reception.payload('GROUP_MESSAGE_CREATE', data())).group_receive.setting, 'all');
  assert.equal(starts.length, 2); assert.equal(starts[1] - starts[0], 2100);
  assert.equal(reception.summary().settings.all, 1);
  await reception.get('H'); await reception.get('I');
  assert.equal(reception.cache.size, 2); assert.ok(!reception.cache.has('G'));
  now += 6000; await reception.get('I'); assert.equal(starts.length, 5);
  reception.invalidate('I'); await reception.get('I'); assert.equal(starts.length, 6);
  assert.ok(starts.slice(1).every((n, i) => n - starts[i] >= 2100));
});

test('query failures disclose unavailable identity without leaking response bodies or blocking dedicated at events', async () => {
  let now = 0, failing = false, calls = 0; const logs = [];
  const reception = new GroupReception({ async req() {
    calls++; if (failing) throw Object.assign(new Error('private URL and credential'), { status: 403, body: { code: 11253, message: 'private' } });
    return state('all');
  } }, { now: () => now, ttlMs: 1000, retryMs: 2000, minIntervalMs: 0, log: (...args) => logs.push(args) });
  await reception.get('G'); now = 1001; failing = true;
  const unknown = await reception.payload('GROUP_MESSAGE_CREATE', data({ mentions: [{ id: 'SELF_BOT' }] }));
  assert.equal(unknown.at, false); assert.equal(unknown.group_receive.status, 'permission_denied');
  assert.equal(unknown.group_receive.self_identity_known, false);
  const dedicated = await reception.payload('GROUP_AT_MESSAGE_CREATE', data());
  assert.equal(dedicated.at, true); assert.equal(dedicated.group_receive.trigger, 'dedicated_at');
  assert.equal(calls, 2); assert.doesNotMatch(JSON.stringify(logs), /private|credential|URL/);
  now += 2001; await reception.get('G'); assert.equal(calls, 3);
});

test('all documented modes and group setting events remain distinct from inferred mode', async () => {
  for (const mode of ['all', 'only_mention', 'mention_and_context']) {
    let calls = 0;
    const reception = new GroupReception({ async req() { calls++; return state(mode); } }, { minIntervalMs: 0 });
    const p = await reception.payload('GROUP_AT_MESSAGE_CREATE', data());
    assert.equal(p.group_receive.setting, mode); assert.equal(p.at, true);
    assert.equal(reception.payload('GROUP_MSG_RECEIVE', { group_openid: 'G' }), null);
    await reception.payload('GROUP_AT_MESSAGE_CREATE', data()); assert.equal(calls, 2);
  }
  const invalid = new GroupReception({ async req() { return { recv_msg_setting: 'all', member_openid: '' }; } });
  assert.equal((await invalid.payload('GROUP_MESSAGE_CREATE', data())).group_receive.status, 'unavailable');
  const denied = new GroupReception({ async req() { return { code: 11253 }; } });
  assert.equal((await denied.payload('GROUP_MESSAGE_CREATE', data())).group_receive.status, 'permission_denied');
});

test('real full-only events store background with authors and wake Grok only for an explicit self mention', { timeout: 15000 }, async t => {
  const events = [
    groupEvent('PLAIN', 2), groupEvent('OTHER-BOT', 3, { author: { member_openid: 'OTHER_BOT', bot: true } }),
    groupEvent('AT-OTHER', 4, { mentions: [{ member_openid: 'OTHER_BOT', bot: true }] }),
    groupEvent('AT-ALL', 5, { mentions: [{ id: 'all' }] }),
    groupEvent('LOOKALIKE', 6, { content: '<@SELF_BOT> is just text' }),
    groupEvent('ECHO', 7, { author: { member_openid: 'SELF_BOT', bot: true } }),
    groupEvent('SELF-AT', 8, { mentions: [{ member_openid: 'SELF_BOT', bot: true }] }),
    { ...groupEvent('SELF-AT', 9), t: 'GROUP_AT_MESSAGE_CREATE' },
  ];
  const f = await fixture(t, { events, groupState(req, res) { res.end(JSON.stringify(state('all'))); } }), child = await f.start();
  await waitFor(() => f.deliveries.length === 1 && checkpoint(f).seq === 9, 'one unique self mention');
  const p = f.deliveries[0];
  assert.equal(p.msg_id, 'SELF-AT'); assert.equal(p.group_receive.trigger, 'self_mention');
  assert.equal(p.group_receive.setting, 'all'); assert.equal(f.stateQueries.length, 1);
  assert.equal(p.history.length, 5); assert.ok(p.history.every(e => e.attribution.speaker === 'other'));
  assert.ok(!p.history.some(e => e.msg_id === 'ECHO'));
  assert.equal(p.history.find(e => e.msg_id === 'OTHER-BOT').attribution.is_bot, true);
  const r = await fetch(child.url + '/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reply-Token': TOKEN },
    body: JSON.stringify({ type: p.type, group_openid: p.group_openid, job_id: p.job_id, msg_id: p.msg_id, content: 'answer' }) });
  assert.equal(r.status, 200); await r.json(); assert.equal(f.sends.length, 1);
});

test('mode lookup preserves heartbeat handling and replay after a crash before classification', { timeout: 15000 }, async t => {
  let release, hold = true;
  const gate = new Promise(resolve => release = resolve);
  const f = await fixture(t, { events: [groupEvent('SELF-AT', 2, { mentions: [{ id: 'SELF_BOT' }] })],
    async groupState(req, res) { if (hold) await gate; res.end(JSON.stringify(state('all'))); } });
  t.after(release);
  const first = await f.start();
  await waitFor(() => f.stateQueries.length === 1 && f.heartbeats.length >= 4, 'lookup with continued heartbeat ACKs');
  assert.equal(checkpoint(f).seq, 1); assert.equal(f.deliveries.length, 0);
  assert.ok(f.heartbeats.every(s => s === null || s <= 1));
  await f.stop(first, 'SIGKILL'); hold = false; release();
  await f.start(); await waitFor(() => f.deliveries.length === 1, 'replayed full-mode self mention');
  assert.equal(f.resumes[0].seq, 1); assert.equal(f.deliveries[0].msg_id, 'SELF-AT'); assert.equal(checkpoint(f).seq, 2);
});

test('real permission denial keeps dedicated at replies working and never forwards ambiguous full events', { timeout: 10000 }, async t => {
  const events = [groupEvent('AMBIGUOUS', 2, { mentions: [{ id: 'SELF_BOT' }] }),
    { ...groupEvent('DEDICATED', 3), t: 'GROUP_AT_MESSAGE_CREATE' }];
  const f = await fixture(t, { events, groupState(req, res) {
    res.writeHead(403); res.end(JSON.stringify({ code: 11253, message: 'private upstream diagnostic' }));
  } }), child = await f.start();
  await waitFor(() => f.deliveries.length === 1 && checkpoint(f).seq === 3, 'dedicated at survives a denied query');
  assert.equal(f.deliveries[0].msg_id, 'DEDICATED');
  assert.equal(f.deliveries[0].group_receive.status, 'permission_denied');
  assert.equal(f.stateQueries.length, 1);
  const health = await f.health(child);
  assert.equal(health.group_reception.settings.unavailable, 1); assert.equal(health.ok, true);
  assert.doesNotMatch(child.output + JSON.stringify(f.deliveries), /private upstream diagnostic/);
});

test('a cold-lookup backlog reconnects with forward progress and does not wake Grok for ordinary messages', { timeout: 40000 }, async t => {
  let release; const gate = new Promise(resolve => release = resolve);
  const events = Array.from({ length: 270 }, (_, i) => groupEvent('BACKGROUND-' + i, i + 2));
  events.push(groupEvent('SELF-AT', 272, { mentions: [{ id: 'SELF_BOT' }] }));
  const f = await fixture(t, { events, async groupState(req, res) { await gate; res.end(JSON.stringify(state('all'))); } });
  t.after(release);
  const child = await f.start();
  await waitFor(() => child.output.includes('dispatch backlog full'), 'bounded ingress backlog');
  release();
  try { await waitFor(() => f.deliveries.length === 1 && checkpoint(f).seq === 272, 'replayed burst makes progress', 30000); }
  catch (error) { throw new Error(error.message + '\n' + child.output.slice(-4000), { cause: error }); }
  assert.equal(f.deliveries[0].msg_id, 'SELF-AT'); assert.equal(f.stateQueries.length, 1);
  assert.ok(f.resumes.length >= 1); assert.equal(f.sends.length, 0);
});

test('slow background disk writes leave health and network I/O responsive before a burst completes', { timeout: 15000 }, async t => {
  const events = Array.from({ length: 80 }, (_, i) => groupEvent('SLOW-' + i, i + 2));
  const f = await fixture(t, { events, groupState(req, res) { res.end(JSON.stringify(state('all'))); } });
  const preload = path.join(f.root, 'slow-background.cjs');
  fs.writeFileSync(preload, `
    const fs=require('node:fs'),append=fs.appendFileSync;
    fs.appendFileSync=function(file,...args){
      if(process.env.QQ_HISTORY_DIR&&String(file).startsWith(process.env.QQ_HISTORY_DIR))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
      return append.call(this,file,...args);
    };
  `);
  const child = await f.start({ preload });
  await waitFor(() => child.output.includes('recv group-nonat SLOW-8'), 'slow background processing');
  const response = await fetch(child.url + '/health', { signal: AbortSignal.timeout(5000) });
  assert.equal((await response.json()).ok, true);
  assert.ok(checkpoint(f).seq < 81, 'HTTP health responds while background frames still remain');
  await waitFor(() => checkpoint(f).seq === 81 && child.output.includes('recv group-nonat SLOW-79'), 'background completion');
  assert.equal(f.deliveries.length, 0); assert.equal(f.sends.length, 0);
});
