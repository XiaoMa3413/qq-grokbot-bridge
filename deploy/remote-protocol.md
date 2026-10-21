# 远程协议与恢复行为

所有 `/reply`、`/jobs/...` 请求都需要 `X-Reply-Token`；公网只使用 HTTPS，不跟随重定向、不关闭证书校验。密钥不放在 URL 或 webhook 载荷中。`GET /health` 无需鉴权，只暴露版本、连接健康及任务计数，不含聊天内容。

## 入站确认与实例保护（v1.2.1）

远程模式将 QQ session 和已确认的 sequence 保存在队列目录的 `gateway-session.json`，作为私有运行数据保存（Linux 文件权限为 600）。先保存任务，再提交网关检查点，然后才允许后续心跳或 Resume 使用新序号。任务或检查点写入失败时，`/health` 返回 503，`reason` 为 `ingress-persistence-failed`；桥接保留失败事件、断开当前连接并退避重试，不确认后续事件。写入恢复后重新连接；进程重启则从已保存的检查点尝试 Resume，重放事件通过原任务 ID 去重。

检查点包含 QQ 会话信息，应与队列一起保管和备份，不能手动修改其序号。QQ 会话恢复依赖平台仍接受该 session 并保留可重放的事件；session 失效、事件超出平台保留范围或尚未落盘就发生不可恢复的故障时，仍可能无法补齐消息，不保证无限期恢复。群内非 @ 上下文及本机模式仍为尽力处理，不具有上述入站持久化保证。

Windows/Linux 桥接启动时，先对规范化后的队列目录获取本机进程锁，再读取任务、恢复回复状态和连接 QQ。重复实例以退出码 78 停止，即使使用不同回复端口或目录别名也不能共用该队列。锁由操作系统管理，退出和崩溃后自动释放。锁用于同一主机上直接运行的实例，不支持不同容器或主机共享队列；队列应使用本地独立目录。升级时必须先停止不具备该锁的旧版本。

## 持久化与任务顺序

设置 `QQ_REPLY_PUBLIC_URL` 后启用持久化任务。QQ 消息先写入 `data/jobs/<job_id>.json`，再下载附件、附加历史和记忆并转发。重复网关事件使用同一任务；同会话按接收顺序等待上一任务完成，不同会话最多同时转发 4 个任务。

HTTP 408、429、5xx 或网络失败会指数退避重试，最多间隔 60 秒，并遵守 `Retry-After`；其他 HTTP 错误终止该任务。webhook 返回 2xx 后，只等待回传，不因回复慢而重新触发 Grok。若平台已接收请求但网络响应丢失，仍可能重复触发 Grok，不能保证平台只执行一次；回传防重用于避免同一任务重复发 QQ。

转发和回复受 QQ 消息原始时间限制：群聊 5 分钟、单聊 60 分钟。排队不会延长时限；到期返回 410，不改成主动推送。规则依据：[腾讯消息接口](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)。

任务默认保留至回复截止时间后 7 天，最多 10,000 项；满额明确报错。运行数据可能包含会话内容，应由主机文件权限保护并备份。`QQ_JOBS_DIR` 可更改存储目录；一个目录只允许一个桥接进程使用。历史按原有条数保留，媒体目录目前不自动清理，请根据磁盘容量管理。

## webhook 新字段

```json
{
  "job_id": "<64位十六进制ID>",
  "reply_url": "https://<域名>:<端口>/reply",
  "reply_deadline": "2026-10-21T10:00:00.000Z",
  "reply_policy": { "segmented": true, "next_reply_seq": 1, "message_limit": 4, "progress_max_chars": 1500, "reserve_final": 1 },
  "memory_url": "https://<域名>:<端口>/jobs/<job_id>/memory",
  "memory": { "content": "该会话当前记忆", "etag": "\"<内容哈希>\"" },
  "attachments": [
    { "content_type": "image/png", "download_url": "https://<域名>:<端口>/jobs/<job_id>/media/<asset_id>" }
  ]
}
```

原有 `type`、目标 ID、`msg_id`、`content`、`history` 保留。远程载荷移除 `local_path`、`memory_path`；引用、最近上下文、群图片缓存中已成功下载的图片也会附加 `download_url`。原始 QQ 附件 URL 保留作兼容；需要本地缓存时优先使用鉴权下载地址。下载 URL 不含密钥，需在请求头提供密钥。

## 分段回复与防重（v1.4）

每个任务可以先回传进度，再提交一次最终回复。Grok 在开始耗时操作前主动 POST 第一段，确认成功后继续处理，不必等工作全部完成。桥接不自动代发确认；云电脑尚未唤醒时无法提前获得 Grok 的进度回传。

第一段（保留本次原始路由）：

```json
{
  "job_id": "<原任务ID>", "type": "c2c", "openid": "<原用户ID>", "msg_id": "<原消息ID>",
  "reply_seq": 1, "final": false, "content": "好的，我这就给你找。"
}
```

完成后发送第二段：

```json
{
  "job_id": "<原任务ID>", "type": "c2c", "openid": "<原用户ID>", "msg_id": "<原消息ID>",
  "reply_seq": 2, "final": true, "content": "这是找到的新闻……"
}
```

`reply_seq` 从 1 连续递增，必须是 1–5 的整数；`final` 必须是布尔值，省略等于 true。非最终段必须显式提供序号，只允许一条不超过 1500 字符的文字，不接受图片。最终段支持拆分文字和图片。建议只发一次开场进度与一次最终结果，短问题直接回复最终段，不机械添加进度提示。

