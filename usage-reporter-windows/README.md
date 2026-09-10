# CW Token 详情采集器

v1.0.5 通过本机 Codex app-server 读取官方账号 Token 活动，并扫描 `CODEX_HOME`（默认 `.codex`）中的 `sessions` 和 `archived_sessions`，提供本机模型用量明细。需要已登录 ChatGPT、支持 `account/usage/read` 的 Codex。程序优先查找桌面应用安装目录下的 `codex.exe`，再查找 PATH。

它不包含项目发现、文件同步、对话备份、NAS 文件读写或远程删除功能，也不会上传提示词、回答和会话原文。

运行 `build.cmd` 后，单文件程序位于 `dist/CWUsageReporter.exe`；`test.cmd` 运行数据契约测试，`test.cmd --live` 可只读验证当前登录账号的累计 Token。首次启动填写 CW HTTPS 地址、设备连接 Key 和设备名称；Key 使用当前 Windows 用户的 DPAPI 加密保存。

请搭配 CW v1.0.5 或更新版本。主窗口显示去重后的官方账号统计，官方缺失数据保持缺失，部分日数据用 `*` 标记。账号标识来自规范化邮箱的 SHA-256，不上传邮箱、登录凭据或会话正文。账号切换时重新读取身份。

金额只展示 CW 最近上报设备的本机日志，设备名称见状态栏。已知价格按输入、缓存及输出分别折算；未知价格按每百万 Token 4 美元单独估算。两部分都不代表 ChatGPT 实际账单，多设备金额不相加。

同一账号接口暂时失败时，CW 保留上次成功结果和时间；无法确认账号身份时不复用旧账号结果。离线不再根据额度百分比增长官方 Token。升级前的本地日志历史仍保留。

设置页可开关“随 Windows 登录启动”，启用后会在当前用户的启动文件夹创建快捷方式；程序默认每 5 分钟刷新一次，也可从托盘立即刷新。窗口与托盘使用 `assets/cw-usage-reporter.ico`，该多尺寸图标由 `assets/icon-source.png` 在构建时生成。
