'use strict';
const assert = require('assert'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const HDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-history-'));
process.env.QQ_HISTORY_DIR = HDIR;
const { toPayload, TokenManager, QQApi } = require('../lib');
const { createReplyServer } = require('../reply_server');
const { getHistory, append, historyKey, historyFile } = require('../history');
const fileLines = (type, id) => fs.readFileSync(historyFile(type, id), 'utf8').trim().split('\n').filter(Boolean);
(async () => {
  const c = toPayload('C2C_MESSAGE_CREATE', { id: 'm1', content: ' hi ', timestamp: 't', author: { user_openid: 'U' } });
  assert.deepStrictEqual([c.type, c.openid, c.content, c.msg_id], ['c2c', 'U', 'hi', 'm1']);
  const g = toPayload('GROUP_AT_MESSAGE_CREATE', { id: 'm2', content: 'yo', group_openid: 'G', author: { member_openid: 'M' } });
  assert.deepStrictEqual([g.type, g.group_openid, g.author.member_openid], ['group', 'G', 'M']);
  assert.strictEqual(g.group_card, null);
  const fullAuthor = { id: 'A1', username: 'alice', bot: false, union_openid: 'UO', union_user_account: 'UUA', user_openid: 'U', member_openid: 'M', member_role: 2 };
  const c2 = toPayload('C2C_MESSAGE_CREATE', { id: 'm3', content: 'x', timestamp: 't', author: fullAuthor });
  assert.deepStrictEqual(c2.author, fullAuthor);
  assert.notStrictEqual(c2.author, fullAuthor);
  assert.strictEqual(c2.nickname, 'alice');
  assert.strictEqual(c2.group_card, null);
  const c3 = toPayload('C2C_MESSAGE_CREATE', { id: 'm4', content: 'x', timestamp: 't', author: { user_openid: 'U2' } });
  assert.strictEqual(c3.nickname, null);
  assert.strictEqual(c3.group_card, null);
  const c4 = toPayload('C2C_MESSAGE_CREATE', { id: 'm5', content: 'x', timestamp: 't' });
  assert.deepStrictEqual(c4.author, {});
  assert.strictEqual(c4.nickname, null);
  const g2 = toPayload('GROUP_AT_MESSAGE_CREATE', { id: 'm6', content: 'x', group_openid: 'G', author: fullAuthor, member: { nick: 'Nick' } });
  assert.deepStrictEqual(g2.author, fullAuthor);
  assert.strictEqual(g2.nickname, 'alice');
  assert.strictEqual(g2.group_card, 'Nick');
  const g3 = toPayload('GROUP_AT_MESSAGE_CREATE', { id: 'm7', content: 'x', group_openid: 'G', author: { member_openid: 'M' } });
  assert.strictEqual(g3.nickname, null);
  assert.strictEqual(g3.group_card, null);
  assert.strictEqual(toPayload('OTHER', {}), null);
  // ---- history: keys, isolation, ordering
  assert.strictEqual(historyKey('c2c', 'U'), 'c2c-U');
  assert.strictEqual(historyKey('group', 'G'), 'group-G');
  assert.strictEqual(historyKey('c2c', 'U/../x y'), 'c2c-U____x_y');
  assert.strictEqual(path.dirname(historyFile('c2c', '../../etc/passwd')), HDIR);
  assert.deepStrictEqual(getHistory('c2c', 'U'), []);
  assert.deepStrictEqual(getHistory('group', 'G'), []);
  append('c2c', 'U', { role: 'user', nickname: 'alice', member_role: 2, openid: 'U', content: 'one', timestamp: 't1' });
  append('c2c', 'U', { role: 'bot', nickname: null, member_role: null, openid: null, content: 'two', timestamp: 't2' });
  append('c2c', 'U', { role: 'user', nickname: 'bob', member_role: null, openid: 'U', content: 'three', timestamp: 't3' });
  append('group', 'G', { role: 'user', nickname: 'carol', member_role: 'owner', openid: 'G1', content: 'g1', timestamp: 't4' });
  assert.deepStrictEqual(getHistory('c2c', 'U'), [
    { role: 'user', nickname: 'alice', member_role: 2, openid: 'U', content: 'one', timestamp: 't1' },
    { role: 'bot', nickname: null, member_role: null, openid: null, content: 'two', timestamp: 't2' },
    { role: 'user', nickname: 'bob', member_role: null, openid: 'U', content: 'three', timestamp: 't3' }]);
  assert.deepStrictEqual(getHistory('group', 'G').map(e => [e.role, e.content]), [['user', 'g1']]);
  // ---- history: the forwarded payload must exclude the current message
  const prior = getHistory('c2c', 'U');
  append('c2c', 'U', { role: 'user', nickname: 'bob', member_role: null, openid: 'U', content: 'current', timestamp: 't5' });
  assert.deepStrictEqual(prior.map(e => e.content), ['one', 'two', 'three']);
  assert.deepStrictEqual(getHistory('c2c', 'U').map(e => e.content), ['one', 'two', 'three', 'current']);
  // ---- history: content truncation at 2000 chars, broken lines skipped
  append('c2c', 'TC', { role: 'user', content: 'x'.repeat(2500), timestamp: 't' });
  assert.strictEqual(getHistory('c2c', 'TC')[0].content.length, 2000);
  fs.appendFileSync(historyFile('c2c', 'BR'), 'not json\n{"role":"user","content":"ok"}\n\n');
  assert.deepStrictEqual(getHistory('c2c', 'BR').map(e => e.content), ['ok']);
  // ---- history: keep the last 50 entries, rewrite past 60 lines
  for (let i = 0; i < 61; i++) append('group', 'TR', { role: 'user', content: 'x' + i, timestamp: 't' + i });
  assert.strictEqual(fileLines('group', 'TR').length, 50);
  assert.strictEqual(getHistory('group', 'TR').length, 50);
  assert.strictEqual(getHistory('group', 'TR')[0].content, 'x11');
  for (let i = 0; i < 70; i++) append('group', 'CAP', { role: 'user', content: 'm' + i, timestamp: 't' + i });
  const capped = getHistory('group', 'CAP');
  assert.strictEqual(capped.length, 50);
  assert.strictEqual(capped[0].content, 'm20');
  assert.strictEqual(capped[49].content, 'm69');
  assert.ok(fileLines('group', 'CAP').length <= 60);
  // ---- history: IO errors are non-fatal
  const hd = process.env.QQ_HISTORY_DIR;
  process.env.QQ_HISTORY_DIR = '/proc/qq-bridge-history-test';
  assert.strictEqual(append('c2c', 'U', { role: 'user', content: 'x' }), null);
  assert.deepStrictEqual(getHistory('c2c', 'U'), []);
  process.env.QQ_HISTORY_DIR = hd;
  fs.mkdirSync(historyFile('c2c', 'DIR'));
  assert.strictEqual(append('c2c', 'DIR', { role: 'user', content: 'x' }), null);
  assert.deepStrictEqual(getHistory('c2c', 'DIR'), []);
  assert.strictEqual(getHistory('c2c', 'U').length, 4);
  const calls = []; let tokCalls = 0;
  const mock = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
    if (req.url === '/token') { tokCalls++; return res.end(JSON.stringify({ access_token: 'TK', expires_in: '7200' })); }
    calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
    if (b.includes('BOOM')) { res.writeHead(500); return res.end('{"code":1,"message":"boom"}'); }
    res.end('{"id":"x"}'); }); }).listen(0);
  await new Promise(r => mock.on('listening', r)); const base = 'http://127.0.0.1:' + mock.address().port;
  const api = new QQApi({ apiBase: base }, new TokenManager({ tokenUrl: base + '/token' }, 'a', 's'));
  const srv = createReplyServer(api, 'T').listen(0); await new Promise(r => srv.on('listening', r));
  const post = (b, tok = 'T') => fetch(`http://127.0.0.1:${srv.address().port}/reply`, { method: 'POST', headers: { 'X-Reply-Token': tok }, body: JSON.stringify(b) });
  assert.strictEqual((await post({}, 'bad')).status, 401);
  assert.strictEqual((await post({ type: 'c2c' })).status, 400);
  assert.strictEqual((await post({ type: 'c2c', openid: 'U', msg_id: 'm1', content: 'a' })).status, 200);
  assert.strictEqual((await post({ type: 'c2c', openid: 'U', msg_id: 'm1', content: 'b' })).status, 200);
  assert.strictEqual((await post({ type: 'group', group_openid: 'G', msg_id: 'm2', content: 'c' })).status, 200);
  assert.deepStrictEqual(calls.map(x => [x.url, x.body.msg_seq]), [['/v2/users/U/messages', 1], ['/v2/users/U/messages', 2], ['/v2/groups/G/messages', 1]]);
  assert.strictEqual(calls[0].auth, 'QQBot TK'); assert.strictEqual(tokCalls, 1);
  // ---- history: bot replies are recorded per conversation
  assert.strictEqual((await post({ type: 'c2c', openid: 'BU', msg_id: 'b1', content: 'hello from bot' })).status, 200);
  const bh = getHistory('c2c', 'BU');
  assert.strictEqual(bh.length, 1);
  assert.deepStrictEqual([bh[0].role, bh[0].nickname, bh[0].member_role, bh[0].openid, bh[0].content], ['bot', null, null, null, 'hello from bot']);
  assert.ok(!Number.isNaN(Date.parse(bh[0].timestamp)));
  assert.strictEqual((await post({ type: 'group', group_openid: 'BG', msg_id: 'b2', content: 'group reply' })).status, 200);
  assert.deepStrictEqual(getHistory('group', 'BG').map(e => [e.role, e.content]), [['bot', 'group reply']]);
  assert.strictEqual((await post({ type: 'c2c', openid: 'BU', msg_id: 'b3', content: 'BOOM' })).status, 502);
  assert.strictEqual(getHistory('c2c', 'BU').length, 1);
  console.log('ALL TESTS PASSED'); srv.close(); mock.close(); fs.rmSync(HDIR, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
