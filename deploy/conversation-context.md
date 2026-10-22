# QQ 连续对话与上下文

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

最近群背景导入历史时，只与用户记录去重：双方都有消息 ID 时，以 ID 是否相同为准；缺少 ID 时，才使用文字、兼容昵称和十分钟时间窗口兜底。兜底无法完全区分重复上报与内容相同的独立消息，不代表已经识别发言者身份。

从 1.9 起，去重还要求稳定发言者 ID 和已知机器人标记一致；有 ID 与无 ID 的两条记录不通过文字匹配合并。不会从相同文字推断未知发言者的身份。

## 群消息范围与发言归属

QQ 群设置中的消息获取范围控制桥接能收到哪些事件或背景；桥接的 `historyLimitGroup` 则控制一次载荷最多选取多少条历史。这是两层独立限制，均设置为 10 也不意味着指向同一批消息。桥接不能凭载荷推定当前群设置，不能补齐未收到的聊天。

无论只收到 @ 消息、附带近期背景，还是收到普通群消息事件，都按实际字段处理。普通 `GROUP_MESSAGE_CREATE` 保存为群背景，不单独唤醒 Grok。全量事件路径有模拟测试，具体账号是否投递完整消息及身份仍需实际验证。

从桥接 1.9 起，`history`、`quoted`、`recent_context` 和 `recent_images` 每条记录增加 `source` 和 `attribution`：

| 字段 | 含义 |
|---|---|
| `attribution.speaker: self` | 桥接保存的自身出站回复历史；`basis` 为 `bridge_reply_history` |
| `attribution.speaker: other` | 有稳定用户 ID 的外部发言者；可能是人，也可能是其他机器人 |
| `attribution.speaker: unknown` | 缺少稳定身份；有昵称也仍为未知，不能推断为当前用户或本机器人 |
| `attribution.id` / `nickname` | 已提供的稳定 ID / 显示昵称；缺失为 null |
| `attribution.is_bot` | 原作者的明确布尔标记；未知为 null。true 本身不能证明是本机器人 |
| `attribution.basis` | `bridge_reply_history`、`qq_author_id`、`display_name_only` 或 `unavailable` |
| `source` | `bridge_reply`、`qq_message`、`qq_recent_context`、`qq_quote`、`qq_recent_image` 或 `legacy_history` |

`role:user` 保留为兼容字段，表示非自身回复类别，**不保证作者是人，也不保证身份已知**。未知背景中的“我”属于原发言语境，不能改写成本机器人的“我”。引用和近期背景即使内容与自身历史相同，也不因文字相同升级为 `self`。上下文文本块外层的 author、消息 ID 和临时索引，不会被当作块内原消息的身份。

`context.attribution` 给出独立的版本 `schema:1`、自身证据来源及各类未知发言者条数。旧存储不需迁移：桥接原有 `role:bot` 历史在读取时标为自身回复；旧导入背景仍保留未知身份。已准备好的在途任务快照保持原样。

群记忆是一份共享 Markdown，`context.memory.speaker_attribution:unverified_free_text` 表示桥接没有逐条验证其中的发言归属。记忆和选定资料只能提供背景，不能单独证明“我之前说过”。写入人物偏好、承诺或对话事实时，记录主体和可获得的来源，例如 `主体：成员 <稳定ID>；来源：消息 <msg_id>；事实：……`。身份不明则明确写未知，不把外部发言记成本机器人承诺；已有模糊记忆不能凭猜测批量改写。

## 问答关联与选择顺序

新保存的机器人回复带 `reply_to_msg_id`，已知发起者时也带 `reply_to_openid`。组装时将明确关联的问题和回答视为一组，一起选择或省略，避免只剩回答而问题被截走。当前消息本身及其回复不会再次作为历史附带，进度段也不占正文历史。

历史文件裁剪时会保留已留存回答所引用的问题，群历史还额外保留最近一组可关联的自身问答，减少背景刷屏挤掉自身回复的情况；旧内容已经被裁掉则无法恢复。长任务期间若原问题已被背景消息挤出，回复记录前可从持久化任务中的原始消息恢复它；保留原时间与身份，图片只记录存在标记，不凭空生成图片理解。

选择优先级为：

1. QQ 实际提供了原消息 ID 的明确引用所对应的轮次。
2. 当前私聊的轮次，或群内同一稳定用户 ID 发起的轮次。
3. 其他成员发起且带明确自身回答关联的轮次。
4. 其余群背景。

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
