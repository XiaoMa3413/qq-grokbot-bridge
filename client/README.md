# Grok 云电脑轻量客户端

客户端版本 **1.0.0**，使用 Python **3.10+ 标准库**，不需要 Node、npm、第三方包或常驻进程。服务端保持原有部署；完整功能要求桥接 **1.8+**。客户端与服务端版本独立。

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

将例行任务提供的原始 webhook JSON 保存为私有 `task.json`，不要根据正文重建路由。该文件保留 `job_id/type/openid或group_openid/msg_id/reply_deadline/reply_policy`；完整历史可以继续由 Grok 从本次输入读取，客户端不会重新下载。

```bash
python qq_bridge.py --config private/client.json --task private/task.json status
python qq_bridge.py --config private/client.json --task private/task.json progress --text '好的，我这就去查。'
# 实际完成工作后，将答案写入 UTF-8 文件：
python qq_bridge.py --config private/client.json --task private/task.json final --text-file private/answer.txt
```

简单任务直接 `final`，无需先发进度。默认操作 ID 分别为 `progress`、`final`。确实需要另一条进度时显式使用稳定的 `--operation progress-2`，不要在错误后不断换 ID。

附件与最终回复一起交付：

```bash
python qq_bridge.py --config private/client.json --task private/task.json final --text '报告见附件。' --file artifacts/report.pdf
python qq_bridge.py --config private/client.json --task private/task.json final --voice artifacts/reply.wav
python qq_bridge.py --config private/client.json --task private/task.json final --image artifacts/result.png
```

每种附件选项可重复。图片只支持 PNG/JPEG；语音检查 SILK/WAV/MP3/FLAC 扩展名及文件头，不进行完整解码或转码。普通文件名可使用中文。图片与媒体合计最多 5 个，进度、拆分正文及每个附件共享 QQ 剩余配额。

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
- `timings[]`：`status/upload_status/upload/reply/health` 每次 HTTP 请求的状态及耗时。上传与 QQ 最终发送分开记录。
- `replayed`：服务端命中了已有段；`local_replayed`：客户端命中本地已确认成功结果。
- 只有 HTTP 2xx 且 `ok:true`、计数完整才确认发送。不能把 `doctor`、上传或工具安装成功当作真实 QQ 收发成功。

这些数据测不到 webhook 到平台开始执行的排队/唤醒时间，也不包含 Grok 调用工具之前的阅读和思考。前后对比时分别记录用户发消息、Grok 开始执行、首段到达、最终结果到达，使用相近任务、多次观察，不承诺固定提速比例。诊断输出可能反映任务状态，勿直接公开生产日志。

客户端不更改会话记忆与导入资料协议。Grok 继续按现有规则处理这两层数据；本版只封装高频回复与附件路径。技能调用说明见 [AGENT_GUIDE.md](AGENT_GUIDE.md)。

开发者在项目根目录运行 `npm run test:client`；需可执行的 `python`（或通过环境变量 `PYTHON` 指定解释器），测试不需要真实 QQ/Grok 凭据。
