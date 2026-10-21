# Changelog

## 1.1.0 — 2026-10-21

- 支持常驻 Windows / ARM64 Linux 桥接与 Grok 云电脑分离部署。
- 增加 HTTPS 远程文字回复、鉴权探测、跨平台回复客户端及 systemd 用户服务。
- 已在 DGX Spark 验证真实 QQ 私聊收发，并由用户确认休眠唤醒收发成功；两次端到端测试约 120 秒。
- 准备 Windows / Linux CI 模板；当前 GitHub 凭据缺少 workflow 权限，工作流尚未启用。配置文件和运行数据不进入 Git。

## 1.0.0

- 原有 QQ 网关、图片下载、对话历史、本机回复和连接看门狗。
