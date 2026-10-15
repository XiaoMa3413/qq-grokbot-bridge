'use strict';
const assert = require('assert'), http = require('http');
const { toPayload, TokenManager, QQApi } = require('../lib');
const { createReplyServer } = require('../reply_server');
(async () => {
  const c = toPayload('C2C_MESSAGE_CREATE', { id: 'm1', content: ' hi ', timestamp: 't', author: { user_openid: 'U' } });
  assert.deepStrictEqual([c.type, c.openid, c.content, c.msg_id], ['c2c', 'U', 'hi', 'm1']);
  const g = toPayload('GROUP_AT_MESSAGE_CREATE', { id: 'm2', content: 'yo', group_openid: 'G', author: { member_openid: 'M' } });
  assert.deepStrictEqual([g.type, g.group_openid, g.author.member_openid], ['group', 'G', 'M']);
  assert.strictEqual(toPayload('OTHER', {}), null);
  const calls = []; let tokCalls = 0;
  const mock = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
    if (req.url === '/token') { tokCalls++; return res.end(JSON.stringify({ access_token: 'TK', expires_in: '7200' })); }
    calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.end('{"id":"x"}'); }); }).listen(0);
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
  console.log('ALL TESTS PASSED'); srv.close(); mock.close();
})().catch(e => { console.error(e); process.exit(1); });
