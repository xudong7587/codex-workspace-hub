# VWatch Windows 采集器

无需安装 Node.js 或 Python 的单文件托盘程序，常驻采集本机 Codex token，并发送到 VWatch Quota Hub。

首次运行填写：

- 手机正在使用的 Hub HTTPS 根地址；
- 管理面板中的手机桥接 Secret；
- 需要同步的项目文档文件夹。

项目文档会先在电脑上加密，再经 Hub 双向同步；Hub 只保存密文。发生双端修改时会保留 `.vwatch-conflict-*` 副本，不自动删除文件。

Codex 对话只做跨电脑的加密增量备份，下载到 `%LOCALAPPDATA%\VWatchCollector\ConversationBackups`，不会覆盖 Codex 正在使用的数据文件。

双击托盘图标可修改设置，右键可以立即采集、查看日志或打开备份目录。
