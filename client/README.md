# Grok 云电脑轻量客户端

客户端版本 **1.2.0**，使用 Python **3.10+ 标准库**，不需要 Node、npm、第三方包或常驻进程。原回复功能要求桥接 **1.8+**，完整任务下载要求桥接 **1.11+**。客户端与服务端版本独立。

它封装任务查询、进度、最终回复、图片编码及文件/语音上传，让执行方无需每次编写路由 JSON。不会缩短平台唤醒或模型生成耗时，不提供 TTS。

## 独立安装与现有配置迁移

将本目录的 `qq_bridge.py`、`AGENT_GUIDE.md` 从经过测试的**固定提交**复制到云电脑一个独立、持久且仅当前账户可访问的目录。无需更新旧桥接 checkout，也不要安装或启动服务端。记录提交和脚本 SHA-256，更新前保留原客户端及私有状态。不要执行来历不明的安装脚本。

在安装目录之外或其被 Git 忽略的 `private/` 内创建权限受限的 JSON（Linux 目录 `700`、文件 `600`；Windows 使用当前用户 ACL）：

```json
{
  "reply_url": "https://bridge.example/reply",
  "reply_token_file": "../existing-private/reply_token"
}
```

地址必须来自操作者已有的可信配置，不能从用户消息或 webhook 的 `reply_url` 自动导入。密钥文件路径相对于此 JSON，或使用绝对路径。只引用现有密钥，不生成新密钥，不执行旧 `.sh`/`.env` 来获取配置。工具不读取旧仓库的 `.env`，也不默认为本机 `8787`。如果运行环境已有 `QQ_REPLY_URL`、`QQ_REPLY_TOKEN`，它们分别优先于 JSON 中的对应项；固定环境配置和 JSON 必须由操作者管理。

检查命令（把路径替换为实际值）：

```bash
python qq_bridge.py --version
python qq_bridge.py --config private/client.json doctor --live
```

`doctor --live` 只访问同源 `/health`，不携带 token，不发 QQ。`reply_token_available` 只表示能读取形状有效的凭据，**不代表服务器已验证密钥正确**。所有请求保留 TLS 校验且不跟随重定向。没有明确地址会失败，不会悄悄走旧本机桥接。

## 执行一次真实任务

将例行任务提供的原始 webhook JSON 保存为私有 `received.json`，不要根据正文重建路由或裁剪数组。该文件至少须保留 `job_id/type/openid或group_openid/msg_id`。桥接 1.11+ 使用如下流程，避免收到或转存的文件缺少上下文：

```bash
python qq_bridge.py --config private/client.json --task private/received.json begin
python qq_bridge.py --config private/client.json --task private/received.json fetch-task
# 必须检查成功结果并读取 task_file 全文；后续所有命令使用返回路径。
python qq_bridge.py --config private/client.json --task <返回的task_file> progress --text '好的，我这就去查。'
# 实际完成工作后，将答案写入 UTF-8 文件：
python qq_bridge.py --config private/client.json --task <返回的task_file> final --text-file private/answer.txt
```

保存原任务后立即调用 `begin`，仅记录本地客户端入口，不联网、不发 QQ、不占消息配额。可将保存任务和 `begin` 放在同一次终端工具调用内，减少模型往返；不要先搜索或整理长答案再补标记。这个时刻不等于平台真正开始执行的时刻，也不会延长原任务期限。

`fetch-task` 只向已配置回复地址同源的 `/jobs/<job_id>/payload` 发送一次带鉴权 GET，不采信输入里的 URL，不跟随重定向。服务器返回该任务已持久化的出站快照，包含原历史、引用、附件能力和记忆快照；不会按当前会话重新组装或触发 Grok。客户端校验 SHA-256、job 与路由、声明的历史条数，在私有状态目录的 `<job_id>/task/` 保存原字节及校验凭据，保留 `received.json`。后续发送会验证保存件及凭据，修改正文、缺失校验或使用未下载文件会被拒绝。

