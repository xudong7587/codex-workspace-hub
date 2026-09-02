# Codex Workspace Hub

把 NAS 变成 Codex 的私人中转站：在多台电脑之间交接正在开发的项目，并集中查看 Codex 额度、Token 用量和手机/手表数据。

[![Release](https://img.shields.io/github/v/release/xudong7587/codex-workspace-hub?display_name=tag)](https://github.com/xudong7587/codex-workspace-hub/releases/latest)
[![Docker](https://img.shields.io/badge/Docker-GHCR-2496ED?logo=docker&logoColor=white)](https://github.com/xudong7587/codex-workspace-hub/pkgs/container/codex-workspace-hub)

CW 由一个运行在 NAS 上的 Docker 服务和几个按需安装的客户端组成。各部分彼此独立：只想看额度，不必安装项目同步插件；只想同步项目，也不必安装手机 APK。

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

这是一个独立、轻量的托盘程序，只读取当前 Windows 用户的 `.codex/sessions` 和 `.codex/archived_sessions` 中的 `token_count`，每 5 分钟向 CW 上报日、周、月和累计汇总。

首次启动只需填写 CW HTTPS 根地址、设备连接 Key 和设备名称。它不会上传提示词、回答或会话原文，也没有项目同步和 NAS 文件管理能力。

有采集器时，CW 优先按模型计算 API 等价价值；无法识别模型或只有总 Token 时，按每百万 Token 4 美元估算。没有采集器时，账户剩余额度仍可显示，但不会凭空生成 PC 本地的详细 Token 历史。

## 手机与手表

[前往最新 Release 下载额度桥接 APK](https://github.com/xudong7587/codex-workspace-hub/releases/latest)

安装 APK 后，在“额度桥接”中填写：

- CW 根地址，例如 `https://cw.example.com`
- 管理页面“移动端数据中心”中的设备连接 Key

不要把管理密码填进 APK。Codex 可选择 CW Hub 或设备码手机直连，两条渠道互斥，宠物卡片只展示当前选中的 Codex 渠道。CW 渠道读取后端返回的 Token 与金额；手机直连固定按每百万 Token 4 美元估算。连接成功后，手机会沿现有蓝牙健康通道发送额度给兼容手表。

当前链路面向 vivo WATCH GT、vivo WATCH GT 2 及对应的 iQOO 版本。第三方安装链路从早期 VWatch / Token Monitor 兼容方式演进到 [OrbitV](https://orbitv.top/) 和它的[轻腕市场](https://qingwear.top/)，额度表盘名称为 `Clawd_on_Vwatch`。早期 vivo WATCH 1/2 与 WATCH GT 系列不是同一平台，不在这条链路的支持范围内。

beta8 APK 的 SHA-256 为 `5CE118B07FE7C89A8D685B4F85BE70F7FE9B0977C303299772142C4DAEDF0843`。

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

CW 的设备码授权能读取账户剩余额度，但详细 Token 历史来自 PC 本地 Codex 会话。请安装 `CWUsageReporter.exe` 并保持它运行。

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
