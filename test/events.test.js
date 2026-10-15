'use strict';

const assert = require('node:assert');
const { parseElements, parseRecentContext, refMsgIdx, SeenIds, RecentImages, redact } = require('../events.js');
const { d, expectedContext, dWithMeta } = require('./recent_context_fixture.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- parseElements ----
test('parseElements invalid input -> empty arrays', () => {
  const empty = { texts: [], attachments: [], quoted: [] };
  for (const bad of [null, undefined, 42, 'x', {}, { msg_elements: 'x' }, { msg_elements: [] }]) {
    assert.deepStrictEqual(parseElements(bad), empty);
  }
});

test('parseElements top-level element is quoted + text collected', () => {
  const r = parseElements({ msg_elements: [{ content: 'hi', message_type: 1 }] });
  assert.deepStrictEqual(r.texts, ['hi']);
  assert.deepStrictEqual(r.attachments, []);
  assert.deepStrictEqual(r.quoted, [{ author: null, content: 'hi', attachments: [] }]);
});

test('parseElements trims content and skips blank text', () => {
  const r = parseElements({
    msg_elements: [
      { content: '  hello  ', message_type: 1 },
      { content: '   ', message_type: 1 },
      { content: 'keep', message_type: 1 },
    ],
  });
  assert.deepStrictEqual(r.texts, ['hello', 'keep']);
  assert.strictEqual(r.quoted[0].content, 'hello');
});

test('parseElements attachment references shared with quoted', () => {
  const att = { local_path: 'p1' };
  const r = parseElements({ msg_elements: [{ content: '', message_type: 3, attachments: [att] }] });
  assert.strictEqual(r.attachments[0], att);
  assert.strictEqual(r.quoted[0].attachments[0], att);
});

test('parseElements nested 102/103 quoted, other nested only text/attach', () => {
  const att1 = { local_path: 'img1' };
  const r = parseElements({
    msg_elements: [
      { content: 'outer', message_type: 1 },
      {
        content: 'plain',
        message_type: 1,
        msg_elements: [
          { content: 'q102', message_type: 102, author: { id: '42' }, attachments: [att1] },
          { content: 'deep', message_type: 1 },
          { content: 'q103', message_type: 103, author: { username: 'amy' } },
        ],
      },
    ],
  });
  assert.deepStrictEqual(r.texts, ['outer', 'plain', 'q102', 'deep', 'q103']);
  assert.strictEqual(r.attachments[0], att1);
  assert.strictEqual(r.attachments.length, 1);
  assert.strictEqual(r.quoted.length, 4);
  assert.deepStrictEqual(r.quoted[0], { author: null, content: 'outer', attachments: [] });
  assert.deepStrictEqual(r.quoted[1], { author: null, content: 'plain', attachments: [] });
  assert.deepStrictEqual(r.quoted[2], { author: '42', content: 'q102', attachments: [att1] });
  assert.deepStrictEqual(r.quoted[3], { author: 'amy', content: 'q103', attachments: [] });
});

test('parseElements author resolution', () => {
  const authorOf = (author) =>
    parseElements({ msg_elements: [{ content: 'x', message_type: 102, author }] }).quoted[0].author;
  assert.strictEqual(authorOf({ username: 'alice', id: '1' }), 'alice');
  assert.strictEqual(authorOf({ id: '2' }), '2');
  assert.strictEqual(authorOf({}), null);
  assert.strictEqual(authorOf(undefined), null);
});

// ---- recent-context (message_type 103 "=== 消息 N ===" blob) ----
test('parseRecentContext invalid input -> []', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { msg_elements: 'x' }, { msg_elements: [] }]) {
    assert.deepStrictEqual(parseRecentContext(bad), []);
  }
});

test('parseRecentContext ignores events without the context marker', () => {
  assert.deepStrictEqual(parseRecentContext({ msg_elements: [{ content: 'hi', message_type: 1 }] }), []);
  // a 102/103 element that is NOT in the "=== 消息 ===" shape is not context
  assert.deepStrictEqual(parseRecentContext({ msg_elements: [{ content: 'quote me', message_type: 103 }] }), []);
});

test('parseRecentContext parses the redacted real fixture', () => {
  const r = parseRecentContext(d);
  assert.strictEqual(r.length, 4);
  assert.deepStrictEqual(r, expectedContext);
  // indices run 1..4 in order; no author line in the sample -> every author null
  assert.deepStrictEqual(r.map(e => e.index), [1, 2, 3, 4]);
  assert.ok(r.every(e => e.author === null));
  assert.ok(r.every(e => Array.isArray(e.attachments) && e.attachments.length === 0));
});

test('parseRecentContext parses author/nickname lines and [图片] urls', () => {
  const r = parseRecentContext(dWithMeta);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[0], {
    index: 1, author: '小明', content: '看看这个',
    attachments: [{ content_type: 'image/*', url: 'http://127.0.0.1:9/a.png' }],
  });
  // "[昵称] x" is accepted as an author line too
  assert.deepStrictEqual(r[1], { index: 2, author: '小红', content: '好的', attachments: [] });
});

test('parseRecentContext trims message content, keeps blank-free blocks', () => {
  const r = parseRecentContext({ msg_elements: [{ message_type: 103, content: '=== 消息 1 ===\n[消息内容]   spaced  \n' }] });
  assert.deepStrictEqual(r, [{ index: 1, author: null, content: 'spaced', attachments: [] }]);
});

test('parseRecentContext: element-level attachments attach to a single-message element', () => {
  const att = { content_type: 'image/png', url: 'http://127.0.0.1:9/b.png' };
  const r = parseRecentContext({ msg_elements: [{ message_type: 103, content: '=== 消息 1 ===\n[消息内容] hi', attachments: [att] }] });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].attachments[0], att); // same reference, downloads like a quoted image
});

