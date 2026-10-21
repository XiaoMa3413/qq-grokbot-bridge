# 版本与升级

- `v1.1.0`：已验证的远程文字收发及休眠唤醒基线。
- `v1.2.0`：持久化转发、回调防重、远程图片与会话记忆接口。
- 所有变更在 `feat/reliable-remote-bridge` 分支上分次提交；使用带说明的 Git 标签标记版本。
- `deploy/ci-test.yml` 提供 Node.js 22/24、Windows/Linux 的测试模板。当前 GitHub 登录缺少 workflow 权限，尚未启用 Actions；授权后可将模板放到 `.github/workflows/test.yml` 单独提交。
- `.env*`（除示例）、`reply_token`、`data/`、`memory/`、日志不进入版本库。发布前检查暂存区是否含运行密钥。

## 升级

1. 记录 `git describe --tags --always`、运行版本及 `/health`；确认已转发任务的最终回复完成后再切换，避免旧任务尚未登记在新版队列中。
2. 用受限权限备份 `.env`、`reply_token`、`data/`、`memory/`。备份包含私密会话，不能推到 Git。
3. 先在独立目录检出目标标签，执行 `npm ci && npm test`；测试不加载生产 `.env`。
4. 停止唯一的生产服务，确认没有其他 bridge.js 进程占用同一队列。保存有改动的旧源码，再切换到已验证的标签。保留上述配置及数据。
5. `npm ci --no-audit --no-fund` 后启动服务，检查 `/health` 的版本、`ws_state`、队列计数及 `READY` 日志，再做实际消息验证。

```bash
systemctl --user stop qq-grokbot-bridge
# 确认工作区修改已保存，再执行；不使用 reset --hard 或 clean 删除现场数据。
git switch --detach v1.2.0
npm ci --no-audit --no-fund
systemctl --user start qq-grokbot-bridge
npm run status
```

若服务器无法访问 GitHub，可从 Windows 使用 `git bundle create <文件> --all` 导出包含标签的提交，通过 SSH/SCP 导入服务器。传输包不包含被 Git 忽略的配置和数据。

## 回退

停止服务，按同样流程检出 `v1.1.0`，安装该版本依赖后重新启动。**v1.1.0 不处理 v1.2 任务队列，也不认识远程图片/记忆接口**：回退前等待已接收任务完成；保留新版任务数据，回退并不等于这些任务会被处理。再次升级后，仍在有效期内的未完成任务才能继续恢复。

不要删除失败或 `uncertain` 的任务文件来强行重发，这可能造成重复 QQ 消息。涉及发送结果不明时，应先核对 QQ 已收到的消息。
