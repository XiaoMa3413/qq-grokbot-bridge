# 投递诊断与人工重投（v1.7）

本功能适用于配置了 `QQ_REPLY_PUBLIC_URL` 的持久化远程模式，管理的是桥接到 Grok webhook 的投递。人工重投只重新排队原任务，不重发 QQ 回复，也不延长原消息的回复时限。

## 哪些失败会重试

| 情况 | 投递状态 | 行为 |
|---|---|---|
| 准备附件/上下文失败、调用 HTTP 前确认 QQ 正在重连 | `pending` | 指数退避后自动重试 |
| 明确的 DNS 失败、连接被拒绝、无网络路由、连接建立超时 | `pending` | 自动重试；不将普通超时或连接重置算作连接前失败 |
| HTTP 429 | `pending` | 按限流拒绝处理，退避并遵守 `Retry-After`，最长等到原任务截止时间 |
| HTTP 2xx | `accepted` | 等待回传，不因 Grok 执行慢而重投 |
| HTTP 408/5xx、响应头超时、连接重置或无法分类的异常 | `uncertain` | 可能已经执行，停止自动重投，先核对 Grok 任务 |
| 其他 HTTP 3xx/4xx | `failed` | 不自动重投，检查地址、鉴权或请求配置 |
| 发送请求时进程中断，包括旧版遗留 `dispatching` | `uncertain` | 重启后暂停重投 |

429 重试依赖接收端按限流拒绝请求的语义；桥接没有平台执行状态查询或平台幂等执行保证。[HTTP 重试规则](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)要求谨慎重试非幂等请求；传输分类只采用已知连接前错误，见 [Undici 7 错误类型](https://github.com/nodejs/undici/blob/v7.30.1/docs/docs/api/Errors.md)。其他异常保守地归入结果不明。

`uncertain` 继续占住当前会话的队列，直到正常回传完成或原任务到期；其他会话仍能处理。迟到的合法回调在原截止时间内仍可回复。收到任意回复段，是远端已经处理任务的证据，投递状态改为 `accepted`。QQ 回复本身若为 `sending` / `uncertain`，仍遵守原回调防重，不允许人工重投绕过。

## 查看任务

在桥接项目目录执行，确保使用与服务相同的 `QQ_JOBS_DIR`（默认 `data/jobs`）：

```bash
npm run jobs -- list
npm run jobs -- show --job <job_id>
```

命令只读，不连接 QQ/Grok，不恢复或清理任务，不输出消息正文、收件人、媒体路径或凭据。输出包括任务 ID、`revision`、尝试次数、截止时间、回复状态、最后一次投递的 `forward` 分类和人工重投记录的时间/请求 ID。人为填写的重投原因保存在私有任务文件中，默认诊断不显示。

`delivery` 是落盘状态，`effective_delivery` 表示该状态在进程中断恢复后的判定。服务仍运行时，看到 `dispatching` 只说明当前正在准备或发送，不能据此认定故障；停止服务后重新检查。

`GET /jobs/<job_id>` 同样增加 `forward` 分类，仍受原鉴权和截止时间限制，不提供重投接口。`/health` 的 `jobs.uncertain` 包含有效期内的投递不明任务，`jobs.forward_uncertain` 单独计数；QQ 发送不明仍计入 `uncertain`。到期的投递不明任务计入 `expired`。

## 核对后安排一次人工重投

1. 先核对 Grok 对应执行记录。若仍在执行，继续等待；若已经回传，不重投。结果不明时人工重投仍可能重复执行远端操作。
2. 停止桥接服务，正常退出会等待在途转发/回调。确认没有其他进程共用队列，备份私有运行数据。
3. 停止后再次 `show`，使用这一次的 `revision`。
4. 使用新的唯一 `request-id` 和简短原因安排重投。结果不明时必须显式添加 `--ack-duplicate-risk`。
5. 无论命令成功还是失败，都检查结果并重新启动服务；命令不会替你管理服务。

Linux systemd 用户服务示例：

```bash
systemctl --user stop qq-grokbot-bridge
npm run jobs -- show --job <job_id>

npm run jobs -- retry \
  --job <job_id> \
  --revision <show返回的revision> \
  --request-id <本次操作唯一的16至64位字母数字下划线或连字符ID> \
  --reason "checked remote execution before retry" \
  --ack-duplicate-risk

systemctl --user start qq-grokbot-bridge
npm run status
```

Windows 前台运行时先正常停止 `npm start`，在相同配置环境下执行 `show` / `retry`，再重新 `npm start`。运行中的桥接持有队列锁，管理命令拒绝写入；不要删除锁、复制活动队列或让两个实例共用目录。

`retry` 仅接受尚未到期、投递为 `failed` 或 `uncertain` 且没有任何回复记录/发送计数的任务。已有进度、最终结果、QQ 发送中或发送不明的任务都不能重投；`pending` / `accepted` 也不能强制重投。旧版遗留的发送中任务停止后按结果不明处理。

重投保留原任务 ID、路由、顺序、上下文与角色/事实快照、附件映射、尝试次数和截止时间，只改为待投递。尚未准备的旧失败任务会在正常准备时取快照。重新启动后的桥接按原队列顺序投递，并应用同样的错误分类。

`request-id` 与本次已审核的 revision、原因和风险确认绑定。若命令执行成功但确认丢失，使用完全相同的参数重试，返回 `replayed:true`，不会再次安排投递。相同 ID 配不同参数会拒绝；不同操作使用新 ID。每个任务最多保留 20 次人工重投记录，达到上限拒绝追加。不要在原因中填写密钥或消息正文。

状态已经变化时返回 `EJOBSTALE`，重新查看并核对；队列正在使用返回 `EINSTANCELOCKED`。命令未返回成功时，不应假定一定没写入：先 `show`，必要时用原参数检查重放结果。

## 升级与回退

升级前仍须停止旧实例、备份完整运行数据。磁盘继续使用 schema 1，新增可选 `forward` 和 `redrives`，并增加投递状态 `uncertain`。旧完成任务无需重写；旧 `dispatching` 无法确定是否已调用 HTTP，按结果不明恢复，不自动重投。

低于 v1.7 的严格校验器不接受投递 `uncertain`，而较早版本可能直接重试旧 `dispatching`。回退前先完成或等待这些任务到期，并用新版确认记录已转为旧版可读状态；备份新版数据后再切换。不要为回退手动修改状态、删除任务或恢复旧队列快照，这可能重复执行已经发生的远端操作。

本机模式的尽力转发没有这些持久化诊断与人工重投能力。任务级凭据、平台执行查询、取消远端任务和跨平台恰好执行一次不在本版本范围内。
