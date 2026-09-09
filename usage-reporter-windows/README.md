# CW Token 详情采集器

这是一个只负责 Codex Token 用量的轻量 Windows 托盘程序。它读取当前 Windows 用户的 `.codex/sessions` 与 `.codex/archived_sessions`，只向 CW 上报按日、周、月、累计汇总后的 Token 计数和 API 等价价值。

它不包含项目发现、文件同步、对话备份、NAS 文件读写或远程删除功能，也不会上传提示词、回答和会话原文。

运行 `build.cmd` 后，单文件程序位于 `dist/CWUsageReporter.exe`。首次启动填写 CW HTTPS 地址、设备连接 Key 和设备名称；Key 使用当前 Windows 用户的 DPAPI 加密保存。主窗口会显示 CW 汇总的今日、本周、本月和累计 Token，并按服务器当前汇率显示人民币 API 等价价值。已识别模型按各自输入、缓存输入和输出单价计算；只有无法识别模型对应的 Token 才按每百万 Token 4 美元补估，该周期会明确显示“估算”。

采集器离线后，CW 会保留最后精确快照，并根据 Codex 账号额度窗口的变化提供明确标注的离线估算；采集器恢复上报时自动重新校准。

设置页可开关“随 Windows 登录启动”，启用后会在当前用户的启动文件夹创建快捷方式；程序默认每 5 分钟刷新一次，也可从托盘立即刷新。窗口与托盘使用 `assets/cw-usage-reporter.ico`，该多尺寸图标由 `assets/icon-source.png` 在构建时生成。
