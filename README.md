# Codex Workspace Hub

Codex Workspace Hub（CW）是在 NAS / Docker 上运行的轻量中转服务。项目同步由 **CW Development Sync Codex 插件**发起：Codex 审查当前 Git 开发变化，用户确认后才把所选文件压缩、端到端加密并发布为开发快照。

```text
PC A 的 Codex 插件 ↔ HTTPS CW（NAS 密文存储）↔ PC B 的 Codex 插件
       选择与加密                                  预览与安全应用
```

旧的多功能 Windows 项目采集器和逐文件 manifest 协议已弃用。连接 CW 不会扫描或上传全部项目。Token 用量由独立的轻量采集器上报，它不具备任何项目文件能力。

## Docker 部署

```yaml
services:
  codex-workspace-hub:
    image: ghcr.io/xudong7587/codex-workspace-hub:latest
    container_name: codex-workspace-hub
    restart: unless-stopped
    ports:
      - "17321:17321"
    volumes:
      - ./cw-data:/data
    environment:
      TZ: Asia/Shanghai
      PUID: "1000"
      PGID: "10"
```

打开 `http://NAS-IP:17321` 完成首次设置；公网使用时必须由反向代理提供 HTTPS。项目快照保存在 `/data/development-snapshots`，内容是客户端加密包，不能在 NAS 上直接浏览。

## Codex 插件

插件源码位于 [`plugin/cw-development-sync`](plugin/cw-development-sync)，可复制到每台 PC 的个人插件目录并通过 Codex personal marketplace 安装。当前开发机的个人插件位于 `C:\Users\Sunny\plugins\cw-development-sync`。插件包含：

- `cw_prepare_snapshot`：读取 Git 基线或当前增量，返回候选与排除项，不上传。
- `cw_publish_snapshot`：只发布用户确认的准确路径。
- `cw_list_snapshots` / `cw_preview_snapshot`：列出并在本机比较远端快照。
- `cw_apply_snapshot`：原子写入；冲突写入 `.cw-conflicts`，安全删除移动到 `.cw-recovery`。

每台 PC 首次使用时，在插件目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\configure.ps1
```

脚本只在本机提示输入 CW HTTPS 地址和设备连接 Key，Key 通过 Windows DPAPI 写入 `%LOCALAPPDATA%\CWDevelopmentSync\config.json`。不要把 Key 放入 Git、插件清单或对话消息。

普通开发使用增量模式，只候选 staged、unstaged 和未跟踪文件。首次建立快照可使用 baseline 模式，但必须先审查候选清单。以下内容无论模型选择与否都会被硬过滤：

- `.git`、依赖树、SDK/工具链、编辑器和构建缓存；
- `dist`、`build`、`out`、`target`、`bin`、`obj`、coverage；
- `.env`、证书、私钥、credentials/secrets 文件；
- CW 的冲突、恢复和本机状态目录。

同一 Git remote 会生成相同的建议 workspace ID，从而跨 PC 匹配。无 remote 的本地项目需要显式使用相同 workspace ID。

## 移动端数据中心

管理页的“移动端数据中心”以手机为入口：先安装额度桥接 APK，再填入 CW 的 HTTPS 根地址和设备连接 Key。手机可直接读取 CW 中的 Codex 额度，并沿现有蓝牙健康通道发送到兼容表盘；PC 项目同步不参与这条链路。

当前随仓库保留的版本是 [`CWQuotaBridge-android-v0.3.1-beta7.apk`](public/downloads/CWQuotaBridge-android-v0.3.1-beta7.apk)，管理页可直接下载，后续 tagged Release 也会附带同一文件。SHA-256：

```text
03C86C014A97D190F626FCE3D5CD3DA7D250C44570007A81FB3549F363CE2CF4
```

已知目标机型包括 vivo WATCH GT、vivo WATCH GT 2，以及同平台的 iQOO WATCH GT / GT 2。这里的“GT1”指第一代 vivo WATCH GT，不是旧款圆形 vivo WATCH 1。第三方安装入口从早期 VWatch / Token Monitor 兼容链路演进到 [OrbitV](https://orbitv.top/) 与其内置的[轻腕市场](https://qingwear.top/)；额度表盘名称为 `Clawd_on_Vwatch`。兼容性最终以手表系统与 OrbitV 当前版本为准，旧款 vivo WATCH 1 / WATCH 2 不支持这套第三方应用与表盘安装链路。

## Windows Token 详情采集器

[`usage-reporter-windows`](usage-reporter-windows) 是与项目同步完全独立的单文件托盘程序。首次启动只需填写 CW HTTPS 地址、设备连接 Key 和设备名称，之后默认随 Windows 启动并每 5 分钟上报一次。

它只读取当前用户 `.codex/sessions` 与 `.codex/archived_sessions` 中的 `token_count` 统计，向 CW 发送今日、本周、本月和累计汇总；不会上传提示词、回答、会话原文或项目文件。连接 Key 使用 Windows DPAPI 加密保存。

```powershell
cd usage-reporter-windows
.\build.cmd
```

单文件输出为 `usage-reporter-windows\dist\CWUsageReporter.exe`。CW 能识别模型时按输入、缓存输入和输出单价估算 API 等价价值；没有可识别价格但存在 Token 总数时，管理页按每百万 Token 4 美元显示粗略估算。完全没有采集数据时，今日和本周价值保持空白并提示安装采集器。

## 快照可靠性

- 内容寻址：加密包完成后校验 SHA-256。
- 断点续传：上传和下载最多 1 MiB 一块，服务端返回已接收偏移。
- 并发保护：提交必须携带当前 `parentSnapshotId`；远端 head 已变化时返回 HTTP 409。
- 端到端加密：AES-256-CBC + HMAC-SHA256；NAS 不接触文件明文。
- 可恢复删除：接收端不直接永久删除项目文件。
- 诊断：管理接口报告缺失对象和未完成上传，不返回连接 Key 或明文。

## 兼容边界

旧 `/api/collector/v1/sync/*` 已移除。`/api/collector/v1/usage` 仅供轻量 Token 详情采集器按设备覆盖上报；它不会接受项目文件。CW 登录 Codex 账号后可独立读取剩余额度百分比，但 Codex 账号额度接口不提供各 PC 的本地日、周和累计 Token 明细。

## 开发验证

```powershell
npm run check
npm test
```

当前改造尚未发布新版镜像或 GitHub Release。发布前应先用一个小项目完成：基线发布 → 另一台 PC 预览/应用 → 两端分别修改同一文件验证冲突 → 中断并恢复分块上传。

协议细节见 [docs/protocol.md](docs/protocol.md)。