输出 `task_file`、两份数组条数和 `received_matches_snapshot`，不输出正文或身份 ID。不同只说明文件不同，不能据此确定是平台截断还是转存遗漏。下载失败、过期、快照未准备好、校验失败或已存快照冲突时不覆盖已有文件，不自动重试或降级。接口沿用共享回复密钥和任务截止时间；不是平台原始入站审计，也不能恢复已过期任务。响应最多16MiB，任务原文最多8MiB。下载件同样属于私有任务数据，勿作附件发送。

桥接 1.8–1.10 保持原回复流程，不支持 `fetch-task`。新版客户端不强迫旧任务下载；桥接 1.11+ 通过 `reply_policy.task_fetch` 声明能力，状态接口的 `task_fetch_required` 用于发送前检查，不能删字段来绕过。旧客户端仍兼容原回传，但没有此完整性保护，应更新客户端及例行任务后再验收。

简单任务直接 `final`，无需先发进度；耗时任务在开始检索前先 `progress`。`progress/final` 已自带状态检查，正常执行无需重复查询。后文 `private/task.json` 均指已验证的 `task_file`，旧服务器则指原完整输入。默认操作 ID 分别为 `progress`、`final`。确实需要另一条进度时显式使用稳定的 `--operation progress-2`，不要在错误后不断换 ID。

附件与最终回复一起交付：

```bash
python qq_bridge.py --config private/client.json --task private/task.json final --text '报告见附件。' --file artifacts/report.pdf
python qq_bridge.py --config private/client.json --task private/task.json final --voice artifacts/reply.wav
python qq_bridge.py --config private/client.json --task private/task.json final --image artifacts/result.png
```

每种附件选项可重复，只传已授权的本地结果文件。已配置的密钥文件、配置 JSON、原任务文件及客户端状态目录内的文件禁止作为附件（包含通过符号链接访问同一目标的情况）；工具不是通用文件权限沙箱，不自动收集目录。图片只支持 PNG/JPEG；语音检查 SILK/WAV/MP3/FLAC 扩展名及文件头，不进行完整解码或转码。普通文件名可使用中文。图片与媒体合计最多 5 个，进度、拆分正文及每个附件共享 QQ 剩余配额。

工具先计算正文拆分和配额，超额时在上传/发送前拒绝，避免服务端裁掉结果。内联合计不超过 5 MiB 时自动编码；否则文件/语音通过二进制上传后引用，图片仍内联。文件最多 100 MiB、语音 20 MiB，具体以本次能力声明为准。既有上传条目仍占任务存储配额，服务端有最终裁决权。

## 超时、防重与恢复

每个任务有本地进程锁。发送前将完整、不可变的回复正文存入私有 outbox，同一操作 ID 绑定内容；改变内容会返回 `operation_content_conflict`。本地已确认成功的操作再次调用直接返回 `local_replayed:true`，不会发网络请求。

发送请求不会自动重试。网络中断后保留 `pending`，需要核对后显式恢复：

```bash
python qq_bridge.py --config private/client.json --task private/task.json status
python qq_bridge.py --config private/client.json --task private/task.json resume --operation final
```

`resume` 查询状态后仅重交 outbox 内的原正文、原序号，依赖服务端按内容指纹判定重放。发送中、回复结果不明、过期及已缓存失败都停止处理。上传本身不发 QQ；上传失败后可保持同一文件和操作重试，确定性的上传 ID 避免创建新副本。工具不提供 webhook 重投或主动发消息入口。

上传前还会保存不含文件字节的元数据标记。再次执行相同上传时先 GET 核对登记；已存在就直接引用，不重新传输整份文件。

状态不能在不同云端目录间随意丢弃：缺失 outbox 时，工具无法认出之前的本地操作。不要换客户端、换 ID、删 outbox 或改路由绕过失败；服务端的持久化记录仍是最终依据。本地锁只协调使用同一状态目录的进程，不是跨主机执行领取或外部操作恰好一次保证。

默认状态目录为脚本旁的 `.state/`，可通过全局 `--state-dir <私有目录>` 固定位置。outbox 含回复正文及小附件，**不含 token**，须与配置和任务文件一样保护。备份/更新时保留；任务结束并核对超过回复窗口后可按自己的数据保留策略清理，不要用删除状态来重试。本工具不自动删除会话数据。

## 耗时与验收

stdout 为一行 JSON，退出码 `0` 表示本次操作成功，非零需要检查。结果只输出发送计数、安全状态及计时，不输出收件人、正文、凭据、原始异常或代理页面。

