# Codex Workspace Collector

无需安装 Node.js 或 Python 的单文件 Windows 托盘程序。它负责采集本机 Codex token，并通过 Codex Workspace Hub 在多台电脑间同步项目、备份对话。

首次运行填写 Hub HTTPS 根地址和管理面板中的设备连接 Key，然后扫描项目并逐项勾选。同一项目在各电脑使用相同名称；每台电脑可以选择不同项目，并分别设置双向、仅上传或仅下载。

同步模式：

- 智能同步（默认）：文件变化只触发一次延迟检查，连续 90 秒没有新写入后再同步；每天多个设定时间兜底。
- 仅定时：只在设定的多个 `HH:mm` 时间同步。
- 仅手动：只通过托盘菜单同步。

项目文件在本机加密并按 512 KiB 小块传输，Hub 只保存密文。发生双端修改时保留 `.codex-sync-conflict-*` 副本，不传播删除操作。`.git`、依赖和构建目录、`.env` 与常见私钥文件不会上传。托盘菜单可随时打开复制式同步进度窗口。

Codex 对话只在 JSONL 停止写入 120 秒后备份到 `%LOCALAPPDATA%\CodexWorkspaceCollector\ConversationBackups`，不会写入另一台电脑的实时 `.codex` 目录。
