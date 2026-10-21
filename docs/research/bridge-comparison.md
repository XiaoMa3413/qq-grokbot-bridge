# Grok Bot 桥接项目代码调研

调研日期：2026-10-21。比较基线为本项目已合并的 v1.5.0 源码；本文是研究结论与后续建议，不代表所提功能已经实现或部署。

## 结论与建议

建议保留现有 QQ 桥接架构，优先参考两个方向：Telegram 项目的任务级凭据和不确定结果分类，以及 Bridge Plugin 的版本化角色配置、记忆来源与作用域。下一批功能优先落在“选定事实单向导入 + 角色版本”，转发结果不明的处理另作一项可靠性改进。无需为了采用这些思路迁移运行平台或整体重写代码。

本轮发现的关键边界：

- Telegram 的立即 HTTP 确认、表情和输入状态不是同一种反馈；QQ 不能直接照搬其 typing 刷新方案。
- 转发请求超时不代表 Grok 未开始执行。现有回传防重可以减少重复 QQ 回复，但不能阻止重复 Grok 工作。
- Bridge Plugin 的公开仓库包含 CLI、协议和客户端测试，配套参考服务端在私有仓库；权限策略的服务端实现不能从公开 CLI 推定。
- 该项目的记忆接口访问应用自己的记忆源，没有提供 Grok 平台原生记忆导出代码。

## 范围与可复核版本

| 对象 | 固定提交 | 阅读范围 |
|---|---|---|
| [grokbot-telegram][tg-root] | `583c6316f60a41c96d3722ad8ca08b2a1ee586f8` | 入站、回传、凭据、存储、进度、Node/Cloudflare 适配器及对应测试源码 |
| [grokbot-bridge-plugin][plugin-root] | `208e279dfb26725fc23dff70d7735ef358ce5240` | CLI 的签名校验、去重、角色版本、记忆调用、设置说明及客户端测试源码 |
| [本项目源码][own-root] | `1c764e212f199496984f95df64dbef774fc603cd` | 任务、回传、上下文、鉴权及记忆实现 |

第三方代码仅作静态阅读，本轮没有安装其依赖、执行其测试或访问真实 QQ/Grok 账户。下文区分可从源码确认的行为与本项目的设计建议，不把存在测试文件等同于已经验证测试通过。源码链接固定到上述提交，避免后续 main 变化影响结论。

## 关键机制对照

| 机制 | Telegram 桥接 | Bridge Plugin | 本项目基线 |
|---|---|---|---|
| 唤醒链路 | Telegram webhook → Grok webhook → `/send` | 应用签名消息 → Grok 例行任务 → CLI 回传 | QQ WebSocket → 持久化任务 → Grok webhook → `/reply` |
| 等待反馈 | reaction、typing、可选文字回执与进度段 | 通用消息协议，不提供 QQ/TG 等价反馈实现 | Grok 执行后可发进度段，未自动代发入站回执 |
| 转发重试 | 一次尝试，区分明确失败与可能已接收 | CLI 发消息调用；不能据此判断私有服务端重试策略 | 网络异常、408/429/5xx 退避重试；2xx 后等待回传 |
| 回传防重 | 最终段使用 wake key，进度可带幂等 key | `messageId` 可由调用者固定；服务端去重依赖应用 | 所有段必须连续编号，同段检查正文/图片指纹与 final 值 |
| 状态持久化 | 默认 Node 存内存，另有 Cloudflare Durable Object 实现 | CLI 保存本地状态；公开代码不包含参考应用存储层 | Node 本地文件、原子更新与实例锁，非跨主机共享队列 |
| 短期上下文 | 按 chat/topic 保存入站背景，带年龄过滤 | 通用会话标识与消息协议 | 私聊/群隔离、问答关联、引用/身份优先、文字预算 |
| 记忆与角色 | 所读核心链路未实现平台记忆导出 | 应用角色版本及 `own/shared` 记忆接口 | 每会话 Markdown + ETag，并发校验；尚无角色版本或选定事实导入 |

以上各项的证据见后面的具体源码链接；表中未声称任一项目在全部场景下更可靠。

## 1. 立即反馈：区分传输确认与用户可见进度

Telegram 入站 HTTP 返回成功只是确认平台已交付事件。用户看到的 reaction、typing、可选文字回执和后续进度分别由其他调用完成。源码在 `deliverWake` 中先启动反馈，再唤醒 Grok；反馈失败不阻止任务转发。[入站实现][tg-inbound]、[进度控制器][tg-typing]。