// ---- context elements are excluded from quoted/texts ----
test('parseElements excludes context blobs from quoted/texts/attachments', () => {
  const r = parseElements(d);
  assert.deepStrictEqual(r, { texts: [], attachments: [], quoted: [] });
});

test('parseElements keeps only non-context elements in quoted', () => {
  const r = parseElements(dWithMeta);
  // the "=== 消息 ===" element is dropped; only the real @ text remains quoted
  assert.deepStrictEqual(r.quoted, [{ author: null, content: '这是 @我 的消息', attachments: [] }]);
  assert.deepStrictEqual(r.texts, ['这是 @我 的消息']);
  // ...and its [图片] block never surfaced as a top-level attachment
  assert.deepStrictEqual(r.attachments, []);
});

test('parseElements still quotes a real 102/103 next to a context blob', () => {
  const att = { local_path: 'q1' };
  const r = parseElements({ msg_elements: [
    { message_type: 103, content: '=== 消息 1 ===\n[消息内容] ctx\n' }, // context -> skipped
    { message_type: 102, content: 'real quote', author: { username: 'amy' }, attachments: [att] },
  ] });
  assert.deepStrictEqual(r.quoted, [{ author: 'amy', content: 'real quote', attachments: [att] }]);
  assert.strictEqual(r.attachments[0], att);
});

// ---- refMsgIdx ----
test('refMsgIdx returns ref_msg_idx value', () => {
  assert.strictEqual(refMsgIdx({ message_scene: { ext: ['msg_idx=XYZ', 'ref_msg_idx=ABC'] } }), 'ABC');
  assert.strictEqual(refMsgIdx({ message_scene: { ext: ['a=b', 'ref_msg_idx=A=B'] } }), 'A=B');
});

test('refMsgIdx null cases', () => {
  assert.strictEqual(refMsgIdx({ message_scene: { ext: ['msg_idx=XYZ'] } }), null);
  assert.strictEqual(refMsgIdx({ message_scene: {} }), null);
  assert.strictEqual(refMsgIdx({ message_scene: { ext: 'x' } }), null);
  assert.strictEqual(refMsgIdx({}), null);
  assert.strictEqual(refMsgIdx(null), null);
});

// ---- SeenIds ----
test('SeenIds has/add/check', () => {
  const s = new SeenIds();
  assert.strictEqual(s.has('a'), false);
  s.add('a');
  assert.strictEqual(s.has('a'), true);
  assert.strictEqual(s.check('a'), true);
  assert.strictEqual(s.check('b'), false);
  assert.strictEqual(s.has('b'), true);
});

test('SeenIds FIFO bound', () => {
  const s = new SeenIds(2);
  s.add('x');
  s.add('y');
  s.add('z'); // evicts oldest 'x'
  assert.strictEqual(s.has('x'), false);
  assert.strictEqual(s.has('y'), true);
  assert.strictEqual(s.has('z'), true);
});

// ---- RecentImages ----
test('RecentImages window / max / oldest-first', () => {
  const r = new RecentImages(5000, 2);
  r.add('g', { local_path: 'a', nickname: 'n1', timestamp: 1000 }, 1000);
  r.add('g', { local_path: 'b', nickname: 'n2', timestamp: 2000 }, 2000);
  r.add('g', { local_path: 'c', nickname: 'n3', timestamp: 3000 }, 3000);
  assert.deepStrictEqual(
    r.get('g', 4000).map((e) => e.local_path),
    ['b', 'c']
  );
});

test('RecentImages query-time window filters', () => {
  const r = new RecentImages(5000, 5);
  r.add('g', { local_path: 'a', nickname: 'n1', timestamp: 1000 }, 1000);
  assert.deepStrictEqual(r.get('g', 6001), []);
  assert.strictEqual(r.get('g', 1000).length, 1);
});

test('RecentImages groups isolated + timestamp fallback', () => {
  const r = new RecentImages(5000, 5);
  assert.deepStrictEqual(r.get('none', 1000), []);
  r.add('g1', { local_path: 'a', nickname: 'n1', timestamp: 1000 }, 1000);
  r.add('g2', { local_path: 'b', nickname: 'n2', timestamp: 1000 }, 1000);
  assert.strictEqual(r.get('g1', 1000)[0].local_path, 'a');
  assert.strictEqual(r.get('g2', 1000)[0].local_path, 'b');
  r.add('g3', { local_path: 'c', nickname: 'n3' }, 12345); // no timestamp -> uses now
  assert.strictEqual(r.get('g3', 12346)[0].timestamp, 12345);
});

// ---- redact ----
test('redact drops only token/secret keys deeply, keeps others, no mutation', () => {
  const input = {
    api_token: 'x',
    client_secret: 'y',
    data: {
      accessToken: 'z',
      nested: { secret_value: 1, keep: 'ok' },
      arr: [{ password: 'p', fine: 2 }, 's', 5], // 'password' is NOT token/secret -> kept
    },
    keep: true,
  };
  assert.deepStrictEqual(redact(input), {
    data: { nested: { keep: 'ok' }, arr: [{ password: 'p', fine: 2 }, 's', 5] },
    keep: true,
  });
  assert.strictEqual(input.api_token, 'x');
  assert.strictEqual(input.data.arr[0].password, 'p');
});

test('redact primitives + case-insensitive key match', () => {
  assert.strictEqual(redact(5), 5);
  assert.strictEqual(redact('token'), 'token');
  assert.strictEqual(redact(null), null);
  assert.deepStrictEqual(redact({ AUTH_TOKEN: 1, SECRET: 2, x: 3 }), { x: 3 });
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(err);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
