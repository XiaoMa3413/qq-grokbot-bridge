# 版本与升级

- `v1.1.0`：已验证的远程文字收发及休眠唤醒基线。
- `v1.2.0`：持久化转发、回调防重、远程图片与会话记忆接口。
- 新变更从最新 `main` 创建独立分支，分次提交后通过 PR 合并；使用带说明的 Git 标签标记功能版本，已发布标签不重写。纯文档更新不修改运行版本。
- `.github/workflows/test.yml` 在 PR 和 main 更新时执行 Node.js 22/24、Windows/Linux 四组自动测试，也支持手动触发。合并前确认四组均通过；流水线不需要部署凭据，也不部署服务。
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

若目标主机无法访问 GitHub，可在能访问仓库的机器上使用 `git bundle create <文件> <目标标签>` 导出指定版本，通过 SSH/SCP 传输，再在目标主机导入该标签。传输包不包含被 Git 忽略的配置和数据。

## 回退

v1.8 文件/语音上传登记和二进制需要一起保留，位于任务 JSON 的 `uploads` 及队列的 `outbound/` 中。回退前等待新媒体回复完成或到期，旧版不执行这套协议也不会清理其二进制；见[文件与语音](file-voice.md#部署与验收)。

v1.7 增加投递状态 `uncertain`，旧校验器可能拒绝读取，旧恢复逻辑还可能重发 `dispatching`。回退前先按[投递恢复说明](forward-recovery.md#升级与回退)完成或等待相关任务到期，并确认已落盘为旧版可读状态。人工重投只改变待投递状态，不是格式降级工具，不得用它绕过回退检查。

停止服务，按同样流程检出 `v1.1.0`，安装该版本依赖后重新启动。**v1.1.0 不处理 v1.2 任务队列，也不认识远程图片/记忆接口**：回退前等待已接收任务完成；保留新版任务数据，回退并不等于这些任务会被处理。再次升级后，仍在有效期内的未完成任务才能继续恢复。

不要删除失败或 `uncertain` 的任务文件来强行重发，这可能造成重复 QQ 消息。涉及发送结果不明时，应先核对 QQ 已收到的消息。
