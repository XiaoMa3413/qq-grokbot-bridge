'use strict';

const assert = require('node:assert');
const { parseElements, refMsgIdx, SeenIds, RecentImages, redact } = require('../events.js');

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
