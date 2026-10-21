# 在 DGX Spark 上部署，使用 Sakura FRP 回传回复

当前阶段提供远程**文字回复**和独立隧道探测；图片/记忆文件跨机访问、持久化任务队列、完成确认、重复任务去重尚未实现。不要把探测成功理解为 Grok 休眠唤醒或 QQ 收发已验证。

## 1. 创建独立隧道

在 Sakura FRP 面板创建并在 **gb10 的启动器**启用这条隧道：

| 字段 | 值 |
|---|---|
| 名称 | `qq-grokbot-reply`（可自定义） |
| 类型 | TCP |
| 本地地址 | `127.0.0.1` |
| 本地端口 | `8787` |
| 远程端口 | 使用面板分配的可用端口 |
| 自动 HTTPS | 自动 |
| 子域绑定 | 给此隧道申请并绑定免费的 `nyat.app` 子域名 |

现有 `natfrp-service` 容器已检查为 host 网络，因此 `127.0.0.1` 是服务器本机。若日后改为 Docker bridge 网络，必须重新确认这一地址。

本地服务提供 HTTP，由 frpc 终止外部 TLS。等待启动日志出现“已从服务器为 … 加载证书”，再使用 `https://<绑定子域名>:<远程端口>` 访问，客户端保持证书验证开启。节点须允许该用途，以面板限制为准。不要改动现有 SSH 隧道。

官方依据：[Web 应用穿透](https://doc.natfrp.com/app/http.html)、[自动 HTTPS](https://doc.natfrp.com/frpc/auto-https.html)、[免费子域名和证书](https://doc.natfrp.com/bestpractice/domain-bind.html)。

## 2. 先验证隧道，不连接 QQ

项目路径：`/home/xingjionline/projects/qq-grokbot-bridge`，要求 Node.js 22 或以上。

```bash
cd /home/xingjionline/projects/qq-grokbot-bridge
npm ci
npm run probe
```

首次运行自动生成 `reply_token`，不要将其粘贴进聊天或提交 Git。

公网 `GET /health` 应返回：

```json
{"ok":true,"mode":"probe","qq_connected":false}
```

鉴权探测用 `POST /probe`，请求头 `X-Reply-Token`，JSON 为 `{"nonce":"自定义随机值"}`。成功会原样回传 nonce 和服务器时间；错误 token 返回 401。该服务没有 `/reply`，不会转发消息或执行命令。

Windows 可在本机临时通过 SSH 读取 token 并完成测试，token 不会输出到终端：

```powershell
$probeBase = 'https://<绑定子域名>:<远程端口>'
$probeToken = (ssh gb10 'cat /home/xingjionline/projects/qq-grokbot-bridge/reply_token').Trim()
Invoke-RestMethod "$probeBase/health"
$probeNonce = [guid]::NewGuid().ToString()
Invoke-RestMethod "$probeBase/probe" -Method Post -ContentType 'application/json' -Headers @{ 'X-Reply-Token' = $probeToken } -Body (@{ nonce = $probeNonce } | ConvertTo-Json)
Remove-Variable probeToken
```

服务运行方式若为本次准备的临时 systemd 用户单元，可用 `systemctl --user status qq-bridge-probe` 查看，`systemctl --user stop qq-bridge-probe` 停止。此单元未设置开机启动。

## 3. 配置并启动真实桥接

复制 `.env.example` 为 `.env`，权限设为 600，在服务器上填写 QQ 凭据和现有 Grok webhook；配置：

```dotenv
QQ_REPLY_PUBLIC_URL=https://<绑定子域名>:<远程端口>/reply
```

此变量会启用远程文字模式：拒绝 `image` / `images`（禁止远程请求读取服务器本地图片），并要求原始 `msg_id`。转发给 Grok 的 JSON 会多一个 `reply_url`；不会在载荷中附带回复 token。其余历史和附件字段保持兼容，但 `local_path` / `memory_path` 属于桥接主机，Grok 不能直接读取这些路径。

先停止探测服务、停止 Grok 云电脑上旧的桥接进程，再启动新桥接，避免两处同时处理消息：

```bash
systemctl --user stop qq-bridge-probe
cd /home/xingjionline/projects/qq-grokbot-bridge
npm start
```

长期运行可安装提供的 systemd 用户服务，先确认服务文件中的项目路径正确：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/qq-grokbot-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now qq-grokbot-bridge
journalctl --user -u qq-grokbot-bridge -f
```

不要同时运行 `npm start`、`start.sh` 和 systemd 服务。若需用户退出后和重启后自动运行，管理员应确认并启用该用户的 linger；用 `loginctl show-user "$USER" -p Linger` 查看状态。service 启动不会自动加载交互 shell 中临时 export 的变量，凭据需放在项目 `.env`。

## 4. Grok 回传与休眠测试

现有云端配置迁移、例行任务指令草稿和切换顺序见 [Grok 云电脑迁移说明](grok-routine.md)。

通过 Grok 的安全凭据配置渠道，在其执行环境设置 `QQ_REPLY_TOKEN`（与桥接端相同）及固定的 `QQ_REPLY_URL=https://<绑定子域名>:<远程端口>/reply`。不要让用户消息或 webhook 载荷覆盖配置中的回传地址。

Grok 可以直接用 HTTP 工具 POST，或使用 `scripts/reply.js`（需 Node.js 22+ 及本项目依赖），从 stdin 接收 JSON：

```json
{"type":"group","group_openid":"<原消息群ID>","msg_id":"<原消息ID>","content":"测试回复"}
```

远程接口需要 `X-Reply-Token` 请求头；`reply.js` 自动读取配置，不跟随重定向，非本机地址必须 HTTPS。Windows 也能用 `Get-Content reply.json -Raw | npm run reply`，Linux 使用 `npm run reply < reply.json`。本机回传默认地址仍为 `http://127.0.0.1:8787/reply`，远程执行时必须设置 `QQ_REPLY_URL`。

依次验证：Grok 清醒时收发文字；休眠时从外部 webhook 启动任务并回传；连续多条消息；重启桥接后的恢复。记录收到 QQ 消息、webhook 接收、Grok 开始执行、QQ 回复成功的时间。群聊回复时限尤其需要实测。探测通过后仍可能因 Grok 用量、审批、任务排队或 QQ 时限导致失败；当前没有持久化队列，不保证故障期间的任务补发。
