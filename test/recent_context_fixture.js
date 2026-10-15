'use strict';
// Redacted fixture shaped like a real GROUP_AT_MESSAGE_CREATE dispatch with
// message_type=103, where QQ auto-attaches the recent group messages into a
// single msg_elements[].content in the "=== 消息 N ===" textual format. Every
// id/token below is a fake placeholder (no real identifiers). No per-message
// author or msg id appears in the blob, matching the observed sample; the
// message_scene.ext ref_msg_idx is a TMP_<uuid> context pointer, not a real quote.
const GROUP_OPENID = 'FAKE_group_openid_0001';
const MEMBER_OPENID = 'FAKE_member_openid_0001';
const MSG_ID = 'ROBOT1.0_FAKE_MSGID_0001_for_tests_only';

const d = {
  author: {
    bot: false,
    id: 'FAKE_member_id_0001',
    member_openid: MEMBER_OPENID,
    member_role: 'owner',
    union_openid: 'FAKE_union_openid',
    username: 'FAKE_sender_username',
  },
  content: '能看到群消息历史了吗',
  group_id: 'FAKE_group_id_0001',
  group_openid: GROUP_OPENID,
  id: MSG_ID,
  message_scene: {
    ext: [
      'msg_idx=FAKE_msg_idx_ref_0001',
      'auth_token=FAKE_REDACTED_auth_token_value',
      'ref_msg_idx=TMP_0ca528a2-6d90-4644-9427-12646606372b',
    ],
    source: 'default',
  },
  message_type: 103,
  msg_elements: [
    {
      content:
        '=== 消息 1 ===\n[消息内容] 是时候来品鉴一下美味的战地六第五赛季了\n\n' +
        '=== 消息 2 ===\n[消息内容] 对，是真的～群里我只能收到 @我 的那条消息，单独发的图或文字我看不到。\n\n' +
        '=== 消息 3 ===\n[消息内容] 看来还没修好\n\n' +
        '=== 消息 4 ===\n[消息内容] 叽里咕噜说什么呢\n',
    },
  ],
  timestamp: '2026-10-15T18:41:47+08:00',
};

// The blocks parseRecentContext(d) is expected to return for the fixture above
// (no per-message author line is present, so every author is null).
const expectedContext = [
  { index: 1, author: null, content: '是时候来品鉴一下美味的战地六第五赛季了', attachments: [] },
  { index: 2, author: null, content: '对，是真的～群里我只能收到 @我 的那条消息，单独发的图或文字我看不到。', attachments: [] },
  { index: 3, author: null, content: '看来还没修好', attachments: [] },
  { index: 4, author: null, content: '叽里咕噜说什么呢', attachments: [] },
];

// A fixture exercising the optional author/nickname ("[发送者]" / "[昵称]") and
// "[图片] url" lines, alongside a normal (non-context) element.
const dWithMeta = {
  message_type: 103,
  msg_elements: [
    {
      message_type: 103,
      content:
        '=== 消息 1 ===\n[发送者] 小明\n[消息内容] 看看这个\n[图片] http://127.0.0.1:9/a.png\n\n' +
        '=== 消息 2 ===\n[昵称] 小红\n[消息内容] 好的\n',
    },
    { message_type: 1, content: '  这是 @我 的消息  ' },
  ],
};

module.exports = { d, expectedContext, dWithMeta, GROUP_OPENID, MSG_ID };
