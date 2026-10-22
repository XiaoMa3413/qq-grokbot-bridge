# 文件发送与语音回复（v1.8）

持久化远程模式支持 Grok 回传普通文件和已生成的音频，作为最终回复的一部分发送，沿用原任务路由、鉴权、截止时间、配额和回调防重。原有文字和 `images_base64` 保持兼容。

## QQ 能力与权限

实现依据腾讯官方 SDK 固定版本的[小文件上传](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/protocol/api/media.ts)、[分片上传](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/protocol/api/media-chunked.ts)和[发送接口](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/QQBot.ts)。SDK 提供私聊/群聊的 `sendVoice` 和 `sendFile`，文件接口注明需要文件消息权限。较早的 [bot-docs](https://github.com/tencent-connect/bot-docs/blob/e603b92cfc77487e5415e32c6eee6bf88bd05f5c/docs/develop/api-v2/server-inter/message/send-receive/rich-media.md)仍将文件和 base64 标为未开放，存在更新不同步。

桥接实现了两种场景的上传/发送路径，不代表当前账号已获全部权限。文件权限、实际大小/日额度和音频可播放性，以 QQ 接口及客户端验收为准。失败不自动换账号、改收件人、改成主动消息或重复发送。

## 范围与限制

| 项目 | 桥接限制 |
|---|---|
| 普通文件 | 单个最大 100 MiB；桥接不执行或解析内容，QQ 仍可按权限或格式拒绝 |
| 语音 | 单个最大 20 MiB；扩展名与头部匹配的 SILK/WAV/MP3/FLAC |
| 内联 base64 | 图片与文件/语音解码后合计最多 5 MiB；JSON 最多 8 MiB |
| 最终回复附件 | 图片、文件、语音合计最多 5 个，并受剩余消息配额约束 |
| 上传库 | 每任务最多 5 个条目、合计 100 MiB；未登记的遗留二进制也占空间预算 |
| 配额与期限 | 私聊 4 条/60 分钟，群聊 5 条/5 分钟；进度、拆分文字和每个附件共同计数，上传和排队不续期 |

音频头部检查不是完整解码验证。需要广泛兼容时优先提供 QQ 可播放的 SILK，其他格式须实测。桥接不生成声音、不自动转码，没有内置 TTS 供应商或默认收费服务。Grok 可上传自己生成或由操作者选定工具生成的音频；没有可用音频时不能声称已发语音。

文件名支持中文，UTF-8 最多 180 字节，不允许路径分隔符、控制字符及 `<>:"|?*`。文件名仅作显示元数据，服务器使用哈希命名。仅当本次 `reply_policy.media.kinds` 宣告对应能力时使用新字段；该声明不保证账号权限。本机模式不支持本协议，需启用 `QQ_REPLY_PUBLIC_URL`。

## 小文件直接随回复提交

向固定 `QQ_REPLY_URL` POST，带原安全配置的 `X-Reply-Token`：

```json
{
  "job_id": "<原任务ID>", "type": "c2c", "openid": "<原用户ID>", "msg_id": "<原消息ID>",
  "reply_seq": 2, "final": true, "content": "报告和语音已准备好。",
  "media_base64": [
    { "kind": "file", "name": "报告.pdf", "data": "<纯base64，不含data:前缀>" },
    { "kind": "voice", "name": "voice.silk", "data": "<纯base64，不含data:前缀>" }
  ]
}
```

示例假设第 1 段进度已成功；未发进度时用 `reply_seq:1`。群聊改为 `type:"group"` 与 `group_openid`。不要提交服务器路径或任意 URL 要求桥接读取。

## 先上传，再提交引用

Grok 执行环境可使用项目客户端，继续沿用安全配置的 `QQ_REPLY_URL` / `QQ_REPLY_TOKEN`：

```bash
npm run --silent upload-media -- --job <原任务ID> --kind file --file ./report.pdf --name 报告.pdf
```

音频使用 `--kind voice --file ./voice.silk`。`--file` 属于客户端自己的文件，桥接无法读取该路径。命令只上传，不发送 QQ；输出 `{ok:true,replayed,media:{upload_id,...}}`。随后提交最终回复：

```json
{
  "job_id": "<原任务ID>", "type": "c2c", "openid": "<原用户ID>", "msg_id": "<原消息ID>",
  "reply_seq": 2, "final": true, "content": "这是报告。",
  "media": [{ "upload_id": "<上传返回的ID>" }]
}
```

`media` 每项只传 `upload_id`，不要复制整个上传响应。可与 `media_base64`、旧图片组合，发送顺序为正文、旧图片、`media_base64`、`media`。新文件/语音回复若无法将全部正文和附件放入剩余配额，返回 409，不占用该段；缩短文字或减少附件后再提交，不新建任务扩充配额。旧文字/图片的截断行为保持兼容。

### 直接使用 HTTP

只允许固定回复地址同源的 `PUT /jobs/<本次job_id>/uploads/<upload_id>`，请求体为原始二进制，请求头：

- `X-Reply-Token`：原安全配置中的密钥。
- `Content-Type: application/octet-stream`。
- `Content-Length`：文件字节数，必须已知且大于零，不接受只有分块传输而无长度。
- `X-Media-Kind: file` 或 `voice`。
- `X-Media-Name`：文件名按 `encodeURIComponent` 编码。
- `X-Content-SHA256`：文件字节的 SHA-256 小写十六进制。

`upload_id = SHA256(UTF8(JSON.stringify([kind, name, sha256])))`，其中 `name` 是原文件名，序列化不加空格。Python 等价序列化为 `json.dumps([kind,name,sha256], ensure_ascii=False, separators=(",",":"))`。

成功返回 `{ok:true,replayed:false,media:{upload_id,kind,name,sha256,bytes}}`。已登记 ID 不可覆盖，重复 PUT 返回 `replayed:true`，不会发 QQ。带同一鉴权 GET 同一地址可查登记元数据，不提供二进制下载。跨任务引用无效；任务发送中、已结束或到期时不接受新上传。

超时先 GET 核对，必要时保持文件和元数据不变重试原 PUT。上传中断清理临时文件；崩溃遗留 `.part` 在取得队列独占锁后清理。已重命名但登记确认失败的二进制可能保留，原 ID 重试可恢复；未登记文件不能被回复引用。

## 发送结果与恢复

QQ 文件使用 `file_type:4`，语音使用 `file_type:3`。小于 5 MiB 的新媒体使用 base64 上传，达到 5 MiB 后走分片：`upload_prepare` → COS PUT → `upload_part_finish` → `/files` 完成。取得 `file_info` 后先持久化消息序号，再发 `msg_type:7`；上传本身不发 QQ。COS URL 仅接受 HTTPS 的 `*.myqcloud.com`，不跟随重定向，也不会收到 QQ 或回复 token。

结果新增 `files_sent/files_total` 和 `voices_sent/voices_total`；历史只存文件名和 `[文件]` / `[语音]` 标记，不存 base64。指纹包含媒体类型、文件名、内容哈希与顺序；相同媒体以内联或上传引用提交得到一致指纹。相同段重放不重复上传或发 QQ；更改文件、名称、类型或顺序会冲突。

若正文或前面的附件已发、后续附件失败，返回 502 并保存部分结果。不能改正文或删附件来强制补发；发送中断仍按 `uncertain` 处理。上传成功不代表 QQ 已收到，应分别核对最终结果和客户端显示。

## 部署与验收

反向代理或隧道需允许至少 100 MiB 原始上传及最长 120 秒的上传请求，还要满足任务原截止时间。JSON 仍限制 8 MiB。入口返回 413/超时时检查代理限制，不关闭 TLS 或绕过鉴权。

二进制在 `<QQ_JOBS_DIR>/outbound/`，登记信息在任务 JSON 可选 `uploads` 中，均为私有运行数据。备份整个队列，恢复时二者一起恢复，不能只复制 JSON。任务截止后保留 7 天，清理任务时也清理其二进制。上传目录不能替换为符号链接，`doctor` 只读检查，启动发现无效目录会停止。

升级前处理在途任务，停止服务并备份配置和数据，再切换已验证提交。回退前等待新媒体回复完成或到期，保留新队列；低版本不支持新字段，也不会清理其二进制。不要恢复旧快照重发。

部署后由用户在已授权私聊、群聊分别触发小文件、可播放语音及大文件，核对权限、实际显示/播放、公网上传和回调防重。模拟 QQ 自动测试不能代替当前账号与客户端的真实验收。