这与本项目当前“Grok 开始执行后回传第一段”不同。若希望云端尚在唤醒时 QQ 就确认收到，应新增桥接端可选回执，并纳入持久化发送台账。它会消耗原 QQ 消息的配额；载荷需说明已发回执和剩余名额，避免 Grok 再重复确认，也不能因此延长回复时限。

腾讯公开发送文档规定被动回复有效期及 `msg_id + msg_seq`，其中输入状态字段在所读源码中处于注释内，未构成当前可确认的公开接口。本轮没有调用真实 QQ API 验证 typing 能力，因此不承诺可复制 Telegram 的输入状态、静默通知或持续草稿体验。[腾讯发送说明][qq-send]。

**建议：**自动文字回执保持可选，先明确是否需要它；已有分段回复继续使用。回执只表达桥接已收到任务，不能声称 Grok 已开始搜索。

## 2. 最值得补的可靠性细节：转发结果不明

Telegram 的 `forwardToGrok` 只尝试一次，把部分网关错误和无法证明未送达的网络异常归为 ambiguous，保留等待状态；明确失败则清理反馈并可通知用户。这是一种减少重复执行的取舍，并不保证不丢任务。[转发实现][tg-grok]、[网络异常分类][tg-http]。

本项目选择可恢复队列与退避重试。它更倾向在临时失败后继续投递，但若 Grok 已收到了请求、只有响应丢失，下一次投递仍可能再次唤醒。任务 ID 稳定、回传按段防重，并不能单独避免两次搜索、两次模型工作或其他外部操作。[本项目任务实现][own-jobs]。

本轮对本项目 `ForwardWorker` 做了仅本地的故障注入：第一次模拟“远端已接收但响应丢失”并抛错，推进测试时钟后再次调度，得到 `forward_calls=2`、`attempts=2`、最终 `delivery=accepted`。这确认当前重试语义；它不是实际平台重复执行的测量，没有联系 QQ 或 Grok。

**建议：**先区分“确定未送达”“可能已送达”“平台明确拒绝”。对不确定投递增加独立状态、观察期限和人工重投入口，再决定是否保留自动重试。若增加 Grok 开工确认或执行领取机制，需要原子领取、版本/租约校验和恢复规则；租约本身仍不能保证外部操作只发生一次。不要直接把现有队列改成所有错误都不重试。

## 3. 回传：保留当前的序号与内容绑定

Telegram 的最终发送 key 绑定 wake，进度 key 可由调用者提供；未提供时没有这一级进度 key。其重复结果主要返回已存消息 ID。发送结果不明保留记录，明确发送失败则可能释放 key，交由调用者处理缺失部分。[回传实现][tg-outbound]、[发送记录结构][tg-store]。

本项目每段均有 `reply_seq`，相同序号的正文/图片或 final 不同会冲突；并在 QQ 发送前持久化意图和消息序号。这些约束应保留。[本项目回复入口][own-reply]、[指纹实现][own-remote]。

**建议：**不照搬“失败就释放同一段”的行为。允许补发前必须记录每个部分的确定结果、已用 QQ 序号和配额，并明确如何处置结果不明的部分；否则可能重新发送前面已成功的文字。当前保守冻结失败段的策略虽需人工处理，但不会因普通回调重试而主动补发。

## 4. 任务级短期凭据值得引入，但需兼容迁移

Telegram 为每次 wake 签发带 chat、topic、wake 和到期时间的凭据，回传时验证签名及路由作用域；后台保留签名密钥。[载荷签发][tg-payload]、[凭据验证][tg-crypto]。

本项目使用固定 `X-Reply-Token`，再按登记任务和原路由校验回传，资源访问也有任务绑定和截止时间；固定凭据本身并不只授权某一个任务。

**建议：**后续增设只授权本任务回传、媒体读取、会话记忆操作的短期凭据。授权范围、期限和撤销由服务器决定，不让模型任意选择。为旧 Grok 规则保留显式迁移期，后台签名密钥不进入载荷；任务凭据的期限不能超过 QQ 原消息期限。角色导入等管理操作使用单独入口，不授予任务凭据。

## 5. 角色与记忆：最接近下一阶段需求的参考

Bridge Plugin 的角色流程是下载文本及版本、校验内容哈希，再记录 `appliedVersion`。后续任务可携带期望版本，CLI 提示过期时重新获取。这解决配置版本是否一致的问题。[角色实现][plugin-soul]。

