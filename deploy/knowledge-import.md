# 会话角色与选定事实导入（v1.6）

从手工整理或已导出的资料中选定需要用于 QQ 的角色文本和事实，以 JSON 清单导入指定会话。项目不自动读取 Grok 客户端聊天或平台记忆，也不反向修改平台全局角色。

| 数据 | 来源 | 更新方式 |
|---|---|---|
| 近期 `history` | QQ 入站与机器人回复 | 桥接自动记录、按预算选取 |
| `memory` / `memory_url` | 当前 QQ 会话的 Markdown 记忆 | Grok 沿用 GET / PUT + ETag 协议 |
| `knowledge.profile` / `knowledge.facts` | 操作者明确选定的导入清单 | 桥接主机本地预览、提交；QQ 任务只读使用 |

第一版只支持显式的单个私聊或群聊作用域，不自动共享档案。群作用域表示该群的共享资料，不能把某个成员的私聊资料直接当成群共享资料。目标使用真实 `openid` / `group_openid`，不能用昵称猜测。

## 清单格式

从[示例](../examples/selected-knowledge.json)复制后编辑：

```json
{
  "schema": 1,
  "source": { "id": "manual-selection", "label": "人工选定导入", "version": "1" },
  "profile": "你是一个回答清晰、语气友善的 QQ 助手。",
  "facts": [{ "id": "reply-style", "content": "回答以结论开头，必要时补充说明。" }]
}
```

- `source.id` 是稳定来源标识，`version` 是操作者提供的来源版本标签；程序不把标签解释成可比较的时间或大小。`label` 可省略，默认等于来源 ID。
- `profile` 是 Markdown 格式的角色文本，省略时保持原配置；`null` 表示删除。它用于语气、角色表现和回答习惯，不授予工具、路由或服务器权限，不能覆盖当前用户要求或平台与桥接协议。
- `facts` 中每条有稳定 `id` 和文字 `content`。清单只更新列出的条目，未列出的既有条目不会删除。
- `delete:["条目ID"]` 显式删除事实；被删除的 ID 留下无正文标记，旧清单再次导入时跳过这些 ID。
- `restore:["条目ID"]` 与对应的 `facts` 条目一起使用，显式恢复被删事实；被删角色需要同时提供 `profile` 文本和 `restore_profile:true` 才能恢复。
- 来源和条目 ID 使用 1–64 个 ASCII 字母、数字、下划线、点或连字符，以字母或数字开头。未知字段、重复 ID、同一 ID 同时更新与删除都会被拒绝。

JSON 仅作为数据解析，不执行文件中的命令或脚本。不直接解析任意 Markdown 文件为事实；将选定文字放入上述明确字段。

## 预览与提交

在桥接主机项目目录执行；以下命令适用于 Windows PowerShell 和 Linux。先准备被 Git 忽略的资料文件，已有同名文件时此复制命令会报错并保留它：

```bash
node -e "const fs=require('node:fs');fs.mkdirSync('data',{recursive:true});fs.copyFileSync('examples/selected-knowledge.json','data/selected.json',fs.constants.COPYFILE_EXCL)"
```

编辑 `data/selected.json`，只保留明确选定的资料，再生成预览：

```bash
npm run knowledge -- preview --type c2c --id "<QQ_OPENID>" --file data/selected.json --out data/import-plan.json
```

预览列出 `scope`、基础版本、导入内容，以及各条目的 `add`、`update`、`conflict`、`delete`、`restore`、`skip` 和变更前后值。它不写入知识库；`--out` 必须是尚不存在的文件，以免覆盖原资料或旧预览。资料与预览文件含有选定正文，应保存在受控位置。

核对完整预览，确认目标和变更后提交同一个文件：

```bash
npm run knowledge -- commit --type c2c --id "<QQ_OPENID>" --plan data/import-plan.json
```

若确实要替换预览中标为 `conflict` 的旧内容或来源，在这一步追加 `--replace-conflicts`。该选项不能绕过版本冲突。版本已变时应重新生成新预览文件，不能编辑旧预览强行提交；预览中的删除、恢复也需逐项核对。

同一作用域出现不同正文或不同来源 ID 时列为冲突；正文和来源 ID 不变、仅来源版本或标签更新时列为 `update`。重复资料标为 `skip`，不增加会话版本。重复提交最后一次成功的同一预览返回 `replayed:true`。

群聊使用 `--type group --id "<GROUP_OPENID>"`。检查当前状态：

```bash
npm run knowledge -- show --type c2c --id "<QQ_OPENID>"
```

各命令可加 `--json` 输出紧凑 JSON。写入由进程锁和原子替换保护；并发写入可能报告忙或过期，应检查结果并重试或重新预览。磁盘提交后确认丢失时，同一预览可重试，不会增加第二次版本。

## 纠正、删除与恢复

纠正同一个事实时保持其 ID，更新清单正文和来源版本，重新预览并显式接受冲突。删除清单示例：

```json
{
  "schema": 1,
  "source": { "id": "manual-selection", "version": "2" },
  "profile": null,
  "delete": ["reply-style"]
}
```

删除后的当前知识文件不再保存被删除的角色或事实正文，只留下 ID、来源和删除批次/时间。恢复需要在新清单中明确使用 `restore` / `restore_profile`，单独传入 `--replace-conflicts` 不会恢复已删内容。

删除只影响之后准备的任务。已经发送给 Grok、写入历史任务的版本快照不会撤回，按任务原有保留策略清理；输入与预览文件由操作者管理。删除不会清理平台记忆、近期 QQ 历史或独立 `memory` 中的同名文字。

## QQ 任务如何使用

新任务的 `knowledge` 包含准确会话作用域、递增 `revision`、ETag、角色内容版本、事实及来源/导入批次/更新时间。`profile.version` 是角色正文哈希；同样正文可有新的来源版本而保持相同正文哈希。

任务在准备时固定快照，重试、重启和分段回复继续使用该版本。导入更新无需重启服务，对之后准备的任务生效，不会悄悄改变已经执行中的任务。`knowledge_url` 的 `GET /jobs/<job_id>/knowledge` 也返回该任务的固定快照，支持原有鉴权与到期约束；它不是查询资料库最新版本的接口，不支持 PUT。

Grok 处理规则见 [agent 部署指南](../DEPLOY_AGENT.md#可复制到-grok-例行任务的规则)。角色与导入事实不通过 `memory_url` 回写；任务不能利用这一入口导入、共享或覆盖其他会话的档案。旧规则仍可回复，但需要更新规则才能明确区分并使用新资料。

## 存储、限制与检查

默认存储于 `data/knowledge/`，可用 `QQ_KNOWLEDGE_DIR` 调整；每个会话使用完整作用域哈希命名，避免名字清洗后的碰撞。升级与备份时包含此目录；自定义目录需另行备份。`npm run doctor` 和启动流程会只读检查现有知识文件，损坏文件保留并阻止启动。

- 输入清单最多 64 KiB，预览读取最多 512 KiB，单会话状态最多 256 KiB。
- 最多 100 条有效事实、500 个事实删除标记；角色最多 4000、每条事实最多 2000 个 UTF-16 code unit，角色和事实正文合计最多 20000。
- 超限时预览报错，不悄悄截断或清除删除标记。知识正文独立于 `contextTextMaxChars` 的近期历史预算，不代表整个载荷或模型 token 上限。
- 第一版不提供自动客户端导出、双向平台记忆同步、群内逐成员档案或共享来源绑定。