所有段共用原 QQ 消息的被动回复配额和截止时间，不因进度而续期。项目采用私聊 4 条、群聊 5 条的上限；每个非最终段消耗一条，至少保留一条给最终结果。最终长文和图片按剩余配额截断/跳过，检查 `truncated`、`images_skipped`。QQ 的 `msg_id + msg_seq` 防重规则见[腾讯接口说明](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)。

每段响应包含 `reply_seq`、`final`、`messages_used`、`messages_remaining`；成功非最终段还返回 `next_reply_seq`。等待当前段成功后再提交下一段，不并行提交。重试原序号必须保留原正文、图片与 final 值；旧段的成功重放不会使已关闭任务重新打开。跳号、改内容、在最终段后追加或耗尽配额返回 409。首次发送的段到期返回 410，已保存段仍可重放查询结果。

进度发送成功后任务保持等待最终回复，后续同会话任务继续排队。任何段失败会保留结果并终止本任务的后续发送；发送中断进入 `uncertain` 时也不能补发下一段。每个 QQ 消息序号在实际发送前持久化，重启后不会从 1 重新开始。

## 兼容旧版的一次最终回复

```json
{
  "job_id": "<原任务ID，建议携带>",
  "type": "group",
  "group_openid": "<原群ID>",
  "msg_id": "<原消息ID>",
  "content": "最终回复"
}
```

不提供 `reply_seq` 和 `final` 等价于第 1 段最终回复。旧版 Grok 的纯文字回调可不带 `job_id`，服务器会按原 `type`、目标 ID、`msg_id` 查找已登记任务；不能更改收件人。相同内容的重复回调返回保存的结果和 `replayed:true`，不再次发 QQ。不同内容返回 409；未知任务/路由返回 404；到期返回 410。已发过进度的任务必须显式使用正确的后续序号，不能再用无序号的旧格式发送最终结果。

服务器在发送 QQ 前保存意图。进程在发送过程中中断时，重启后该任务标为 `uncertain`，返回 409 并提示不要重发。无法单靠桥接判断 QQ 是否已经接受消息，因此不宣称跨平台“恰好发送一次”。部分发送失败的结果也会保存；重复请求返回原失败结果，不重新发送已完成的部分。

## 发图片

`POST /reply` 可携带 `images_base64`，`content` 可选：

```json
{
  "type": "c2c", "openid": "<原用户ID>", "msg_id": "<原消息ID>",
  "content": "图片说明",
  "images_base64": [{ "name": "result.png", "data": "<纯base64，不含data:前缀>" }]
}
```

只接受 PNG/JPEG 文件头和对应扩展名，文件名使用 ASCII 字母、数字、下划线、点和连字符。每次最多 5 张、解码后的总大小不超过 5 MiB，请求体上限 8 MiB。文字先发，图片后发，共用单聊 4 条（当前保守上限）/群聊 5 条的配额；响应包含发送及跳过数量。远程 `image`、`images` 本地路径仍被拒绝，不提供服务器任意文件读取或远程 URL 拉取接口。

## 读写记忆

- `GET /jobs/<job_id>/memory` → `{ok, content, etag}`，响应头也包含 `ETag`。
- `PUT /jobs/<job_id>/memory`，正文 `{ "content": "完整的新Markdown内容" }`，请求头 `If-Match` 填最近读取的 etag。
- 缺少 `If-Match` 返回 428；已有并发修改返回 412，需要重新读取、合并后再更新。
- 内容最多 64 KiB，不能指定文件路径；只能操作该任务对应会话的记忆。

记忆和媒体访问随任务到期失效。媒体必须来自该任务已登记且位于媒体目录中的缓存文件，目录穿越和越界符号链接不被接受。需要保存结果时，在任务时限内下载到 Grok 云电脑。

## 状态与日志

`GET /jobs/<job_id>` 返回转发状态、尝试次数、回复状态、错误摘要和截止时间。成功进度后的 `reply` 为 `awaiting_final`；`reply_closed` 表示因最终回复或失败结束，`reply_final` 表示最后接收的段是否为最终段。`replies` 列出各段序号、final、发送状态和 HTTP 状态，不返回正文；`next_reply_seq`、`messages_used`、`messages_remaining` 用于继续前预检。发生 sending/uncertain、`reply_closed:true`、HTTP 失败或到期时均不要提交新段；`next_reply_seq` 只是编号，不代表允许继续。

`npm run status` 在桥接主机查看健康及队列计数；`journalctl --user -u qq-grokbot-bridge -f` 查看日志。`reply HTTP 401/400/409/...` 可区分鉴权、协议和防重问题；日志不打印回复密钥或正文。

程序收到 SIGTERM/SIGINT 后停止接收新请求及重连，等待正在执行的回调/转发完成，最多 30 秒。超时退出后的发送状态按上述 `uncertain` 规则处理。

## 升级与回退

v1.4 可读取旧版任务，旧版已完成回复仍按最终回复处理。切换前检查在途任务，停止旧进程，备份配置和整个任务目录，不能让两个版本共用队列运行。向旧版回退前须等待所有开放的分段任务完成或到期，并保存新版本运行数据；旧版不理解 `final:false`，会把已发送进度误当成任务完成。不要只恢复旧队列快照后重新发送，快照之后已经发送的 QQ 消息可能重复。