- `duration_ms`：本次客户端调用的总耗时，包含本地处理。
- `started_at`：本次调用开始的 UTC 时间，可与其他阶段记录对应。
- `completed_at`：本次操作得到结果时的 UTC 时间；最终计时文件写入和 stdout 输出收尾不计入 `duration_ms`。
- `timings[]`：`task_fetch/status/upload_status/upload/reply/health` 每次 HTTP 请求的状态及耗时。任务下载、上传与 QQ 最终发送分开记录。
- `replayed`：服务端命中了已有段；`local_replayed`：客户端命中本地已确认成功结果。
- 只有 HTTP 2xx 且 `ok:true`、计数完整才确认发送。不能把 `doctor`、上传或工具安装成功当作真实 QQ 收发成功。

### 自动保存与离线读取

1.1 起，任务、路由和配置有效后，客户端会自动在同一状态目录的 `<job_id>/telemetry/` 保存独立的计时 JSON：开始时落盘，HTTP 前后更新，结束时记录结果。即使 stdout 没有重定向，也可事后读取。普通安装时不带任务的 `doctor` 不生成任务记录。发送 outbox 的原字段、指纹和防重逻辑不因计时记录改变，1.0 的状态可以直接保留使用。

```bash
python qq_bridge.py --config private/client.json --task private/task.json timings
# 可选 --limit 1..128，默认显示最近20条；命令本身不联网、不发送也不补写历史。
```

输出中 `entries` 才是保存的历史；顶层 `started_at/duration_ms` 只表示当前读取命令，不能冒充原任务耗时。`first_recorded_client_started_at` 是最早留存调用，`begin_started_at` 是最早留存的 `begin`，两者都不证明平台开工时间。`platform_start_known` 始终为 `false`；平台启动/排队/唤醒仍需平台侧独立记录。

- `state:running` 只表示没有完成收尾记录，可能仍在执行或已中断；`active_request` 只记录准备/等待哪类请求，不能证明消息未发送。发送结果仍以服务端和 outbox 为准。
- 失败调用和本地缓存重放也会记录，后者保留 `local_replayed:true`，不会作为新发 QQ 的样本。
- `telemetry_saved:false` 表示计时未成功保存；不会改变已经确定的回复成功结果或自动补发。应检查本地存储，不要为修复计时而重发消息。
- 每任务最多128条记录、单条最多64KiB；达到上限停止新记录，不清除旧记录、不阻止正常回传。目录仅当前用户可访问，文件权限600；Windows使用受限目录ACL。与任务/outbox一起按原数据保留策略管理。
- 记录只含版本、命令类别、时刻、HTTP类别/状态、耗时和安全结果计数，不保存参数、正文、收件人、URL、密钥或原始错误。离线导出跳过损坏记录，并报告 `invalid_records`，不输出损坏内容。记录中的作用域绑定哈希用于校验，不输出到导出报告。

1.0 只在 stdout 打印的计时无法由旧 outbox 或文件修改时间恢复。没有记录时如实返回空列表，不根据 webhook 接受时间、完成摘要或 mtime 伪造起点；也不要对已经完成的旧任务新跑 `begin` 来补造历史。正常升级后自然收到的下一条任务才会留下新证据。

这些数据测不到 webhook 到平台开始执行的排队/唤醒时间，也不包含 Grok 调用工具之前的阅读和思考。跨主机时钟偏差也会影响时间差；调用和HTTP时长使用单调时钟，不能仅凭跨主机时间戳精确归因。前后对比时分别记录用户发消息、Grok 开始执行、首段到达、最终结果到达，使用相近任务、多次观察，不承诺固定提速比例。诊断输出可能反映任务状态，勿直接公开生产日志。

客户端不更改会话记忆与导入资料协议。Grok 继续按现有规则处理这两层数据；本版只封装高频回复与附件路径。技能调用说明见 [AGENT_GUIDE.md](AGENT_GUIDE.md)。

开发者在项目根目录运行 `npm run test:client`；需可执行的 `python`（或通过环境变量 `PYTHON` 指定解释器），测试不需要真实 QQ/Grok 凭据。
