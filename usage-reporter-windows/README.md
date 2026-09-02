# CW Token 详情采集器

这是一个只负责 Codex Token 用量的轻量 Windows 托盘程序。它读取当前 Windows 用户的 `.codex/sessions` 与 `.codex/archived_sessions`，只向 CW 上报按日、周、月、累计汇总后的 Token 计数和 API 等价价值。

它不包含项目发现、文件同步、对话备份、NAS 文件读写或远程删除功能，也不会上传提示词、回答和会话原文。

运行 `build.cmd` 后，单文件程序位于 `dist/CWUsageReporter.exe`。首次启动填写 CW HTTPS 地址、设备连接 Key 和设备名称；Key 使用当前 Windows 用户的 DPAPI 加密保存。程序默认随 Windows 启动，每 5 分钟刷新一次，也可从托盘立即刷新。