需要注意：`soul applied` 在公开 CLI 中只是写入本地采纳记录；它不是平台记忆写入 API，也不能从该记录证明模型已正确遵循角色。其 `memory status/search/store/read` 命令请求应用自己的 `GET /memory` 及 `POST /memory/search`、`/memory/store`、`/memory/read`，协议区分 own 与可选只读 shared。公开测试使用模拟应用响应，不能验证未公开服务端的真实权限行为。[记忆客户端][plugin-memory]、[客户端测试][plugin-tests]、[参考服务端说明][plugin-server]。

**建议的最小交付：选定事实单向导入 + 可版本化角色档案。**

| 部分 | 建议行为 | 验收重点 |
|---|---|---|
| 输入来源 | 用户明确选定的 Markdown/JSON 事实或角色文本，可由平台支持的工具导出，也可手动整理 | 不宣称已自动读取全部平台记忆；导入文件按数据解析 |
| 预览与提交 | 先显示将新增、冲突、跳过及删除的条目，再明确提交 | 预览不改写记忆；提交校验所预览版本，遇并发修改需重新预览 |
| 作用域 | 显式绑定某私聊、某群或已配置共享档案 | 不能由聊天正文指定任意目标；私聊事实不自动变成群共享事实 |
| 角色档案 | 单独保存文本、内容版本、来源及更新时间 | QQ 任务按版本获取；不默认修改 Grok 平台全局角色 |
| 导入事实 | 与现有会话 Markdown 区分来源，保留导入批次和条目标识 | 能追踪更新、纠正与删除；删除条目不从旧快照自动复活 |
| 使用与回写 | 导入快照默认由 QQ 任务只读使用；新会话事实继续走现有受控写入机制 | 机器人不能随意覆盖来源档案；可关闭来源、撤销共享 |

这些是本项目的设计建议，不是对方已提供的导入器。现阶段可沿用本地文件和 ETag，无须立即引入独立向量数据库。只有实际出现检索需求后，再评估可替换的记忆后端。

## 6. 上下文与载荷：可做的小改进

Telegram 的上下文按 chat/topic 分开，排除当前消息，并过滤一周前的记录；所读入站链路写入背景，回传入口没有把机器人回答写回同一缓冲区。本项目 v1.5 的问答关联与总文字预算覆盖了不同的需要，不应替换成单纯的最近 N 条入站消息。[背景过滤][tg-store]、[入站链路][tg-inbound]、[本项目组装器][own-context]。

**建议：**以后可增加可配置历史年龄窗口和省略原因，同时保留用户明确引用与长期记忆的独立语义。不能因为近期历史超龄就删除已确认的长期偏好，也不能随意延长 QQ 回复窗口。

另一个低成本做法是 Telegram 在 JSON 序列化后转义 `<`、`>`、`&`，解析结果保持相同。它适合减少平台将 webhook 文本包进标签时的字面分隔符干扰；不是通用的提示注入防护，也不能替代将消息视为外部数据。[序列化实现][tg-grok]。本项目目前直接 `JSON.stringify` 发送，可在独立小改动中增加编码等价测试后采用。

## 实施优先级

以下成本是相对于现有文件存储架构的工程判断，不是工时承诺。

| 顺序 | 建议改动 | 成本 | 主要依赖 |
|---|---|---|---|
| 1 | 选定事实导入预览、提交与版本化角色档案 | 中 | 来源格式、显式 QQ 作用域、冲突与删除语义 |
| 2 | 转发结果不明分类、观察状态和人工重投 | 中 | 更新任务状态、健康/状态接口与 Grok 开工确认约定 |
| 3 | 任务级短期凭据 | 中至高 | 鉴权版本、资源授权与旧规则迁移 |
| 4 | 可选桥接回执 | 中 | 持久化发送台账、QQ 配额与避免重复进度提示 |
| 5 | 历史年龄策略、标签字符等价编码 | 低至中 | 默认策略与边界测试，可独立提交 |

暂不把多 Bot 房间、自动创建 Bot、Cloudflare 部署或自动双向平台记忆同步纳入本轮实现范围。已有文件队列、按段指纹防重与 QQ 截止时间约束继续保留。

## 证据边界与后续验证

- 两个仓库的 LICENSE 均标注 MIT。本轮只归纳思路，未引入第三方实现；未来复制代码时保留来源与相应许可声明。[Telegram 许可][tg-license]、[Plugin 许可][plugin-license]。
- Telegram 的默认 Node 存储使用 `MemoryStore`，不能把其 Cloudflare 存储适配器的持久化特性归到默认 Node 运行形态。[依赖构建][tg-deps]、[Cloudflare 适配器][tg-cf]。
- 本轮没有访问 Bridge Plugin 的私有服务端，没有验证其真实记忆后端，也没有验证 Grok 平台原生记忆导出能力。
- 本项目下一次实际实现时，需要新增针对导入冲突、删除后再导入、跨会话作用域、并发版本冲突、凭据过期和网络结果不明的测试；研究文档不是这些功能的验收结果。

