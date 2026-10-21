# QQ 连续对话与上下文（v1.5）

QQ 每次触发 Grok 例行任务时，桥接显式提供本次消息、相关历史、引用、最近群聊背景和会话记忆。QQ 的连续性来自这些输入，不需要 Grok 云电脑运行常驻上下文进程。

## 上下文来自哪里

| 输入 | 来源与作用域 |
|---|---|
| `content`、`author`、目标与消息 ID | 当前 QQ 事件 |
| `history` | 桥接保存的本次私聊或群聊历史 |
| `quoted` | QQ 事件提供的引用内容；仅在实际提供时携带消息 ID 和用户 openid |
| `recent_context`、`recent_images` | QQ 提供的最近群聊背景及桥接缓存的近期群图片 |
| `memory`、`memory_url` | 桥接服务器保存的当前会话 Markdown 记忆 |
| `context` | 选择历史时的身份、文字预算和缺失情况，不是额外的一份聊天正文 |

桥接本身不读取 Grok 客户端聊天记录或平台记忆，也不根据机器人自述推断它具备哪些上下文。平台是否另外向例行任务注入记忆，属于其运行环境的行为。需要跨来源共享的事实应通过明确的导入流程提供；[平台概述](https://docs.x.ai/grok-bot/overview)中的记忆能力不能代替本项目的接口约定。

## 问答关联与选择顺序

新保存的机器人回复带 `reply_to_msg_id`，已知发起者时也带 `reply_to_openid`。组装时将明确关联的问题和回答视为一组，一起选择或省略，避免只剩回答而问题被截走。当前消息本身及其回复不会再次作为历史附带，进度段也不占正文历史。

历史文件裁剪时会保留已留存回答所引用的问题。长任务期间若原问题已被背景消息挤出，回复记录前可从持久化任务中的原始消息恢复它；保留原时间与身份，图片只记录存在标记，不凭空生成图片理解。

选择优先级为：

1. QQ 实际提供了原消息 ID 的明确引用所对应的轮次。
2. 当前私聊的轮次，或群内同一稳定用户 ID 发起的轮次。
3. 其余群背景。

同一优先级从较近的记录开始选择，最终按原记录顺序输出并保留时间字段。长任务恢复的问题可能追加在较新背景之后，其时间字段仍是原始消息时间。群里的昵称只用于显示，不用来推断用户相同。缺少身份时 `context.speaker.id` 为 null；QQ 的 `TMP_...` 上下文索引不当作真实消息 ID。

旧回答没有明确关联时继续保留，并计入 `unlinked_bot_entries`；不会猜测其原问题。明确关联却找不到问题、问题顺序不合理或已知身份冲突的回答会省略，计入 `orphaned_entries`。这些是输入缺失提示，不能据此编造前文。

## 文字预算与截断

`config.json` 的 `contextTextMaxChars` 默认 12000，允许整数 256–65536。历史条数另受 `historyLimitC2c` / `historyLimitGroup` 限制，默认 20/10，允许整数 1–1000。

预算只统计 `history`、`quoted`、`recent_context` 的 `content` 字符长度，单位是 JavaScript UTF-16 code unit；不是模型 token。当前消息、独立记忆、附件、最近图片缓存和元数据不包含在内，所以它不代表整个 webhook JSON 的大小。

- 引用优先获得不超过总预算三分之一且最多 4000 字符。
- 相关历史使用剩余预算，完整问答受条数限制；需要缩短时保留组内各条消息，并标记截断。
- 最近群背景使用余量；只对明确消息 ID 相同或同来源导入背景的无图片文本副本去重，不凭昵称相同合并用户身份。携带附件的背景保留附件证据，即使正文需缩短为空。
- 引用与最近群背景各最多 10 项，避免额外记录无限增长。

截断条目带 `content_truncated:true` 和 `original_content_chars`。历史存储原本最多保留每条 2000 字符；新记录也会标记这一层截断。已经被旧版本截掉的内容无法自动恢复。截断不会留下半个 UTF-16 代理对。

## 元数据示意

以下仅展示部分字段，正文仍使用已有的根级 `history` / `quoted` / `recent_context`，不重复嵌套进 `context`：

```json
{
  "bridge_version": "1.5.0",
  "context": {
    "schema": 1,
    "conversation": { "type": "c2c", "id": "<原用户ID>" },
    "speaker": { "id": "<原用户ID>", "nickname": null },
    "budget": { "max_chars": 12000, "used_chars": 8, "unit": "utf16_code_units" },
    "history": {
      "available": true, "max_entries": 20, "available_entries": 2,
      "sent_entries": 2, "omitted_entries": 0, "orphaned_entries": 0,
      "truncated_entries": 0, "unlinked_bot_entries": 0
    },
    "memory": { "source": "bridge_conversation", "scope": "private", "platform_sync": "not_configured" }
  },
  "history": [
    { "role": "user", "msg_id": "<前条消息ID>", "openid": "<原用户ID>", "content": "上一问题" },
    { "role": "bot", "reply_to_msg_id": "<前条消息ID>", "reply_to_openid": "<原用户ID>", "content": "上一回答" }
  ]
}
```

`quoted` / `recent_context` 的统计同样包含 `available_entries`、`sent_entries`、`omitted_entries`、`truncated_entries`，最近背景另含 `deduplicated_entries`。`history.available:false` 表示文件读取失败后使用了空历史；新会话尚无文件时仍是可用的空历史。损坏 JSONL 行沿用旧读取逻辑跳过，当前不提供逐行修复诊断。

## 当前边界

同群用户的相关对话优先选择并不是权限隔离，群背景仍属于同一群的共享上下文。不同私聊与不同群按各自会话保存，群记忆仍是一份共享 Markdown；个人记忆作用域管理尚待实现。

同会话仍串行等待任务结束或到期。长任务执行期间新发的“换个条件”尚不会自动交给正在运行的 Grok；任务更新箱、进度查询、取消、摘要和客户端选定记忆同步属于[后续设计](context-design.md)。
