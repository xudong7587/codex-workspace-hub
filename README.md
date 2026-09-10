# Codex Workspace Hub

把 NAS 变成 Codex 的私人中转站：在多台电脑之间交接正在开发的项目，并集中查看 Codex 额度、Token 用量和手机/手表数据。

[![Release](https://img.shields.io/github/v/release/xudong7587/codex-workspace-hub?display_name=tag)](https://github.com/xudong7587/codex-workspace-hub/releases/latest)
[![Docker](https://img.shields.io/badge/Docker-GHCR-2496ED?logo=docker&logoColor=white)](https://github.com/xudong7587/codex-workspace-hub/pkgs/container/codex-workspace-hub)

CW 由一个运行在 NAS 上的 Docker 服务和几个按需安装的客户端组成。各部分彼此独立：只想看额度，不必安装项目同步插件；只想同步项目，也不必安装手机 APK。

当前发布版本为 CW `v1.0.5`，Windows Token 详情采集器同为 `v1.0.5`。Android 额度桥接仍为 `v0.3.3-beta9`。

## 我应该安装什么

| 你的需求 | 需要安装 |
| --- | --- |
| 在浏览器查看 Codex 剩余额度 | NAS 上的 CW Docker |
| 在多台 PC 之间交接开发进度 | CW Docker + 每台 PC 上的 Codex 插件 |
| 查看今日、本周、当月 Token 和更准确的价值估算 | CW Docker + Windows Token 详情采集器 |
| 把额度显示到手机或兼容手表 | CW Docker + Android 额度桥接 APK |

旧版 `CodexWorkspaceCollector.exe` 已弃用。它曾经自动扫描和上传整批项目，容易把历史版本、构建产物和不再开发的目录一起带走。现在的项目同步由 Codex 插件完成：先检查 Git 变化、列出文件，得到你的确认后才上传。

## 工作方式

```text
电脑 A 的 Codex ─┐
电脑 B 的 Codex ─┼─ 加密开发快照 ──> NAS 上的 CW Docker
电脑 C 的 Codex ─┘                    │
                                      ├─ 管理页面与版本记录
Windows Token 采集器 ── 汇总数据 ──────┤
                                      └─ 手机 APK ──> 兼容手表
```

- 项目文件在电脑上完成打包和加密，NAS 只保存密文、校验信息和版本元数据。
- CW 不会在连接时扫描或上传全部项目。你在哪个项目里让 Codex 准备快照，就只处理那个项目。
- 同一 Git 远程地址会得到相同的工作区 ID，因此不同电脑可以自动匹配同一个项目。
- 没有 Git 远程地址的目录也能同步，但各台电脑必须使用同一个明确的工作区 ID。
- 应用快照前会先预览。冲突文件放进 `.cw-conflicts`，安全删除前的内容放进 `.cw-recovery`。

## 第一步：在 NAS 部署 CW

需要 Docker Engine 和 Docker Compose。新建一个目录，把下面内容保存为 `compose.yaml`：

```yaml
services:
  workspace-hub:
    image: ghcr.io/xudong7587/codex-workspace-hub:latest
    pull_policy: always
    restart: unless-stopped
    init: true
    environment:
      HOST: 0.0.0.0
      PORT: 17321
      POLL_INTERVAL_SECONDS: 300
      MANUAL_REFRESH_COOLDOWN_MS: 5000
      STALE_AFTER_SECONDS: 900
      LOG_LEVEL: info
      TZ: Asia/Shanghai
      PUID: "1000"
      PGID: "10"
    ports:
      - "17321:17321"
    volumes:
      - hub-data:/data
      - ./cw-snapshots:/data/development-snapshots
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETGID
      - SETUID
    mem_limit: 128m
    cpus: 0.50
    pids_limit: 64
    stop_grace_period: 75s
    healthcheck:
      test: ["CMD", "wget", "-q", "-T", "5", "-O", "/dev/null", "http://127.0.0.1:17321/livez"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "2"

volumes:
  hub-data:
```

在这个目录运行：

```bash
docker compose up -d
```

然后在浏览器打开：

```text
http://你的-NAS-IP:17321/admin/
```

首次设置只能从 NAS 本机或局域网直连完成。页面会要求创建一个至少 12 位的管理密码，并自动生成设备连接 Key。

这两个凭据用途不同：

- **管理密码**：只用于登录 CW 管理页面。
- **设备连接 Key**：用于连接 Codex 插件、Windows Token 采集器和手机 APK。

如果需要从公网访问，请在 NAS 反向代理中配置 HTTPS，并把 CW 的 `17321` 端口作为上游。客户端应填写反代后的 **CW 根地址**，例如 `https://cw.example.com`，不要填写 `/admin/`。

## 第二步：连接 Codex 额度

登录管理页面，进入“移动端数据中心”，在 Codex 卡片中选择设备码登录。按页面提示打开 OpenAI 登录地址并输入设备码。

授权成功后，CW 会独立保存加密凭据并定时刷新剩余额度。即使所有 PC 都关机，NAS 仍可以继续刷新。这一步读取的是账户额度，不会读取 PC 上的项目文件或 Codex 会话。

## 多台 PC 同步开发进度

### 1. 安装 CW Development Sync 插件

CW 插件目前通过本仓库的插件目录分发。需要支持插件的 Codex 桌面应用或 Codex CLI；Codex IDE 扩展目前不支持插件。官方说明见 [Codex 插件文档](https://learn.chatgpt.com/docs/plugins)。

在 Codex CLI 中运行：

```text
codex plugin marketplace add xudong7587/codex-workspace-hub --ref main
codex plugin add cw-development-sync@codex-workspace-hub
```

也可以在添加 marketplace 后打开 Codex 的插件页，选择 **Codex Workspace Hub**，再安装 **CW Development Sync**。安装完成后请新建一个 Codex 任务，使插件工具被加载。

### 2. 连接这台电脑

打开 PowerShell，进入仓库目录后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\plugin\cw-development-sync\scripts\configure.ps1
```

按提示输入：

1. CW 的 HTTPS 根地址，例如 `https://cw.example.com`
2. 当前电脑的设备名称
3. 管理页面“PC 项目同步”中显示的设备连接 Key

Key 会使用当前 Windows 用户的 DPAPI 加密保存到 `%LOCALAPPDATA%\CWDevelopmentSync\config.json`。

如果你只通过 marketplace 安装了插件、没有克隆仓库，可以先让 Codex 执行：

> 帮我配置 CW Development Sync 插件。

Codex 会定位已安装插件中的配置脚本并打开输入流程。

### 3. 第一次上传一个项目

在 Codex 中打开准备同步的项目，直接说：

> 检查当前项目，准备第一次 CW 基线快照，只预览，不要上传。

Codex 会列出准备上传和排除的文件。确认列表无误后再说：

> 确认发布刚才列出的文件。

第一次建议选一个小项目验证。插件不会因为连接成功就自动上传其他项目。

### 4. 在另一台电脑接收项目进度

在另一台电脑安装并配置同一插件，打开同一个 Git 仓库，然后说：

> 查看 CW 上这个项目的最新快照，只预览，不要应用。

检查新增、修改、删除和冲突列表后，再说：

> 应用刚才预览的快照。

### 5. 日常增量同步

继续开发后，在发送端说：

> 检查当前 Git 变化，准备一个 CW 增量快照，只预览。

确认后发布；另一台电脑仍然先预览、再应用。CW 保存每次快照的版本记录，可以随时查看旧版本，但它不是 Git 的替代品，重要里程碑仍建议正常提交和推送 Git。

插件会主动排除常见密钥、依赖、缓存和构建输出。单文件上限为 32 MiB，单次明文快照上限为 192 MiB；快照采用分块传输，服务端的加密包上限为 256 MiB。

## Windows Token 详情采集器

[下载最新版 CWUsageReporter.exe](https://github.com/xudong7587/codex-workspace-hub/releases/latest/download/CWUsageReporter.exe)

这是一个独立的托盘程序，每 5 分钟通过本机 Codex app-server 的 [`account/usage/read`](https://learn.chatgpt.com/zh-Hans/docs/app-server) 读取官方账号 Token 活动，同时扫描 `CODEX_HOME`（默认 `.codex`）中的会话用量数字，提供本机模型和金额明细。需要本机 Codex 已登录 ChatGPT，且安装的 Codex 支持该接口。

首次启动只需填写 CW HTTPS 根地址、设备连接 Key 和设备名称。地址和设备名保存在当前 Windows 用户目录，Key 使用 DPAPI 加密；配置还会保留一份本地备份。启用开机自启后，采集器只在托盘后台运行，不会每次弹出设置窗口。它不会上传提示词、回答或会话原文，也没有项目同步和 NAS 文件管理能力。

CW 按账号去重官方统计。同一 ChatGPT 账号在两台电脑上报时，只采用最近一次成功读取的结果；累计值直接使用官方返回值，不加本地日志或额度推算增量。账号身份以规范化邮箱的 SHA-256 标识传输，不上传邮箱和登录凭据。切换账号后，不会沿用前一个账号的数字。

官方日数据可能延迟或缺失。缺失的今日数据显示“官方暂未返回”；周、月只累计已返回日期并标明部分数据，日期边界采用 UTC。接口失败且仍能确认同一账号时，保留上次成功值及读取时间；采集器离线后也只显示缓存，不补估官方 Token。

官方接口不提供模型费用明细。金额单独展示最近上报设备的本机日志：已识别模型按内置输入、缓存和输出单价折算，未知价格部分按每百万 Token 4 美元估算，两部分分别显示。该金额不代表账号完整费用或 ChatGPT 实际账单。为避免复制或同步过的日志重复计价，多台设备的日志金额不相加；页面注明当前明细来自哪台设备。

升级时先更新 CW Docker，再替换各 PC 的采集器。旧版日志历史仍可读取，但不会混入已取得的官方账号总量。旧版采集器单独运行时仍沿用原来的日志/离线估算协议，页面会注明旧版数据来源。

## 手机与手表

[下载额度桥接 v0.3.3-beta9 APK](https://github.com/xudong7587/codex-workspace-hub/releases/latest/download/CWQuotaBridge-android-v0.3.3-beta9.apk)

安装 APK 后，在“额度桥接”中填写：

- CW 根地址，例如 `https://cw.example.com`
- 管理页面“移动端数据中心”中的设备连接 Key

不要把管理密码填进 APK。Codex 可选择 CW Hub 或设备码手机直连，两条渠道互斥，宠物卡片只展示当前选中的 Codex 渠道。CW 的新账号统计协议返回官方 Token；缺失周期及官方费用为 `null`，本机费用另置于 `localDetails`。本次没有更新 APK，旧客户端可能不识别这些状态，请以 CW 管理页或新版 Windows 采集器为准。手机直连仍按每百万 Token 4 美元估算。额度和蓝牙桥接协议不变。

当前链路面向 vivo WATCH GT、vivo WATCH GT 2 及对应的 iQOO 版本。第三方安装链路从早期 VWatch / Token Monitor 兼容方式演进到 [OrbitV](https://orbitv.top/) 和它的[轻腕市场](https://qingwear.top/)，额度表盘名称为 `Clawd_on_Vwatch`。早期 vivo WATCH 1/2 与 WATCH GT 系列不是同一平台，不在这条链路的支持范围内。

beta9 调整了 4×2 和 5×2 桌面小挂件：拉伸后气泡、宠物、额度环和金额会保持均衡间距；金额列加宽，并按内容自动缩小字号，五位金额也能完整显示。

beta9 APK 的 SHA-256 为 `5C9237BAB4AF07FF9C3154240F1E00E567B50663479E3B36A9B4D5EF2CE3B123`。它与 beta8 使用同一签名，可以直接覆盖安装并保留原有配置。若桌面仍缓存旧布局，请删除原小挂件后重新添加。

APK 不接触 PC 项目文件。DeepSeek 仍由 APK 直接连接，不经过 CW Docker。

## 更新与备份

更新 Docker：

```bash
docker compose pull
docker compose up -d --force-recreate
```

配置、额度历史和凭据保存在 `hub-data` 数据卷中，开发快照保存在 compose 文件旁的 `cw-snapshots`。更新前建议同时备份这两处。

不要执行 `docker compose down -v`，除非你明确要删除 CW 的数据卷。普通的 `docker compose down` 不会删除命名卷。

更新插件 marketplace：

```text
codex plugin marketplace upgrade codex-workspace-hub
codex plugin add cw-development-sync@codex-workspace-hub
```

更新后新建一个 Codex 任务。

## 常见问题

### 为什么插件没有自动上传全部项目？

这是设计行为。CW 只同步你在当前项目中确认过的开发快照，不运行后台全盘扫描。

### 为什么两台电脑匹配不到同一个项目？

先确认两边仓库的 Git remote 一致。没有 remote 时，在两边使用相同的工作区 ID。

### 为什么页面有额度，却没有今日或本周 Token 价值？

额度窗口与 Token 活动是不同接口。安装新版 `CWUsageReporter.exe` 并在本机登录 ChatGPT 后，采集器会读取官方 Token 活动。官方未返回当天数据时，今日栏会暂缺；读取失败或本机 Codex 版本不支持接口时，也不会用日志数字冒充账号总量。金额只覆盖页面注明的设备日志。

### 为什么 APK 或插件提示 401/403？

确认填写的是设备连接 Key，不是管理密码；地址应为 HTTPS 根地址，不应带 `/admin/`。如果使用反向代理，还要确认代理没有移除认证请求头。

### 快照失败后会不会破坏本地项目？

准备和预览操作都是只读的。应用快照时，插件会把冲突与删除前的文件保留到恢复目录，不会静默覆盖无法确认的本地修改。

### 如何查看故障原因？

管理页面提供运行状态、同步进度和诊断日志。Docker 侧也可以查看：

```bash
docker compose logs --tail=200 workspace-hub
```

提交问题时请删除域名、设备连接 Key、管理密码和其他私密信息。

## 数据与安全边界

| 数据 | 保存位置 | 说明 |
| --- | --- | --- |
| 管理密码 | NAS 数据卷 | 使用密码哈希保存 |
| Codex 授权凭据 | NAS 数据卷 | 使用 CW 内部密钥加密 |
| 项目快照 | `cw-snapshots` | PC 端加密后上传，NAS 保存密文 |
| 插件连接 Key | 当前 Windows 用户配置 | 使用 DPAPI 加密 |
| Token 汇总 | NAS 数据卷 | 仅汇总计数与估值，不含会话正文 |

CW 面向个人 NAS 和可信设备。公开到互联网时必须使用 HTTPS、强管理密码和独立的设备连接 Key；怀疑 Key 泄露时，可在管理页面重新生成，旧客户端会立即失效。

## 下载与开发

- [最新 GitHub Release](https://github.com/xudong7587/codex-workspace-hub/releases/latest)
- [Docker 镜像](https://github.com/xudong7587/codex-workspace-hub/pkgs/container/codex-workspace-hub)
- [CW Development Sync 插件源码](plugin/cw-development-sync)
- [同步与接口协议](docs/protocol.md)
- [Windows Token 采集器说明](usage-reporter-windows/README.md)

本地开发需要 Node.js 20 或更高版本：

```bash
npm install
npm run check
npm test
npm start
```

默认管理页面为 `http://127.0.0.1:17321/admin/`。`npm start` 使用本地 `.hub-data`，不要把这个目录提交到 Git。