[tg-root]: https://github.com/jexmarc/grokbot-telegram/tree/583c6316f60a41c96d3722ad8ca08b2a1ee586f8
[tg-inbound]: https://github.com/jexmarc/grokbot-telegram/blob/583c6316f60a41c96d3722ad8ca08b2a1ee586f8/src/core/inbound.ts#L255-L318
[tg-typing]: https://github.com/jexmarc/grokbot-telegram/blob/583c6316f60a41c96d3722ad8ca08b2a1ee586f8/src/core/typing.ts#L10-L33
[tg-grok]: https://github.com/jexmarc/grokbot-telegram/blob/583c6316f60a41c96d3722ad8ca08b2a1ee586f8/src/core/grok.ts#L17-L78
[tg-http]: https://github.com/jexmarc/grokbot-telegram/blob/583c6316f60a41c96d3722ad8ca08b2a1ee586f8/src/core/http.ts#L47-L84
[tg-outbound]: https://github.com/jexmarc/grokbot-telegram/blob/583c6316f60a41c96d3722ad8ca08b2a1ee586f8/src/core/outbound.ts#L51-L165
[tg-store]: https://github.com/jexmarc/grokbot-telegram/blob/583c6316f60a41c96d3722ad8ca08b2a1ee586f8/src/core/store.ts#L39-L104
[tg-payload]: https://github.com/jexmarc/grokbot-telegram/blob/583c6316f60a41c96d3722ad8ca08b2a1ee586f8/src/core/payload.ts#L74-L127
[tg-crypto]: https://github.com/jexmarc/grokbot-telegram/blob/583c6316f60a41c96d3722ad8ca08b2a1ee586f8/src/core/crypto.ts#L59-L119
[tg-deps]: https://github.com/jexmarc/grokbot-telegram/blob/583c6316f60a41c96d3722ad8ca08b2a1ee586f8/src/core/deps.ts#L29-L34
[tg-cf]: https://github.com/jexmarc/grokbot-telegram/blob/583c6316f60a41c96d3722ad8ca08b2a1ee586f8/src/adapters/cloudflare/do-storage.ts
[plugin-root]: https://github.com/imbavirus/grokbot-bridge-plugin/tree/208e279dfb26725fc23dff70d7735ef358ce5240
[plugin-soul]: https://github.com/imbavirus/grokbot-bridge-plugin/blob/208e279dfb26725fc23dff70d7735ef358ce5240/grokbot-bridge.mjs#L832-L923
[plugin-memory]: https://github.com/imbavirus/grokbot-bridge-plugin/blob/208e279dfb26725fc23dff70d7735ef358ce5240/grokbot-bridge.mjs#L932-L993
[plugin-tests]: https://github.com/imbavirus/grokbot-bridge-plugin/blob/208e279dfb26725fc23dff70d7735ef358ce5240/test/cli.test.mjs#L483-L609
[plugin-server]: https://github.com/imbavirus/grokbot-bridge-plugin/blob/208e279dfb26725fc23dff70d7735ef358ce5240/README.md#L91-L93
[tg-license]: https://github.com/jexmarc/grokbot-telegram/blob/583c6316f60a41c96d3722ad8ca08b2a1ee586f8/LICENSE
[plugin-license]: https://github.com/imbavirus/grokbot-bridge-plugin/blob/208e279dfb26725fc23dff70d7735ef358ce5240/LICENSE
[qq-send]: https://github.com/tencent-connect/bot-docs/blob/645787a45937e5d9c4f0f61afefdffde0f38696e/docs/develop/api-v2/server-inter/message/send-receive/send.md
[own-root]: https://github.com/XiaoMa3413/qq-grokbot-bridge/tree/1c764e212f199496984f95df64dbef774fc603cd
[own-jobs]: https://github.com/XiaoMa3413/qq-grokbot-bridge/blob/1c764e212f199496984f95df64dbef774fc603cd/jobs.js#L129-L158
[own-reply]: https://github.com/XiaoMa3413/qq-grokbot-bridge/blob/1c764e212f199496984f95df64dbef774fc603cd/reply_server.js#L103-L183
[own-remote]: https://github.com/XiaoMa3413/qq-grokbot-bridge/blob/1c764e212f199496984f95df64dbef774fc603cd/remote.js#L28-L30
[own-context]: https://github.com/XiaoMa3413/qq-grokbot-bridge/blob/1c764e212f199496984f95df64dbef774fc603cd/context.js
