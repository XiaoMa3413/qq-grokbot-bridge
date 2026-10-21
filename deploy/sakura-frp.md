# 使用 Sakura FRP 回传回复

提供远程回复和独立隧道探测；v1.2 已支持持久化队列、回调防重、图片和记忆接口，详见 [远程协议](remote-protocol.md)。不要把探测成功理解为 Grok 休眠唤醒或 QQ 收发已验证。

本页使用通用 Linux 主机和示例路径。首次部署或交给 agent 执行时，参照 [通用部署任务](../DEPLOY_AGENT.md)；域名、端口和目录按目标环境填写。

## 1. 创建独立隧道

在 Sakura FRP 面板创建隧道，并在桥接主机上的启动器中启用：

| 字段 | 值 |
|---|---|
| 名称 | `qq-grokbot-reply`（可自定义） |
| 类型 | TCP |
| 本地地址 | `127.0.0.1` |
| 本地端口 | `8787` |
| 远程端口 | 使用面板分配的可用端口 |
| 自动 HTTPS | 自动 |
| 子域绑定 | 给此隧道申请并绑定免费的 `nyat.app` 子域名 |

启动器直接运行在主机上或使用 Docker host 网络时，`127.0.0.1` 指向桥接主机。若使用 Docker bridge 网络，必须另行配置能访问桥接服务的地址，不能假定容器回环地址就是主机。

本地服务提供 HTTP，由 frpc 终止外部 TLS。等待启动日志出现“已从服务器为 … 加载证书”，再使用 `https://<绑定子域名>:<远程端口>` 访问，客户端保持证书验证开启。节点须允许该用途，以面板限制为准。不要改动现有 SSH 隧道。

官方依据：[Web 应用穿透](https://doc.natfrp.com/app/http.html)、[自动 HTTPS](https://doc.natfrp.com/frpc/auto-https.html)、[免费子域名和证书](https://doc.natfrp.com/bestpractice/domain-bind.html)。

## 2. 先验证隧道，不连接 QQ

以下使用 `$HOME/projects/qq-grokbot-bridge` 作为示例项目目录，请按实际位置调整。npm 脚本要求 Node.js 22.9+，建议使用 22.x/24.x。安装依赖前确认目录中没有正在运行的生产桥接。

```bash
cd "$HOME/projects/qq-grokbot-bridge"
npm ci
npm run probe
```

首次运行自动生成 `reply_token`，不要将其粘贴进聊天或提交 Git。

公网 `GET /health` 应返回：

```json
{"ok":true,"mode":"probe","qq_connected":false}
```

鉴权探测用 `POST /probe`，请求头 `X-Reply-Token`，JSON 为 `{"nonce":"自定义随机值"}`。成功会原样回传 nonce 和服务器时间；错误 token 返回 401。该服务没有 `/reply`，不会转发消息或执行命令。

Windows 可使用已通过安全方式配置到本地执行环境的 `QQ_REPLY_TOKEN` 完成测试；它必须与桥接端有效密钥一致，不会自动读取其他主机的配置：

```powershell
$probeBase = 'https://<绑定子域名>:<远程端口>'
$probeToken = $env:QQ_REPLY_TOKEN
if ([string]::IsNullOrWhiteSpace($probeToken)) { throw '请先通过安全方式配置 QQ_REPLY_TOKEN' }
Invoke-RestMethod "$probeBase/health" -MaximumRedirection 0 -TimeoutSec 15
$probeNonce = [guid]::NewGuid().ToString()
Invoke-RestMethod "$probeBase/probe" -Method Post -ContentType 'application/json' -Headers @{ 'X-Reply-Token' = $probeToken } -Body (@{ nonce = $probeNonce } | ConvertTo-Json) -MaximumRedirection 0 -TimeoutSec 15
Remove-Variable probeToken
```

若自行配置了临时 systemd 探测单元，用其实际单元名查看和停止；前台 `npm run probe` 使用 Ctrl+C 停止。探测服务不应设为长期生产服务。

## 3. 配置并启动真实桥接

在项目目录运行 `npm run setup` 初始化缺失配置和回复密钥，再填写 QQ 凭据及 Grok webhook。已有配置会保留；Linux 配置文件权限应为 600。配置：

```dotenv
QQ_REPLY_PUBLIC_URL=https://<绑定子域名>:<远程端口>/reply
```

此变量会启用持久化远程模式：拒绝 `image` / `images`（禁止远程请求读取服务器本地图片），并要求原始消息路由。转发给 Grok 的 JSON 包含 `job_id`、`reply_url`、`reply_deadline`、图片下载地址和记忆快照；不会附带回复 token，也不会暴露 `local_path` / `memory_path`。

启动前运行 `npm run doctor -- --remote` 检查本地配置；服务启动后可用 `npm run doctor -- --remote --live` 查询健康状态。公网 TLS 和回传仍按本页步骤从外部验证。

先停止探测服务、停止 Grok 云电脑上旧的桥接进程，再启动新桥接，避免两处同时处理消息：

```bash
# 先停止实际运行的探测服务和旧桥接，确认端口已释放。
cd "$HOME/projects/qq-grokbot-bridge"
npm start
```

长期运行可安装提供的 systemd 用户服务，先按 [部署指南](../DEPLOY_AGENT.md) 核对项目路径和 Node 绝对路径，并停止前台实例。以下仅用于首次安装，不覆盖已有自定义单元：

```bash
mkdir -p ~/.config/systemd/user
cp -n deploy/qq-grokbot-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now qq-grokbot-bridge
journalctl --user -u qq-grokbot-bridge -f
```

不要同时运行 `npm start`、`start.sh` 和 systemd 服务。若需用户退出后和重启后自动运行，管理员应确认并启用该用户的 linger；用 `loginctl show-user "$USER" -p Linger` 查看状态。service 启动不会自动加载交互 shell 中临时 export 的变量，凭据需放在项目 `.env`。

## 4. Grok 回传与休眠测试

例行任务配置和迁移步骤见 [Grok webhook 任务配置](grok-routine.md)。

通过 Grok 的安全凭据配置渠道，在其执行环境设置 `QQ_REPLY_TOKEN`（与桥接端相同）及固定的 `QQ_REPLY_URL=https://<绑定子域名>:<远程端口>/reply`。不要让用户消息或 webhook 载荷覆盖配置中的回传地址。

Grok 可以直接用 HTTP 工具 POST，或使用 `scripts/reply.js`（需 Node.js 22+ 及本项目依赖），从 stdin 接收 JSON：

```json
{"type":"group","group_openid":"<原消息群ID>","msg_id":"<原消息ID>","content":"测试回复"}
```

远程接口需要 `X-Reply-Token` 请求头；`reply.js` 自动读取配置，不跟随重定向，非本机地址必须 HTTPS。Windows 也能用 `Get-Content reply.json -Raw | npm run reply`，Linux 使用 `npm run reply < reply.json`。本机回传默认地址仍为 `http://127.0.0.1:8787/reply`，远程执行时必须设置 `QQ_REPLY_URL`。

依次验证：Grok 清醒时收发文字；休眠时从外部 webhook 启动任务并回传；连续多条消息；图片与记忆；重启桥接后的恢复。记录各阶段时间。持久化队列不延长 QQ 回复时限；仍可能因 Grok 用量、审批、平台重复执行、排队或 QQ 时限而失败，不能保证所有故障下都补发成功。
