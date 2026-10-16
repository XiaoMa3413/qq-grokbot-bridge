'use strict';
require('./events.test.js');
const assert = require('assert'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const HDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-history-'));
process.env.QQ_HISTORY_DIR = HDIR;
const MDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-'));
process.env.QQ_MEMORY_DIR = MDIR;
const MDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-media-'));
process.env.QQ_MEDIA_DIR = MDIA;
const { toPayload, TokenManager, QQApi } = require('../lib');
const { Watchdog } = require('../watchdog');
const { parseElements, refMsgIdx } = require('../events');
const { createReplyServer } = require('../reply_server');
const { checkLiveness, detectClockJump } = require('../liveness');
const { downloadImages } = require('../media');
const { getHistory, append, historyKey, historyFile, historyLimit, trimAt, mergeRecent } = require('../history');
const { memoryPath, memoryDir } = require('../memory');
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
  // ---- toPayload: GROUP_MESSAGE_CREATE (group message not @-mentioning the bot) -> group shape with at:false
  const nm = toPayload('GROUP_MESSAGE_CREATE', { id: 'm8', content: ' look ', group_openid: 'G', author: { member_openid: 'M' } });
  assert.deepStrictEqual([nm.type, nm.group_openid, nm.at, nm.msg_id, nm.content], ['group', 'G', false, 'm8', 'look']);
  assert.deepStrictEqual(nm.author, { member_openid: 'M' });
  assert.strictEqual(nm.nickname, null);
  assert.strictEqual(nm.group_card, null);
  // ---- toPayload: GROUP_AT carries at:true, C2C has no at field
  assert.strictEqual(g.at, true);
  assert.ok(!('at' in c));
  assert.ok(!('at' in c2));
  // ---- toPayload: every payload exposes message_type / ref_msg_idx / quoted
  const scene = { message_scene: { ext: ['msg_idx=XYZ', 'ref_msg_idx=RID'] } };
  const elements = { msg_elements: [
    { content: 'hi', message_type: 1 },
    { content: 'quoted', message_type: 102, author: { username: 'amy' } } ] };
  const expectedQuoted = [{ author: null, content: 'hi', attachments: [] }, { author: 'amy', content: 'quoted', attachments: [] }];
  const cp = toPayload('C2C_MESSAGE_CREATE', { id: 'm9', content: 'hi', timestamp: 't', message_type: 7, ...scene, ...elements, author: { user_openid: 'U' } });
  assert.strictEqual(cp.message_type, 7);
  assert.strictEqual(cp.ref_msg_idx, 'RID');
  assert.strictEqual(cp.ref_msg_idx, refMsgIdx({ ...scene, ...elements }));
  assert.deepStrictEqual(cp.quoted, expectedQuoted);
  assert.deepStrictEqual(cp.quoted, parseElements({ ...elements }).quoted);
  // ---- toPayload: message_type/ref_msg_idx/quoted default when absent; same shape on the group types
  const gp = toPayload('GROUP_AT_MESSAGE_CREATE', { id: 'm10', content: 'x', group_openid: 'G', ...scene, author: { member_openid: 'M' } });
  assert.strictEqual(gp.message_type, null);
  assert.strictEqual(gp.ref_msg_idx, 'RID');
  assert.deepStrictEqual(gp.quoted, []);
  const nmPlain = toPayload('GROUP_MESSAGE_CREATE', { id: 'm12', content: 'x', group_openid: 'G' });
  assert.deepStrictEqual([nmPlain.at, nmPlain.message_type, nmPlain.ref_msg_idx], [false, null, null]);
  assert.deepStrictEqual(nmPlain.quoted, []);
  const plain = toPayload('C2C_MESSAGE_CREATE', { id: 'm11', content: 'x', timestamp: 't', author: { user_openid: 'U' } });
  assert.deepStrictEqual([plain.message_type, plain.ref_msg_idx], [null, null]);
  assert.deepStrictEqual(plain.quoted, []);
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
  // ---- history: per-type limits from config.json (c2c 20 / trim 30, group 10 / trim 20)
  assert.deepStrictEqual([historyLimit('c2c'), historyLimit('group'), historyLimit('other'), trimAt('c2c'), trimAt('group')], [20, 10, 20, 30, 20]);
  // ---- history: group keeps the last 10 entries, rewrites past 20 lines
  for (let i = 0; i < 61; i++) append('group', 'TR', { role: 'user', content: 'x' + i, timestamp: 't' + i });
  assert.strictEqual(fileLines('group', 'TR').length, 17);
  assert.strictEqual(getHistory('group', 'TR').length, 10);
  assert.strictEqual(getHistory('group', 'TR')[0].content, 'x51');
  for (let i = 0; i < 70; i++) append('group', 'CAP', { role: 'user', content: 'm' + i, timestamp: 't' + i });
  const capped = getHistory('group', 'CAP');
  assert.strictEqual(capped.length, 10);
  assert.strictEqual(capped[0].content, 'm60');
  assert.strictEqual(capped[9].content, 'm69');
  assert.ok(fileLines('group', 'CAP').length <= 20);
  // ---- history: c2c uses the wider limit (keep 20, rewrite past 30)
  for (let i = 0; i < 35; i++) append('c2c', 'TCAP', { role: 'user', content: 'c' + i, timestamp: 't' + i });
  const tc = getHistory('c2c', 'TCAP');
  assert.strictEqual(fileLines('c2c', 'TCAP').length, 24);
  assert.strictEqual(tc.length, 20);
  assert.strictEqual(tc[0].content, 'c15');
  assert.strictEqual(tc[19].content, 'c34');
  // ---- history: getHistory caps the entries returned, whatever the file holds
  fs.appendFileSync(historyFile('c2c', 'RAW'), Array.from({ length: 25 }, (_, i) => JSON.stringify({ role: 'user', content: 'r' + i })).join('\n') + '\n');
  assert.deepStrictEqual(getHistory('c2c', 'RAW').map(e => e.content), Array.from({ length: 20 }, (_, i) => 'r' + (i + 5)));
  fs.appendFileSync(historyFile('group', 'RAWG'), Array.from({ length: 15 }, (_, i) => JSON.stringify({ role: 'user', content: 'g' + i })).join('\n') + '\n');
  assert.deepStrictEqual(getHistory('group', 'RAWG').map(e => e.content), Array.from({ length: 10 }, (_, i) => 'g' + (i + 5)));
  // ---- history: IO errors are non-fatal
  const hd = process.env.QQ_HISTORY_DIR;
  fs.writeFileSync(path.join(HDIR, 'notadir'), ''); process.env.QQ_HISTORY_DIR = path.join(HDIR, 'notadir', 'sub');
  assert.strictEqual(append('c2c', 'U', { role: 'user', content: 'x' }), null);
  assert.deepStrictEqual(getHistory('c2c', 'U'), []);
  process.env.QQ_HISTORY_DIR = hd;
  fs.mkdirSync(historyFile('c2c', 'DIR'));
  assert.strictEqual(append('c2c', 'DIR', { role: 'user', content: 'x' }), null);
  assert.deepStrictEqual(getHistory('c2c', 'DIR'), []);
  assert.strictEqual(getHistory('c2c', 'U').length, 4);
  // ---- recent_context: toPayload parses it for group events (empty for c2c); context is never a quote
  {
    const rcEl = { message_type: 103, content: '=== 消息 1 ===\n[消息内容] 你好\n\n=== 消息 2 ===\n[消息内容] 看来还没修好\n' };
    const rc = toPayload('GROUP_AT_MESSAGE_CREATE', { id: 'rc-1', group_openid: 'RCG', content: '看看', timestamp: 'trc', message_type: 103, author: { member_openid: 'MM' }, msg_elements: [rcEl] });
    assert.strictEqual(rc.type, 'group');
    assert.strictEqual(rc.message_type, 103);
    assert.strictEqual(rc.recent_context.length, 2);                    // two context blocks
    assert.deepStrictEqual(rc.recent_context.map(e => e.content), ['你好', '看来还没修好']);
    assert.ok(rc.recent_context.every(e => e.author === null));
    assert.deepStrictEqual(rc.quoted, []);                             // the "=== 消息 ===" blob is never a real quote
    // c2c and contextless group events carry an empty array
    assert.deepStrictEqual(toPayload('C2C_MESSAGE_CREATE', { id: 'rc-2', author: { user_openid: 'U' } }).recent_context, []);
    assert.deepStrictEqual(toPayload('GROUP_MESSAGE_CREATE', { id: 'rc-3', group_openid: 'RCG', author: { member_openid: 'MM' } }).recent_context, []);
  }
  // ---- mergeRecent: skips an entry already in history (same content, within window) and adds the other
  {
    const GID = 'MRC';
    const ctx = toPayload('GROUP_AT_MESSAGE_CREATE', {
      id: 'rc-m', group_openid: GID, content: 'x', message_type: 103, author: { member_openid: 'MM' },
      msg_elements: [{ message_type: 103, content: '=== 消息 1 ===\n[消息内容] 你好\n\n=== 消息 2 ===\n[消息内容] 看来还没修好\n' }] }).recent_context;
    // seed one matching block ("你好") with a fresh timestamp -> inside the default 10-minute window
    append('group', GID, { role: 'user', nickname: null, content: '你好', timestamp: new Date().toISOString() });
    assert.strictEqual(mergeRecent('group', GID, ctx), 1);             // only "看来还没修好" is new; the "你好" duplicate is skipped
    assert.deepStrictEqual(getHistory('group', GID).map(e => e.content), ['你好', '看来还没修好']);
    // idempotent: re-merging the same window adds nothing (both blocks are now present)
    assert.strictEqual(mergeRecent('group', GID, ctx), 0);
    assert.deepStrictEqual(getHistory('group', GID).map(e => e.content), ['你好', '看来还没修好']);
  }
  // ---- mergeRecent: windowMs gates the content match — an old copy is NOT treated as a duplicate
  {
    const GID = 'MRC_WIN';
    append('group', GID, { role: 'user', nickname: null, content: 'hello', timestamp: new Date(Date.now() - 3600000).toISOString() });
    assert.strictEqual(mergeRecent('group', GID, [{ index: 1, author: null, content: 'hello', attachments: [] }], 600000), 1);
    assert.deepStrictEqual(getHistory('group', GID).map(e => e.content), ['hello', 'hello']);
  }
  // ---- mergeRecent: dedup by msg_id when both carry one (content/author differ); normalizeEntry keeps msg_id
  {
    const GID = 'MRC_ID';
    const now = new Date().toISOString();
    append('group', GID, { role: 'user', nickname: 'zed', msg_id: 'ID_1', content: 'first', timestamp: now });
    assert.strictEqual(mergeRecent('group', GID, [{ author: 'other', content: 'different', msg_id: 'ID_1' }]), 0); // same msg_id -> skipped
    assert.strictEqual(mergeRecent('group', GID, [{ author: 'other', content: 'different', msg_id: 'ID_2' }]), 1); // new msg_id -> appended
    assert.deepStrictEqual(getHistory('group', GID).map(e => [e.content, e.msg_id]), [['first', 'ID_1'], ['different', 'ID_2']]);
  }
  // ---- mergeRecent: images become '[图片] <path>' lines; a null author matches a real author within window
  {
    const GID = 'MRC_IMG';
    append('group', GID, { role: 'user', nickname: 'alice', content: 'look\n[图片] ' + path.join(MDIA, 'p.bin'), timestamp: new Date().toISOString() });
    // entry content is identical (image line included) + null author matches alice + within window -> skipped
    assert.strictEqual(mergeRecent('group', GID, [{ author: null, content: 'look', attachments: [{ local_path: path.join(MDIA, 'p.bin') }] }]), 0);
    assert.deepStrictEqual(getHistory('group', GID).map(e => [e.nickname, e.content]), [['alice', 'look\n[图片] ' + path.join(MDIA, 'p.bin')]]);
  }
  // ---- memory: one markdown file per conversation, created empty on demand
  assert.strictEqual(memoryDir(), MDIR);
  assert.strictEqual(memoryPath('c2c', 'U'), path.join(MDIR, 'c2c-U.md'));
  assert.strictEqual(memoryPath('group', 'G'), path.join(MDIR, 'group-G.md'));
  assert.strictEqual(memoryPath('c2c', 'U/../x y'), path.join(MDIR, 'c2c-U____x_y.md'));
  assert.ok(fs.existsSync(path.join(MDIR, 'c2c-U.md')));
  assert.strictEqual(fs.readFileSync(path.join(MDIR, 'c2c-U.md'), 'utf8'), '');
  // ---- memory: an existing file is never truncated or rewritten
  fs.writeFileSync(path.join(MDIR, 'c2c-BU.md'), 'notes\n');
  assert.strictEqual(memoryPath('c2c', 'BU'), path.join(MDIR, 'c2c-BU.md'));
  assert.strictEqual(fs.readFileSync(path.join(MDIR, 'c2c-BU.md'), 'utf8'), 'notes\n');
  assert.deepStrictEqual(fs.readdirSync(MDIR).sort(), ['c2c-BU.md', 'c2c-U.md', 'c2c-U____x_y.md', 'group-G.md']);
  // ---- memory: QQ_MEMORY_DIR override, nested dirs created
  const MDIR2 = path.join(MDIR, 'nested', 'deeper');
  process.env.QQ_MEMORY_DIR = MDIR2;
  assert.strictEqual(memoryPath('c2c', 'N'), path.join(MDIR2, 'c2c-N.md'));
  assert.ok(fs.existsSync(path.join(MDIR2, 'c2c-N.md')));
  process.env.QQ_MEMORY_DIR = MDIR;
  // ---- memory: IO errors are non-fatal, the path is still returned
  fs.writeFileSync(path.join(MDIR, 'notadir'), '');
  process.env.QQ_MEMORY_DIR = path.join(MDIR, 'notadir', 'sub');
  assert.strictEqual(memoryPath('c2c', 'U'), path.join(MDIR, 'notadir', 'sub', 'c2c-U.md'));
  process.env.QQ_MEMORY_DIR = MDIR;
  const calls = []; let tokCalls = 0;
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), PNG = Buffer.from('PNGDATA');
  const GIF = Buffer.from('GIF89a'), WEBP = Buffer.from('WEBPDATA');
  const IMAGES = { '/i.jpg': ['image/jpeg', JPEG], '/i.png': ['image/png', PNG], '/i.gif': ['image/gif', GIF], '/i.webp': ['image/webp', WEBP], '/i.tiff': ['image/tiff', PNG] };
  const mock = http.createServer((req, res) => {
    if (req.url === '/token') { tokCalls++; return res.end(JSON.stringify({ access_token: 'TK', expires_in: '7200' })); }
    if (IMAGES[req.url]) { res.writeHead(200, { 'Content-Type': IMAGES[req.url][0] }); return res.end(IMAGES[req.url][1]); }
    if (req.url === '/i.404') { res.writeHead(404); return res.end('nope'); }
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
    calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
    if (b.includes('BOOM')) { res.writeHead(500); return res.end('{"code":1,"message":"boom"}'); }
    res.end(req.url.endsWith('/files') ? '{"file_info":"FI","ttl":3600}' : '{"id":"x"}'); }); }).listen(0);
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
  // ---- reply: short content goes out as a single message
  const TRUNC = '\n…（内容过长，已截断）';
  const n0 = calls.length;
  let r = await post({ type: 'c2c', openid: 'SHORT', msg_id: 's1', content: 'hi there' });
  assert.strictEqual(r.status, 200);
  let j0 = await r.json();
  assert.deepStrictEqual([j0.ok, j0.parts_sent, j0.parts_total, j0.truncated], [true, 1, 1, false]);
  assert.deepStrictEqual(j0.results, [{ id: 'x' }]);
  assert.deepStrictEqual(j0.result, j0.results[0]);
  assert.strictEqual(calls.length, n0 + 1);
  assert.strictEqual(calls[n0].url, '/v2/users/SHORT/messages');
  assert.deepStrictEqual([calls[n0].body.content, calls[n0].body.msg_seq, calls[n0].body.msg_id], ['hi there', 1, 's1']);
  assert.deepStrictEqual(getHistory('c2c', 'SHORT').map(e => [e.role, e.content]), [['bot', 'hi there']]);
  // ---- reply: long content splits on paragraph boundaries, one history entry
  const para = 'A'.repeat(1000) + '\n\n' + 'B'.repeat(501);
  r = await post({ type: 'c2c', openid: 'SP', msg_id: 'p1', content: para });
  assert.strictEqual(r.status, 200); j0 = await r.json();
  assert.strictEqual(para.length, 1503);
  assert.deepStrictEqual([j0.ok, j0.parts_sent, j0.parts_total, j0.truncated], [true, 2, 2, false]);
  assert.strictEqual(calls.length, n0 + 3);
  assert.deepStrictEqual([calls[n0 + 1].body.content, calls[n0 + 1].body.msg_seq], ['A'.repeat(1000) + '\n\n', 1]);
  assert.deepStrictEqual([calls[n0 + 2].body.content, calls[n0 + 2].body.msg_seq], ['B'.repeat(501), 2]);
  const sph = getHistory('c2c', 'SP');
  assert.strictEqual(sph.length, 1);
  assert.strictEqual(sph[0].role, 'bot');
  assert.strictEqual(sph[0].content, para);
  // ---- reply: line (\n) boundaries, then a hard cut
  const liney = ['L'.repeat(600), 'L'.repeat(600), 'L'.repeat(600), 'H'.repeat(2000)].join('\n');
  r = await post({ type: 'c2c', openid: 'SL', msg_id: 'l1', content: liney });
  assert.strictEqual(r.status, 200); j0 = await r.json();
  assert.deepStrictEqual([j0.parts_sent, j0.parts_total, j0.truncated], [4, 4, false]);
  assert.ok(j0.results.every(x => x.id === 'x'));
  assert.deepStrictEqual(calls.slice(-4).map(x => x.body.content),
    ['L'.repeat(600) + '\n' + 'L'.repeat(600) + '\n', 'L'.repeat(600) + '\n', 'H'.repeat(1500), 'H'.repeat(500)]);
  assert.strictEqual(getHistory('c2c', 'SL').length, 1);
  // ---- reply: c2c passive cap is 4 messages per msg_id, last one truncated
  const many = n => Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i).repeat(800)).join('\n\n');
  const long12 = many(12);
  const n1 = calls.length;
  r = await post({ type: 'c2c', openid: 'CCAP', msg_id: 'c1', content: long12 });
  assert.strictEqual(r.status, 200); j0 = await r.json();
  assert.deepStrictEqual([j0.ok, j0.parts_sent, j0.parts_total, j0.truncated], [true, 4, 12, true]);
  const cap1 = calls.slice(n1);
  assert.deepStrictEqual(cap1.map(x => x.body.msg_seq), [1, 2, 3, 4]);
  assert.ok(cap1.slice(0, 3).every(x => x.body.content.length <= 1500));
  assert.strictEqual(cap1[3].body.content, 'D'.repeat(800) + '\n\n' + TRUNC);
  assert.ok(cap1[3].body.content.startsWith('D') && cap1[3].body.content.length <= 1500);
  const cap1Sent = cap1.map(x => x.body.content).join('');
  assert.strictEqual(cap1Sent.length, 802 * 3 + 814);
  assert.deepStrictEqual(getHistory('c2c', 'CCAP').map(e => e.content), [cap1Sent.slice(0, 2000)]);
  // ---- reply: the cap counts messages already sent for this msg_id
  const n2 = calls.length;
  assert.strictEqual((await post({ type: 'c2c', openid: 'CCAP', msg_id: 'c1', content: 'short one' })).status, 200);
  assert.strictEqual(calls.length, n2);  // 4 already sent, nothing left
  assert.deepStrictEqual(await (await post({ type: 'c2c', openid: 'CCAP', msg_id: 'c1', content: 'again' })).json(),
    { ok: true, parts_sent: 0, parts_total: 1, truncated: true, result: null, results: [] });
  const n3 = calls.length;
  assert.strictEqual((await post({ type: 'c2c', openid: 'CAPX', msg_id: 'x1', content: 'one' })).status, 200);
  r = await post({ type: 'c2c', openid: 'CAPX', msg_id: 'x1', content: long12 });
  assert.strictEqual(r.status, 200); j0 = await r.json();
  assert.deepStrictEqual([j0.parts_sent, j0.parts_total, j0.truncated], [3, 12, true]);  // 1 already sent, 3 left
  assert.deepStrictEqual(calls.slice(n3 + 1).map(x => [x.body.content[0], x.body.msg_seq]), [['A', 2], ['B', 3], ['C', 4]]);
  assert.strictEqual(calls[n3 + 3].body.content, 'C'.repeat(800) + '\n\n' + TRUNC);
  assert.strictEqual((await post({ type: 'c2c', openid: 'CAPX', msg_id: 'x1', content: 'two' })).status, 200);
  assert.strictEqual(calls.length, n3 + 4);  // 4 messages is the c2c cap, nothing left
  const capxSent = calls.slice(n3 + 1, n3 + 4).map(x => x.body.content).join('');
  assert.deepStrictEqual(getHistory('c2c', 'CAPX').map(e => e.content), ['one', capxSent.slice(0, 2000)]);
  // ---- reply: group passive cap is 5 messages per msg_id
  const n4 = calls.length;
  r = await post({ type: 'group', group_openid: 'GCAP', msg_id: 'g1', content: long12 });
  assert.strictEqual(r.status, 200); j0 = await r.json();
  assert.deepStrictEqual([j0.parts_sent, j0.parts_total, j0.truncated], [5, 12, true]);
  assert.deepStrictEqual(calls.slice(n4).map(x => x.url), Array(5).fill('/v2/groups/GCAP/messages'));
  assert.deepStrictEqual(calls.slice(n4).map(x => x.body.msg_seq), [1, 2, 3, 4, 5]);
  assert.ok(calls[n4 + 4].body.content.endsWith('\n…（内容过长，已截断）'));
  // ---- reply: active (no msg_id) is capped at 5 chunks, no msg_id/msg_seq
  const n5 = calls.length;
  r = await post({ type: 'c2c', openid: 'ACT', content: long12 });
  assert.strictEqual(r.status, 200); j0 = await r.json();
  assert.deepStrictEqual([j0.parts_sent, j0.parts_total, j0.truncated], [5, 12, true]);
  const act = calls.slice(n5);
  assert.ok(act.every(x => x.body.msg_id === undefined && x.body.msg_seq === undefined));
  assert.ok(act[4].body.content.endsWith('\n…（内容过长，已截断）'));
  assert.strictEqual(getHistory('c2c', 'ACT').length, 1);
  // ---- reply: a later part failing stops the sequence, sent parts are recorded
  const n6 = calls.length;
  r = await post({ type: 'c2c', openid: 'FAIL', msg_id: 'f1', content: 'A'.repeat(1000) + '\n\n' + 'BOOM' + 'B'.repeat(600) });
  assert.strictEqual(r.status, 502); j0 = await r.json();
  assert.deepStrictEqual([j0.ok, j0.parts_sent, j0.parts_total, j0.truncated], [false, 1, 2, false]);
  assert.strictEqual(j0.error, 'QQ API 500');
  assert.ok(j0.detail);
  assert.strictEqual(calls.length, n6 + 2);  // the failing part also hit the API
  assert.ok(calls[n6 + 1].body.content.includes('BOOM'));
  assert.deepStrictEqual(getHistory('c2c', 'FAIL').map(e => e.content), ['A'.repeat(1000) + '\n\n']);
  // ---- media: image attachments download to QQ_MEDIA_DIR as <msg_id>-<i>.<ext>
  let p = { msg_id: 'img-1', attachments: [{ content_type: 'image/jpeg', url: base + '/i.jpg' }] };
  await downloadImages(p);
  assert.strictEqual(p.attachments[0].local_path, path.join(MDIA, 'img-1-0.jpg'));
  assert.ok(path.isAbsolute(p.attachments[0].local_path));
  assert.ok(fs.readFileSync(p.attachments[0].local_path).equals(JPEG));
  assert.deepStrictEqual(fs.readdirSync(MDIA), ['img-1-0.jpg']);
  // ---- media: protocol-relative urls get the https: prefix
  const libMod = require('../lib');
  const realFetch = libMod.fetch; let seenUrl = null;
  libMod.fetch = (u, o) => { seenUrl = String(u); return realFetch(base + '/i.png', o); };
  try {
    p = { msg_id: 'img2', attachments: [{ content_type: 'image/png', url: '//127.0.0.1:' + mock.address().port + '/i.png' }] };
    await downloadImages(p);
    assert.strictEqual(seenUrl, 'https://127.0.0.1:' + mock.address().port + '/i.png');
    assert.strictEqual(p.attachments[0].local_path, path.join(MDIA, 'img2-0.png'));
    assert.ok(fs.readFileSync(p.attachments[0].local_path).equals(PNG));
  } finally { libMod.fetch = realFetch; }
  // ---- media: extension follows content_type, unknown subtypes fall back to .bin
  p = { msg_id: 'img3', attachments: [
    { content_type: 'image/gif', url: base + '/i.gif' },
    { content_type: 'image/webp', url: base + '/i.webp' },
    { content_type: 'image/tiff', url: base + '/i.tiff' }] };
  await downloadImages(p);
  assert.deepStrictEqual(p.attachments.map(a => path.basename(a.local_path)), ['img3-0.gif', 'img3-1.webp', 'img3-2.bin']);
  assert.ok(fs.readFileSync(p.attachments[1].local_path).equals(WEBP));
  assert.ok(fs.readFileSync(p.attachments[2].local_path).equals(PNG));
  // ---- media: msg_id is sanitized into the file name
  p = { msg_id: 'X/Y Z', attachments: [{ content_type: 'image/jpeg', url: base + '/i.jpg' }] };
  await downloadImages(p);
  assert.strictEqual(p.attachments[0].local_path, path.join(MDIA, 'X_Y_Z-0.jpg'));
  // ---- media: non-images are skipped, missing url is a failure, failures are non-fatal
  p = { msg_id: 'img4', attachments: [
    { content_type: 'video/mp4', url: base + '/i.jpg' },
    { content_type: 'image/png' },
    { content_type: 'image/jpeg', url: base + '/i.404' },
    { content_type: 'image/jpeg', url: 'http://127.0.0.1:1/nope.jpg' }] };
  await downloadImages(p);
  assert.ok(!('local_path' in p.attachments[0]));
  assert.strictEqual(p.attachments[1].local_path, null);
  assert.strictEqual(p.attachments[2].local_path, null);
  assert.strictEqual(p.attachments[3].local_path, null);
  p = { msg_id: 'img5', attachments: [
    { content_type: 'image/jpeg', url: base + '/i.404' },
    { content_type: 'image/jpeg', url: base + '/i.jpg' }] };
  await downloadImages(p);
  assert.strictEqual(p.attachments[0].local_path, null);
  assert.strictEqual(p.attachments[1].local_path, path.join(MDIA, 'img5-1.jpg'));
  // ---- image replies
  {
    const IDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-img-'));
    const png = path.join(IDIR, 'a.png'); const pngBuf = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from('xyz')]); fs.writeFileSync(png, pngBuf);
    const jpg = path.join(IDIR, 'b.jpg'); fs.writeFileSync(jpg, Buffer.from([0xff,0xd8,0xff,0xe0,9]));
    const fake = path.join(IDIR, 'c.png'); fs.writeFileSync(fake, 'not png');
    const gif = path.join(IDIR, 'd.gif'); fs.writeFileSync(gif, 'GIF89a');
    const big = path.join(IDIR, 'e.png'); fs.writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1));
    const n0 = calls.length;
    for (const bad of [{ image: 'rel.png' }, { image: path.join(IDIR, 'none.png') }, { image: gif }, { image: big }, { image: fake }, { images: 'x' }, { image: IDIR + '.png' }])
      assert.strictEqual((await post({ type: 'c2c', openid: 'IU', msg_id: 'iv', ...bad })).status, 400, JSON.stringify(bad));
    assert.strictEqual(calls.length, n0, 'nothing sent on validation error');
    let r = await post({ type: 'c2c', openid: 'IU', msg_id: 'i1', content: 'see pic', image: png }); let jr = await r.json();
    assert.strictEqual(r.status, 200); assert.deepStrictEqual([jr.parts_sent, jr.images_sent, jr.images_total, jr.images_skipped], [1, 1, 1, 0]);
    const ic = calls.slice(n0);
    assert.deepStrictEqual(ic.map(x => x.url), ['/v2/users/IU/messages', '/v2/users/IU/files', '/v2/users/IU/messages']);
    assert.deepStrictEqual(ic[1].body, { file_type: 1, file_data: pngBuf.toString('base64'), file_name: 'a.png', srv_send_msg: false });
    assert.deepStrictEqual(ic[2].body, { msg_type: 7, media: { file_info: 'FI' }, msg_id: 'i1', msg_seq: 2 });
    assert.ok(fileLines('c2c', 'IU').slice(-1)[0].includes('[图片] a.png'));
    // image only, group, two images
    const n1 = calls.length;
    r = await post({ type: 'group', group_openid: 'IG', msg_id: 'i2', images: [png, jpg] }); jr = await r.json();
    assert.strictEqual(r.status, 200); assert.deepStrictEqual([jr.parts_sent, jr.images_sent], [0, 2]);
    assert.deepStrictEqual(calls.slice(n1).map(x => [x.url, x.body.msg_seq]), [['/v2/groups/IG/files', undefined], ['/v2/groups/IG/messages', 1], ['/v2/groups/IG/files', undefined], ['/v2/groups/IG/messages', 2]]);
    // cap: c2c passive cap 4, 3 text already sent -> 1 image slot
    for (const t of ['1', '2', '3']) await post({ type: 'c2c', openid: 'IU', msg_id: 'i3', content: t });
    r = await post({ type: 'c2c', openid: 'IU', msg_id: 'i3', images: [png, jpg] }); jr = await r.json();
    assert.deepStrictEqual([jr.images_sent, jr.images_skipped], [1, 1]);
    // text-only responses unchanged (no image fields)
    jr = await (await post({ type: 'c2c', openid: 'IU', msg_id: 'i4', content: 'plain' })).json();
    assert.strictEqual(jr.images_sent, undefined);
    fs.rmSync(IDIR, { recursive: true, force: true });
  }
  // ---- watchdog: fire / disarm / re-arm, driven by a fake timer (deterministic)
  {
    const armed = [];                                     // { id, ms, fn, cleared } queue
    let autoFire = true;                                  // a new arm() fires only when we run it
    const setTimer = (fn, ms) => { const t = { id: armed.length + 1, ms, fn, cleared: false }; armed.push(t); if (autoFire) t.fn(); return t.id; };
    const clearTimer = id => { const t = armed.find(x => x.id === id); if (t) t.cleared = true; };
    const runLast = () => armed[armed.length - 1].fn();    // manually fire the most recent arm
    // fires with the reason after `ms`
    let fired = null;
    const w = new Watchdog({ onFire: r => { fired = r; }, setTimer, clearTimer });
    w.arm(50, 'reason-A');
    assert.deepStrictEqual(fired, 'reason-A');             // fake timer fired synchronously
    assert.strictEqual(armed[armed.length - 1].ms, 50);    // armed for the requested ms
    // re-arm replaces the prior timer: the old timer is cleared and only the newest can fire
    autoFire = false; fired = null;
    w.arm(60, 'reason-B'); w.arm(70, 'reason-C');
    if (armed[armed.length - 2]) assert.strictEqual(armed[armed.length - 2].cleared, true); // reason-B cleared
    runLast();
    assert.deepStrictEqual(fired, 'reason-C');             // only the newest timer fires, with its own reason
    // disarm cancels a pending timer so onFire never runs
    fired = null;
    w.arm(80, 'reason-D');
    assert.strictEqual(armed[armed.length - 1].cleared, false); // still pending
    w.disarm();
    assert.strictEqual(armed[armed.length - 1].cleared, true);  // cancelled
    runLast();                                            // firing a disarmed entry is a no-op in real life; onFire stays null
    assert.strictEqual(fired, null);
    // lazily-armed watchdog, fired on demand
    autoFire = false; fired = null;
    const lz = new Watchdog({ onFire: r => { fired = r; }, setTimer, clearTimer });
    lz.arm(90, 'reason-E');
    assert.strictEqual(fired, null);                      // armed but not yet fired
    armed[armed.length - 1].fn();
    assert.deepStrictEqual(fired, 'reason-E');
    // disarming an unarmed or already-fired watchdog is a safe no-op
    w.disarm(); lz.disarm();
  }
  // ---- watchdog: real-time fire / disarm using tiny sleeps
  {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let fired = null;
    const w = new Watchdog({ onFire: r => { fired = r; } });
    w.arm(15, 'boom'); await sleep(60);
    assert.strictEqual(fired, 'boom');                    // real setTimeout fired
    fired = null;
    w.arm(40, 'wait'); w.disarm(); await sleep(90);
    assert.strictEqual(fired, null);                      // disarmed before it could fire
  }
  // ---- liveness: checkLiveness decides ok / reason / age, on the wall clock only
  {
    const t0 = Date.now();
    const ok = checkLiveness({ wsState: 1, lastAliveAt: t0, now: t0, maxAgeMs: 1000 });
    assert.deepStrictEqual([ok.ok, ok.reason, ok.ageMs], [true, '', 0]);
    const connecting = checkLiveness({ wsState: 0, lastAliveAt: t0, now: t0 + 10, maxAgeMs: 1000 });
    assert.deepStrictEqual([connecting.ok, connecting.reason, connecting.ageMs], [false, 'ws-not-open', 10]);
    const closed = checkLiveness({ wsState: 3, lastAliveAt: t0, now: t0, maxAgeMs: 1000 });
    assert.deepStrictEqual([closed.ok, closed.reason], [false, 'ws-not-open']);
    const stale = checkLiveness({ wsState: 1, lastAliveAt: t0, now: t0 + 2000, maxAgeMs: 1000 });
    assert.deepStrictEqual([stale.ok, stale.reason, stale.ageMs], [false, 'stale', 2000]);
    const fresh = checkLiveness({ wsState: 1, lastAliveAt: t0, now: t0 + 500, maxAgeMs: 1000 });
    assert.deepStrictEqual([fresh.ok, fresh.reason, fresh.ageMs], [true, '', 500]);
  }
  // ---- liveness: detectClockJump detects a suspended or fast-forwarded clock, past the threshold only
  {
    const t0 = Date.now();
    // a normal heartbeat interval stays well inside the threshold
    const normal = detectClockJump(t0, t0 + 15000, 15000);
    assert.strictEqual(normal, false);
    // a jump/suspend far beyond the threshold is detected (drift = elapsed - interval)
    const jumped = t0 + 15000 + 60000;
    assert.strictEqual(detectClockJump(t0, jumped, 15000), true);
    // ...but not one within the threshold
    const near = t0 + 15000 + 1000;
    assert.strictEqual(detectClockJump(t0, near, 15000), false);
    // the threshold itself is configurable
    assert.strictEqual(detectClockJump(t0, jumped, 15000, 120000), false);
  }
  // ---- /health: getHealth drives the payload; not ok reports 503, ok reports 200, absent keeps {ok:true}
  {
    const bad = createReplyServer(api, 'T', () => ({ ok: false, ws_state: 'OPEN', last_ack_age_ms: 12345, reason: 'stale' }));
    await new Promise(r => bad.listen(0, r));
    const rh = await fetch(`http://127.0.0.1:${bad.address().port}/health`);
    assert.strictEqual(rh.status, 503);
    const hj = await rh.json();
    assert.deepStrictEqual([hj.ok, hj.ws_state, hj.last_ack_age_ms, hj.reason], [false, 'OPEN', 12345, 'stale']);
    bad.close();
  }
  {
    const good = createReplyServer(api, 'T', () => ({ ok: true, ws_state: 'OPEN', last_ack_age_ms: 0, reason: '' }));
    await new Promise(r => good.listen(0, r));
    const rg = await fetch(`http://127.0.0.1:${good.address().port}/health`);
    assert.strictEqual(rg.status, 200);
    const gj = await rg.json();
    assert.deepStrictEqual([gj.ok, gj.ws_state, gj.last_ack_age_ms, gj.reason], [true, 'OPEN', 0, '']);
    good.close();
  }
  {
    const rg0 = await fetch(`http://127.0.0.1:${srv.address().port}/health`);
    assert.strictEqual(rg0.status, 200);
    assert.deepStrictEqual(await rg0.json(), { ok: true });
  }
  // ---- lib.js fetch timeout: a server that never responds is aborted into an ETIMEDOUT error
  {
    const hangServer = http.createServer(() => {});            // accepts the connection, never replies
    const sockets = new Set(); hangServer.on('connection', s => sockets.add(s));
    await new Promise(r => hangServer.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${hangServer.address().port}`;
    // HTTP_TIMEOUT_MS in lib.js is captured at require time, so a small override needs a FRESH
    // require: swap in a re-required copy with the env var set, drive the real token fetch through
    // fetchTimeout (AbortSignal.timeout -> ETIMEDOUT), then restore the original module.
    const libPath = require.resolve('../lib');
    const prevLib = require.cache[libPath];
    process.env.QQ_HTTP_TIMEOUT_MS = '120';
    delete require.cache[libPath];
    const freshLib = require('../lib');                        // re-reads QQ_HTTP_TIMEOUT_MS = 120
    let err = null;
    try { await new freshLib.TokenManager({ tokenUrl: base + '/token' }, 'a', 's').get(); }
    catch (e) { err = e; }
    assert.ok(err, 'expected the hanging token fetch to reject');
    assert.strictEqual(err.code, 'ETIMEDOUT');
    delete process.env.QQ_HTTP_TIMEOUT_MS;
    require.cache[libPath] = prevLib;                          // restore the original (HTTP_TIMEOUT_MS = 15000)
    for (const s of sockets) s.destroy();
    await new Promise(r => hangServer.close(r));
  }
  console.log('ALL TESTS PASSED'); srv.close(); mock.close(); fs.rmSync(HDIR, { recursive: true, force: true }); fs.rmSync(MDIR, { recursive: true, force: true }); fs.rmSync(MDIA, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
