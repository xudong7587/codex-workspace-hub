# Codex Workspace Collector

无需安装 Node.js 或 Python 的单文件 Windows 托盘程序。它负责采集本机 Codex token，并通过 Codex Workspace Hub 在多台电脑间同步项目、备份对话。

首次运行填写 Hub HTTPS 根地址、管理面板中的手机桥接 Secret，以及需要同步的项目文件夹。同一项目在各电脑必须使用相同的同步名称。

同步模式：

- 智能同步（默认）：文件变化只触发一次延迟检查，连续 90 秒没有新写入后再同步；每天多个设定时间兜底。
- 仅定时：只在设定的多个 `HH:mm` 时间同步。
- 仅手动：只通过托盘菜单同步。

项目文件在本机加密，Hub 只保存密文。发生双端修改时保留 `.codex-sync-conflict-*` 副本，不传播删除操作。`.git`、依赖和构建目录、`.env` 与常见私钥文件不会上传。

Codex 对话只在 JSONL 停止写入 120 秒后备份到 `%LOCALAPPDATA%\VWatchCollector\ConversationBackups`，不会写入另一台电脑的实时 `.codex` 目录。
