# QQ Bridge

Stays running on the box. Connects to the official QQ bot WebSocket gateway, receives C2C (private) messages and group @ messages, and forwards each one to the webhook of the agent "QQ 小企鹅". Replies come back through a local HTTP endpoint, and the bridge sends them out as passive replies.

## Environment variables
| Variable | Required | Description |
|---|---|---|
| QQ_APP_ID | yes | QQ bot AppID (env only, never written to disk or logs) |
| QQ_APP_SECRET | yes | QQ bot AppSecret (env only) |
| QQ_FORWARD_WEBHOOK_URL | no | Forward URL. Overrides `forwardWebhookUrl` in config.json |
| QQ_FORWARD_WEBHOOK_SECRET | no | Webhook secret, sent as a request header |
| QQ_FORWARD_WEBHOOK_HEADER | no | Header name, default `Authorization: Bearer <secret>` |
| QQ_REPLY_PORT | no | Reply port, default 8787 |
| QQ_API_BASE / QQ_TOKEN_URL | no | Testing only: overrides the QQ API endpoints |
| QQ_HISTORY_DIR | no | 会话历史存储目录，默认 `data/history` |
| QQ_MEMORY_DIR | no | 长期记忆文件目录，默认 `memory` |
| QQ_MEDIA_DIR | no | 收到的图片附件本地缓存目录，默认 `data/media` |
| QQ_DEBUG_RAW_EVENTS | no | 设为 `1` 时把原始事件写入 `logs/raw-events.jsonl`（默认关闭；文件可能含 auth_token，勿提交） |

If QQ_APP_ID or QQ_APP_SECRET is missing, the bridge exits with code 78 and the supervisor stops too.

## Start / stop
```
export QQ_APP_ID=... QQ_APP_SECRET=... QQ_FORWARD_WEBHOOK_URL=... QQ_FORWARD_WEBHOOK_SECRET=...
./start.sh   # starts the run_loop.sh supervisor in the background; it restarts the bridge after a crash (backoff 2s up to 60s)
./stop.sh
```
Logs: `logs/bridge.log`, `logs/supervisor.log`. The box has no systemd, so a bash loop does the supervising.

## Inbound forwarding (bridge -> QQ 小企鹅)
`POST $QQ_FORWARD_WEBHOOK_URL`, Content-Type: application/json, with header `Authorization: Bearer <secret>: <secret>`. A failed POST is retried up to 3 times.
```json
{"type":"c2c","openid":"USER_OPENID","author":{"user_openid":"USER_OPENID"},
 "nickname":"昵称或null","group_card":null,
 "content":"你好","msg_id":"ROBOT1.0_xxx","timestamp":"2026-10-14T11:00:00+08:00","attachments":[],
 "history":[{"role":"user","nickname":"alice","member_role":null,"openid":"USER_OPENID","content":"在吗","timestamp":"2026-10-14T10:59:00+08:00"}],
 "memory_path":"/opt/qq-bridge/memory/c2c-USER_OPENID.md"}
{"type":"group","group_openid":"GROUP_OPENID","author":{"id":"...","username":"...","bot":false,"member_openid":"MEMBER_OPENID","member_role":"member"},
 "nickname":"昵称或null","group_card":null,
 "content":"你好","msg_id":"ROBOT1.0_yyy","timestamp":"...","attachments":[],
 "history":[],
 "memory_path":"/opt/qq-bridge/memory/group-GROUP_OPENID.md"}
```

### 发送者字段
- `author`: 原始 QQ author 对象，原样透传，未做任何删改。
- `nickname`: 取自 `author.username`；为空时（例如用户没有设置昵称）为 `null`。实际使用中 username 可能为空字符串。
- `group_card`: 恒为 `null`。QQ 官方机器人 API v2 的事件和群成员接口都没有群名片（card）字段，只有昵称；群成员接口 `GET /v2/groups/{group_openid}/members/{member_openid}` 虽然返回 username，但仅白名单可用（错误码 11253），bridge 未调用。

按官方文档 [group_at_message_create](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)，author (User) 的字段如下：

| 字段 | 说明 |
|---|---|
| `id` | 用户 ID |
| `username` | 昵称，实际可能为空 |
| `bot` | 是否为机器人 |
| `union_openid` | 可能为空，需申请绑定 |
| `union_user_account` | 可能为空 |
| `user_openid` | 单聊场景的用户 openid |
| `member_openid` | 群聊场景的成员 openid |
| `member_role` | 群内角色：`member` / `admin` / `owner`（仅群聊） |

调试: 设置环境变量 `QQ_DEBUG_RAW_EVENTS=1` 时，bridge 会把原始事件（未转换的 `{t, d}`）追加写入 `logs/raw-events.jsonl`，默认关闭。该文件可能包含 message_scene 中的 auth_token，属于敏感数据，不要提交到 git。

### attachments 与 local_path

`attachments` 是 QQ 事件里的附件数组，原样透传；其中每个图片附件在转发前还会被下载到本机，并多出一个 `local_path` 字段。

