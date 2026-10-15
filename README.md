# QQ Bridge

常驻在机器上的 QQ 机器人桥接服务。它通过官方 QQ 机器人 WebSocket 网关接收**单聊（C2C）消息**和**群 @ 消息**，把每条消息整理成统一的 JSON 后转发给智能体「QQ 小企鹅」的入站 webhook；小企鹅的回复通过本地 HTTP 接口 `/reply` 回传，由 bridge 以**被动消息**的形式发回 QQ。

- 不暴露任何凭据：AppID / AppSecret 只从环境变量读取，不落盘、不打日志。
- 断线自动重连（指数退避），进程崩溃自动重启。
- 自带会话上下文（history）与长期记忆文件路径（memory_path），图片附件自动下载到本机。

## 架构

```
 QQ 开放平台                  bridge.js                        QQ 小企鹅
 (WebSocket 网关)             (本进程)                         (agent)
      │                          │                                ▲
      │ GET /gateway → WS        │                                │
      │ op10 Hello / op2 Identify│                                │
      │ op1 心跳 / op7 op9 / op0 │                                │
      ▼                          ▼                                │
 C2C_MESSAGE_CREATE ──► toPayload() ──► POST webhook ─────────────┘
 GROUP_AT_MESSAGE_CREATE   (挂上 history +   (Bearer 头, 失败重试 3 次)
                            memory_path)
                                │
                                ├──► 下载图片附件 ──► data/media/<msg_id>-<i>.<ext>
                                │
                                ▼
                     /reply HTTP 服务 :8787  ◄──── POST /reply（X-Reply-Token）
                                │  （1500 字拆分、msg_seq 自增、条数上限）
                                ▼
        POST /v2/users/{openid}/messages
        POST /v2/groups/{group_openid}/messages
                                │
                                ▼
              QQ API  ◄── access_token（TokenManager，提前 60 秒刷新）
```

一次消息的完整链路：

1. **QQ WebSocket → bridge**：`bridge.js` 连上网关，收到 `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` 后转换成统一 payload。
2. **bridge → qq-inbound webhook**：`POST $QQ_FORWARD_WEBHOOK_URL`，带上 history 与 memory_path，失败重试 3 次。
3. **QQ 小企鹅 → /reply**：小企鹅处理完（可读写长期记忆文件）后调用本地 `/reply`。
4. **bridge → QQ API**：bridge 拆分、限流、递增 `msg_seq`，把回复作为被动消息发出，并写回会话历史。

## 安装与环境变量

依赖只有 [`ws`](https://www.npmjs.com/package/ws)，需要 Node.js 18+（代码使用全局 `fetch` / `AbortController`）。

```bash
npm install
```

启动前必须导出 `QQ_APP_ID` 和 `QQ_APP_SECRET`，缺失时 `bridge.js` 以退出码 78 结束，`run_loop.sh` 也会跟着退出。

### 环境变量总表

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `QQ_APP_ID` | 是 | — | QQ 机器人 AppID。只从环境变量读取，不写盘、不打日志 |
| `QQ_APP_SECRET` | 是 | — | QQ 机器人 AppSecret。只从环境变量读取，不写盘、不打日志 |
| `QQ_FORWARD_WEBHOOK_URL` | 否 | 见 `config.json` 的 `forwardWebhookUrl` | 入站 webhook 地址。设置后覆盖 `config.json`；为空则只记录日志、不转发（启动时有 WARN） |
| `QQ_FORWARD_WEBHOOK_SECRET` | 否 | — | webhook 密钥，作为请求头发送 |
| `QQ_FORWARD_WEBHOOK_HEADER` | 否 | `Authorization` | 携带密钥的头名称。若小写后等于 `authorization`，值为 `Bearer <secret>`，否则原样发送 `<secret>` |
| `QQ_REPLY_PORT` | 否 | `8787` | 本地回复服务端口 |
| `QQ_API_BASE` | 否 | `https://api.sgroup.qq.com` | QQ API 基础地址，一般仅测试用 |
| `QQ_TOKEN_URL` | 否 | `https://bots.qq.com/app/getAppAccessToken` | access_token 获取地址，一般仅测试用 |
| `QQ_HISTORY_DIR` | 否 | `data/history` | 会话历史存储目录 |
| `QQ_MEMORY_DIR` | 否 | `memory` | 长期记忆 markdown 文件目录 |
| `QQ_MEDIA_DIR` | 否 | `data/media` | 图片附件本地缓存目录 |
| `QQ_DEBUG_RAW_EVENTS` | 否 | 关闭 | 设为 `1` 时把原始事件写入 `logs/raw-events.jsonl`（详见「调试」） |

### config.json

`config.json` 提供默认值，可被上述环境变量覆盖：

```json
{
  "forwardWebhookUrl": "",
  "replyHost": "127.0.0.1",
  "replyPort": 8787,
  "apiBase": "https://api.sgroup.qq.com",
  "tokenUrl": "https://bots.qq.com/app/getAppAccessToken",
  "intents": 33554432
}
```

- `intents` = `1 << 25`（`GROUP_AND_C2C_EVENT`），即只订阅单聊与群 @ 消息事件。
- 回复服务监听地址固定从 `replyHost` 读取（默认 `127.0.0.1`，仅本机可达），端口可被 `QQ_REPLY_PORT` 覆盖。

## 启动 / 停止

```bash
export QQ_APP_ID=... QQ_APP_SECRET=...
export QQ_FORWARD_WEBHOOK_URL=... QQ_FORWARD_WEBHOOK_SECRET=...

./start.sh   # 后台拉起 run_loop.sh 守护进程
./stop.sh
```

### start.sh

- 校验 `QQ_APP_ID` / `QQ_APP_SECRET` 已导出，否则退出 1。
- 若 `run.pid` 存在且进程仍存活，打印 `already running` 并直接退出（不会重复启动）。
- 否则 `nohup setsid ./run_loop.sh &`，把守护进程 pid 写入 `run.pid`。

### stop.sh

- 读取 `run.pid`，`kill -- -<pid>` 杀整个进程组（失败则退回 `kill <pid>`），删除 `run.pid`。

### run_loop.sh（守护与重启）

```bash
while true; do
  s=$(date +%s); node bridge.js >> logs/bridge.log 2>&1; rc=$?
  echo "$(date -Is) bridge exited rc=$rc" >> logs/supervisor.log
  [ $rc -eq 78 ] && exit 78          # 缺环境变量：不再重启
  [ $(( $(date +%s) - s )) -gt 60 ] && d=2   # 稳定运行超过 60s 则重置退避
  sleep $d; d=$(( d*2 > 60 ? 60 : d*2 ))
done
```

- 崩溃后自动重启，退避从 2s 起翻倍，上限 60s；稳定运行超过 60 秒后重置为 2s。
- 退出码 78（缺少环境变量）视为配置错误，直接退出、不再重启。

### 断线重连（bridge.js 内部）

- 上线后按 `heartbeat_interval` 发送 `op 1` 心跳；心跳未收到 ACK 立即 `terminate` 触发重连。
- `op 7`（服务端要求重连）→ 关闭连接并重连；`op 9`（session 失效）→ 清空 `session_id`/`seq` 重新 Identify。
- 已有 session 时用 `op 6` Resume，否则 `op 2` Identify；`READY` / `RESUMED` 后退避重置为 1s。
- 重连退避 1s 起步、翻倍、上限 60s。
- 关闭码 `4914`/`4915`（机器人下线 / 被封）直接 `exit 1`；`4004`、`4006`、`4007`、`4009` 或 ≥ 4900 时清空 session 再重连。

### 日志

| 文件 | 内容 |
|---|---|
| `logs/bridge.log` | `node bridge.js` 的标准输出/错误：连接、转发、回复、媒体下载等 |
| `logs/supervisor.log` | 守护进程记录的每次退出（时间 + 退出码） |
| `logs/raw-events.jsonl` | 仅 `QQ_DEBUG_RAW_EVENTS=1` 时写入的原始事件 |

`logs/` 已被 gitignore。机器上没有 systemd，因此用 bash 循环做守护。

## 入站 payload（bridge → QQ 小企鹅）

`POST $QQ_FORWARD_WEBHOOK_URL`，`Content-Type: application/json`，携带密钥的头由 `QQ_FORWARD_WEBHOOK_SECRET` / `QQ_FORWARD_WEBHOOK_HEADER` 决定。失败（网络错误或非 2xx）最多尝试 3 次，间隔 1s、2s、4s。

单聊示例：

```json
{
  "type": "c2c",
  "openid": "USER_OPENID",
  "author": { "user_openid": "USER_OPENID" },
  "nickname": "昵称或null",
  "group_card": null,
  "content": "你好",
  "msg_id": "ROBOT1.0_xxx",
  "timestamp": "2026-10-14T11:00:00+08:00",
  "attachments": [],
  "history": [
    { "role": "user", "nickname": "alice", "member_role": null, "openid": "USER_OPENID", "content": "在吗", "timestamp": "2026-10-14T10:59:00+08:00" },
    { "role": "bot", "nickname": null, "member_role": null, "openid": null, "content": "在的", "timestamp": "2026-10-14T10:59:30+08:00" }
  ],
  "memory_path": "/opt/qq-bridge/memory/c2c-USER_OPENID.md"
}
```

群聊示例：

```json
{
  "type": "group",
  "group_openid": "GROUP_OPENID",
  "author": { "id": "...", "username": "...", "bot": false, "member_openid": "MEMBER_OPENID", "member_role": "member" },
  "nickname": "昵称或null",
  "group_card": null,
  "content": "@机器人 你好",
  "msg_id": "ROBOT1.0_yyy",
  "timestamp": "2026-10-14T11:00:00+08:00",
  "attachments": [
    {
      "content_type": "image/jpeg",
      "url": "https://...",
      "local_path": "/opt/qq-bridge/data/media/ROBOT1.0_yyy-0.jpg"
    }
  ],
  "history": [],
  "memory_path": "/opt/qq-bridge/memory/group-GROUP_OPENID.md"
}
```

### 字段表

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | 会话类型：`c2c`（单聊）或 `group`（群聊 @） |
| `openid` | string | 仅 `c2c`：发送者 openid（来自 `author.user_openid`） |
| `group_openid` | string | 仅 `group`：群 openid |
| `author` | object | 原始 QQ author 对象的浅拷贝，原样透传，未做删改。字段说明见「发送者字段」 |
| `nickname` | string \| null | `author.username`，为空时为 `null`（实际使用中 `username` 可能是空字符串） |
| `group_card` | string \| null | 群名片。代码上取 `author.card` → `member.card` → `member.nick`，但官方 v2 事件不返回这些字段，因此实际恒为 `null` |
| `content` | string | 消息文本，已 `trim()` |
| `msg_id` | string | 消息 ID（QQ 事件的 `id`），被动回复与历史都以它为键 |
| `timestamp` | string | 消息时间戳（QQ 事件原始值） |
| `attachments` | array | 附件数组，原样透传；图片附件额外带 `local_path` |
| `history` | array | 该会话的最近消息，**从旧到新**排列，**不含当前这条消息**。见「会话历史 history」 |
| `memory_path` | string | 该会话长期记忆 markdown 文件的绝对路径。见「长期记忆用法」 |

只有 `C2C_MESSAGE_CREATE` 与 `GROUP_AT_MESSAGE_CREATE` 会被转换和转发，其他事件类型直接忽略。

### attachments 与 local_path

`attachments` 是 QQ 事件里的附件数组，原样透传；其中每个图片附件在转发前还会被下载到本机，并多出一个 `local_path` 字段。

- **判断**：`content_type` 以 `image/` 开头且带 `url` 的附件会被下载；地址以 `//` 开头时先补成 `https:`。其他类型（视频、文件等）原样透传，不加 `local_path`。
- **保存位置**：`$QQ_MEDIA_DIR/<sanitize(msg_id)>-<序号>.<ext>`。`local_path` 是保存成功后的**绝对路径**；`<序号>` 是该附件在 `attachments` 里的下标（从 0 开始）；`<ext>` 由 `content_type` 决定：`jpeg→jpg`、`png→png`、`gif→gif`、`webp→webp`，其他一律 `bin`。`msg_id` 里的非法字符会替换成 `_`，不会发生路径逃逸。
- **失败**：下载失败（超时、超过 20MB、HTTP 错误、网络错误、写盘失败，或图片没有 `url`）时 `local_path` 为 `null`，只打印日志，**不影响消息转发**，后续附件继续下载。
- 单个图片下载超时 15 秒，大小上限 20MB（按 `Content-Length` 和实际收到的字节数双重判断）。
- 默认目录 `data/media/`（已 gitignore），可用 `QQ_MEDIA_DIR` 覆盖。

### 会话历史 history

- 数组，按时间**从旧到新**排列，**不含当前这条消息**：当前消息是在转发前一刻才写入历史的，所以 `history` 就是它的上文。
- 每个元素形如 `{"role":"user","nickname":null,"member_role":null,"openid":"OPENID","content":"文本","timestamp":"ISO 时间"}`：
  - `role`：`user` = 用户发来的消息；`bot` = 小企鹅通过 `/reply` 发出的回复。
  - `nickname`、`member_role`、`openid`：发送者信息（`bot` 的回复这几项为 `null`）。
  - `content`：消息文本，最多保留 2000 字符，超出部分截断。
  - `timestamp`：ISO 8601 时间字符串。
- 每个会话只保留最近 50 条，更早的自动丢弃。
- 落盘位置：`data/history/<type>-<id>.jsonl`，一行一条 JSON。`<type>-<id>` 中 `<id>` 对 c2c 是 `openid`，对群是 `group_openid`；非法字符统一替换为 `_`，不会发生路径逃逸。
- 目录可用 `QQ_HISTORY_DIR` 覆盖。
- 读写出错不致命：坏行被跳过，读取失败按空历史处理，转发照常进行。

## 回复接口 /reply（QQ 小企鹅 → bridge）

`POST http://127.0.0.1:8787/reply`（端口跟随 `QQ_REPLY_PORT`）。

### 鉴权

请求头 `X-Reply-Token` 必须等于 `reply_token` 文件内容。该 token 由 bridge 在首次启动时自动生成（24 字节随机数的 hex，文件权限 0600，已 gitignore），**它不是 QQ 凭据**，仅用于限制本机调用方。头不匹配返回 `401 {"ok":false,"error":"bad token"}`。

### 请求字段

```json
{"type":"c2c","openid":"USER_OPENID","msg_id":"ROBOT1.0_xxx","content":"回复内容"}
{"type":"group","group_openid":"GROUP_OPENID","msg_id":"ROBOT1.0_yyy","content":"回复内容"}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | 是 | `c2c` 或 `group`，决定走 `/v2/users/{openid}/messages` 还是 `/v2/groups/{group_openid}/messages` |
| `openid` | `c2c` 必填 | 目标用户 openid |
| `group_openid` | `group` 必填 | 目标群 openid |
| `msg_id` | 否 | 原消息 ID。带上则作为**被动回复**发出；不带则为**主动消息**（QQ 限制很严，一般不要用） |
| `content` | 是 | 非空字符串，回复内容 |

### 响应字段

```json
{
  "ok": true,
  "parts_sent": 3,
  "parts_total": 6,
  "truncated": true,
  "result": { "id": "..." },
  "results": [{ "id": "..." }, { "id": "..." }, { "id": "..." }]
}
```

| 字段 | 说明 |
|---|---|
| `ok` | 是否全部发送成功 |
| `parts_sent` | 实际发出去的消息条数 |
| `parts_total` | 按 1500 字拆分，完整内容共需要多少条 |
| `truncated` | 最后一条是否因条数上限被截断（追加 `\n…（内容过长，已截断）`） |
| `result` | 第一条发送的结果，仅为兼容保留 |
| `results` | 每条发送的结果数组 |

错误响应：`400` 参数缺失或 JSON 非法；`401` token 错误；`404` 非 `POST /reply`；`502` QQ API 报错，此时 body 额外带 `error`、`detail`，且 `parts_sent` 仍表示实际发出去的条数。另有 `GET /health` 返回 `{"ok":true}`。

### 1500 字拆分

- 单个 QQ 消息内容上限按 1500 字符处理，超长内容自动拆成多条依次发出，每条各自 `msg_seq + 1`。
- 拆分顺序：优先按段落（`\n\n`，且保留分隔符），其次按行（`\n`），最后硬切。每一段都保留其尾部分隔符，因此 `parts.join('')` 能还原原文。

### 被动回复的条数与时间上限

被动回复按 `msg_id` 计数，**包含之前已经为这条消息发出去的消息**：

| 场景 | 时间窗口 | 条数上限 |
|---|---|---|
| `c2c` 被动回复 | 60 分钟 | 4 条 / 每个 `msg_id` |
| `group` 被动回复 | 5 分钟 | 5 条 / 每个 `msg_id` |
| 主动消息（不带 `msg_id`） | — | 5 条 |

超出上限时只发送允许的条数，并把最后一条截断到以 `\n…（内容过长，已截断）` 结尾（该条总长仍 ≤ 1500）。计数基于 bridge 进程内的 `msg_seq` 表，重启后清零。

详见 QQ 官方文档：[消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)。

### 其他行为

- 某一条发送失败则**立即停止**发送后续部分；已发出的部分照常写回会话历史。
- 拆分后的整段回复在会话历史里只记**一条** `role: "bot"` 记录（保存实际发出去的全文）。
- 请求体上限 1MB，超出直接断开连接。

### reply.sh 命令行用法

```bash
./reply.sh c2c  <openid>  <msg_id|-> 回复内容...
./reply.sh group <group_openid> <msg_id|-> 回复内容...
```

- 需要至少 4 个参数（`type`、目标、`msg_id`、内容），内容可以是多个词。
- `msg_id` 传 `-` 表示不带 `msg_id`（主动消息）。
- 自动读取 `reply_token` 作为 `X-Reply-Token`，请求地址为 `http://127.0.0.1:${QQ_REPLY_PORT:-8787}/reply`，原样打印 HTTP 响应。

示例：

```bash
./reply.sh c2c USER_OPENID ROBOT1.0_xxx 你好，这是被动回复
./reply.sh group GROUP_OPENID - 主动消息示例
```

## 长期记忆用法

- 每条 payload 都带 `memory_path`：本机上一个 markdown 文件的**绝对路径**，每个会话一个文件（命名规则同 history，`<type>-<id>.md`，如 `c2c-U.md`、`group-G.md`）。
- 这是小企鹅的长期记忆：由她用自己的文件工具直接读写。**bridge 不读也不改内容**，只在文件不存在时创建一个空文件（已存在的文件不会被截断或重写）。
- 默认目录 `memory/`，可用 `QQ_MEMORY_DIR` 覆盖，支持自动创建多级子目录。
- `memory/` 下的文件已 gitignore（`memory/.gitkeep` 占位保证目录存在），记忆内容不会进入 git。
- 创建文件失败只是打日志，`memory_path` 仍会照常返回。

## 发送者字段

- `author`：原始 QQ author 对象，原样透传，未做任何删改。
- `nickname`：取自 `author.username`；为空时（例如用户没有设置昵称）为 `null`。实际使用中 `username` 可能是空字符串。
- `group_card`：恒为 `null`。QQ 官方机器人 API v2 的事件和群成员接口都没有群名片（card）字段，只有昵称；群成员接口 `GET /v2/groups/{group_openid}/members/{member_openid}` 虽然返回 username，但仅白名单可用（错误码 11253），bridge 未调用。

按官方文档 [group_at_message_create](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)，author（User）的字段如下：

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

## 调试

设置 `QQ_DEBUG_RAW_EVENTS=1` 时，bridge 会把未转换的原始事件（`{ "t": 事件名, "d": 事件体 }`）逐行追加写入 `logs/raw-events.jsonl`，默认关闭。该文件可能包含 message_scene 中的 auth_token，属于敏感数据，**不要提交到 git**（`logs/` 已在 gitignore 中）。

- dump 发生在 payload 转换**之前**，因此除 `READY` / `RESUMED` 外的所有分发事件（含单聊、群 @、以及 bridge 不转发的其它事件）都会原样落盘。
- 写入失败只打日志，不影响消息处理。
- 排查「字段为什么是 null」时：先看 `raw-events.jsonl` 里 QQ 实际下发了什么，再对照 `lib.js` 的 `toPayload()`。
- 常用辅助手段：`logs/bridge.log` 看连接/转发/媒体日志，`logs/supervisor.log` 看崩溃与退出码，`./reply.sh` 手工触发一次回复，`curl localhost:8787/health` 确认回复服务存活。

## 测试

```bash
node test/test.js
```

测试使用临时目录（`QQ_HISTORY_DIR` / `QQ_MEMORY_DIR` / `QQ_MEDIA_DIR` 指向系统临时目录）和一个 mock QQ API，覆盖：

- payload 转换：c2c / group、`nickname` 与 `group_card` 的各种取值、非法事件返回 `null`、author 深拷贝。
- history：key 生成与路径逃逸防护、会话隔离、时间顺序、当前消息不在 history 中、2000 字符截断、坏行跳过、保留最近 50 条、IO 错误不致命。
- memory：每会话一个文件、按需创建空文件、不覆盖已有内容、`QQ_MEMORY_DIR` 覆盖与嵌套目录、IO 错误不致命。
- 回复服务：token 401、参数 400、`msg_seq` 自增、短消息单条、段落与行边界拆分、硬切、c2c 4 条 / 群 5 条 / 主动 5 条上限与截断、按已发条数扣减、部分失败停止并记录、bot 历史写入。
- 媒体：各类 `content_type` 对应扩展名、协议相对地址补 `https:`、`msg_id` 净化、非图片跳过、缺 `url` 与下载失败置 `null` 且不影响其他附件。

全部通过时输出 `ALL TESTS PASSED`。注意 `package.json` 里的 `npm test` 仍是占位脚本，请直接运行上面的命令。

## 文件结构

```
qq-bridge/
├── bridge.js            # 入口：WebSocket 连接、心跳、重连、事件转换与转发
├── lib.js               # 配置加载、日志、toPayload、token 管理、QQ API 封装
├── reply_server.js      # /reply 与 /health HTTP 服务、拆分与条数上限逻辑
├── history.js           # 会话历史读写（jsonl）
├── memory.js            # 长期记忆文件路径与按需创建
├── media.js             # 图片附件下载
├── config.json          # 默认配置（可被环境变量覆盖）
├── start.sh             # 启动守护进程
├── stop.sh              # 停止（杀进程组）
├── run_loop.sh          # 守护循环：崩溃重启 + 退避
├── reply.sh             # 命令行调用 /reply
├── test/test.js         # 测试
├── package.json         # 依赖声明（ws）
├── package-lock.json    # 依赖锁定
├── run.pid              # 守护进程 pid（gitignore）
├── reply_token          # /reply 鉴权 token，自动生成（gitignore）
├── logs/                # 日志目录（gitignore）
│   ├── bridge.log           # bridge 主日志
│   ├── supervisor.log       # 守护进程退出记录
│   └── raw-events.jsonl     # QQ_DEBUG_RAW_EVENTS=1 时的原始事件（敏感）
├── memory/              # 长期记忆（gitignore，保留 .gitkeep）
├── data/                # 运行时数据（gitignore）
│   ├── history/             # 会话历史 jsonl
│   └── media/               # 下载的图片附件
└── node_modules/        # 依赖（gitignore）
```

### 已 gitignore 的内容

| 路径 | 说明 |
|---|---|
| `node_modules/` | 依赖 |
| `logs/` | 全部日志（含敏感的 raw-events.jsonl） |
| `reply_token` | `/reply` 鉴权 token |
| `run.pid` | 守护进程 pid |
| `.env` | 预留的环境变量文件 |
| `data/` | 会话历史与媒体缓存 |
| `memory/*`、`!memory/.gitkeep` | 长期记忆内容 |