- 判断：`content_type` 以 `image/` 开头且带 `url` 的附件会被下载；附件地址以 `//` 开头时先补成 `https:`。其他类型（视频、文件等）原样透传，不加 `local_path`。
- 保存位置：`$QQ_MEDIA_DIR/<sanitize(msg_id)>-<序号>.<ext>`，`local_path` 是保存成功后的**绝对路径**。`<序号>` 是该附件在 `attachments` 里的下标（从 0 开始），`<ext>` 由 `content_type` 决定：jpeg→`jpg`、png→`png`、gif→`gif`、webp→`webp`，其他→`bin`。`msg_id` 里的非法字符会替换成 `_`，不会发生路径逃逸。
- 失败：下载失败（超时、超过 20MB、HTTP 错误、网络错误、写盘失败等，或图片没有 `url`）时 `local_path` 为 `null`，只打印日志，**不影响消息转发**，后续附件继续下载。
- 单个图片下载超时 15 秒，大小上限 20MB（按 Content-Length 和实际收到的字节数双重判断）。
- 默认目录 `data/media/`（已 gitignore），可用环境变量 `QQ_MEDIA_DIR` 覆盖。

## 会话历史 history 与长期记忆 memory_path

每条转发的 payload 除消息本身外，还带上两个上下文字段。

### history
- 数组，按时间**从旧到新**排列，**不含当前这条消息**：当前消息在转发前一刻才写入历史，所以 `history` 就是它的上文。
- 每个元素形如 `{"role":"user","nickname":null,"member_role":null,"openid":"OPENID","content":"文本","timestamp":"ISO 时间"}`：
  - `role`: `user` = 用户发来的消息；`bot` = QQ 小企鹅通过 `/reply` 接口发出的回复。
  - `nickname`、`member_role`、`openid`: 发送者信息（`bot` 的回复这几项为 `null`）。
  - `content`: 消息文本，最多保留 2000 字符，超出部分截断。
  - `timestamp`: ISO 8601 时间字符串。
- 每个会话只保留最近 50 条，更早的自动丢弃。
- 落盘位置: `data/history/<type>-<id>.jsonl`，一行一条 JSON。`<type>-<id>` 中 `<id>` 对 c2c 是 `openid`，对群是 `group_openid`；非法字符统一替换为 `_`，不会发生路径逃逸。
- 目录可用环境变量 `QQ_HISTORY_DIR` 覆盖。
- 读写出错不致命：坏行被跳过，读取失败时按空历史处理，转发照常进行。

### memory_path
- 字符串，本机上一个纯 markdown 文件的绝对路径，**每个会话一个文件**（命名规则同 history，后缀 `.md`）。
- 这是 QQ 小企鹅的长期记忆：由她用自己的文件工具直接读写，**bridge 不读也不改内容**，只在文件不存在时建一个空文件。
- 默认目录 `memory/`，可用环境变量 `QQ_MEMORY_DIR` 覆盖。
- `memory/` 下的文件已 gitignore（`memory/.gitkeep` 占位保证目录存在），记忆内容不会进入 git。

## Reply API (QQ 小企鹅 -> bridge)
`POST http://127.0.0.1:8787/reply`, header `X-Reply-Token: <contents of reply_token>` (a local token the bridge generates automatically; it is not a QQ credential).
```json
{"type":"c2c","openid":"USER_OPENID","msg_id":"ROBOT1.0_xxx","content":"回复内容"}
{"type":"group","group_openid":"GROUP_OPENID","msg_id":"ROBOT1.0_yyy","content":"回复内容"}
```
- With `msg_id`, the message goes out as a passive reply, and the bridge increments `msg_seq` for each msg_id on its own. Without `msg_id` it is an active message, which QQ heavily restricts.
- Passive replies have time and count limits: a passive reply must be sent inside the reply window of the original message — c2c: 60 minutes / up to 4 replies; group: 5 minutes / up to 5 replies (per msg_id). See the QQ docs: [消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html).
- 超过 1500 字符的长回复会自动拆分成多条（每条 ≤ 1500 字符）依次发出，每条各自 `msg_seq` +1；拆分优先按段落（`\n\n`），其次按行（`\n`），最后硬切。
- 被动回复按 msg_id 计数（含之前已经发出去的消息）：c2c 最多 4 条，群最多 5 条；不带 `msg_id` 的主动消息最多 5 条。超出条数时只发允许的条数，并把最后一条截断到以 `\n…（内容过长，已截断）` 结尾（总长仍 ≤ 1500）。某一条发送失败则停止发送后续部分。
- 拆分后的整段回复在会话历史里只记**一条** `bot` 记录（保存实际发出去的全文）。
- Response (200): `{"ok":true,"parts_sent":3,"parts_total":6,"truncated":true,"result":{...},"results":[{...},...]}` — `result` 为第一条的结果，仅为兼容保留；400 bad parameters; 401 bad token; 502 QQ API error (body includes detail，`parts_sent` 表示实际发出去的条数)。
- `GET /health` is a health check.
- CLI: `./reply.sh c2c <openid> <msg_id|-> 回复内容`

## Implementation notes
- Token: `POST https://bots.qq.com/app/getAppAccessToken {appId, clientSecret}`. Refreshed 60 seconds before it expires.
- Gateway: `GET /gateway` → WS. On Hello (op10) the bridge starts heartbeats (op1); it sends Identify (op2) with intents `1<<25` (GROUP_AND_C2C_EVENT), or Resume (op6) when it already has a session. op7 → reconnect; op9 → re-identify; a missed heartbeat ACK → reconnect; reconnects use exponential backoff up to 60s.
- Tests: `node test/test.js` (payload conversion, history, memory paths, reply splitting and per-msg_id caps, image downloads, plus the reply server against a mock QQ API).
