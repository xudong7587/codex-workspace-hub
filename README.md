# Codex Workspace Hub

轻量的 Codex 多设备项目、对话与额度同步中心，简称 **CW**；同时兼容 OrbitV / VWatch 手机桥接和手表表盘。

```text
多台 Windows PC ↔ HTTPS Hub（Docker / NAS）↔ 手机额度桥接 ↔ 手表
         项目同步 · 对话备份 · token 统计
```

## Docker 部署

只需下载 [`compose.yaml`](compose.yaml)，然后运行：

```bash
docker compose up -d
```

打开 `http://NAS-IP:17321` 完成首次设置。Compose 会拉取公开的 amd64 `latest` 镜像，已使用绿联 NAS 的 `PUID=1000`、`PGID=10`，无需 `.env`。公网访问请用 NAS 反向代理提供 HTTPS。

`./codex-projects` 保存客户端加密后的同步数据，不是可直接浏览的项目副本；请勿手工修改。

## 第一次使用

管理面板按实际流程分成五页：开始 → PC 与项目 → Codex 额度 → 额度刷新 → 手机与手表。

- 只同步项目：在每台电脑运行 Windows 采集器，填写 CW HTTPS 地址和设备连接 Key。
- 只查看剩余额度：在 CW 的「Codex 额度」页单独完成设备码授权，不需要 PC 在线。
- 需要手机和手表：先完成 CW 的 Codex 授权，再把同一个地址和 Key 填入手机桥接 App。

PC 采集器不会上传或转移 Codex 登录凭据。CW 要在所有 PC 关机后继续刷新额度，必须拥有自己的 Codex 设备码授权。

## Windows 采集器

从 [Releases](https://github.com/xudong7587/codex-workspace-hub/releases) 下载 `CodexWorkspaceCollector.exe`，填写管理面板显示的 CW HTTPS 根地址和设备连接 Key。

填写地址和 Key 后采集器只保持连接，不会默认上传扫描到的全部目录。在「同步项目」中扫描本机 Codex 项目后逐项勾选，只有明确勾选的项目才会首次同步。每个项目可设为双向、仅上传或仅下载，不同电脑可以选择不同清单；同一项目在各电脑使用相同名称即可汇合。

v0.9.4 会自动修复旧版把多个项目误命名为 `windows-pc` 或 `项目` 的配置，稳定保留已分配的工作区 ID，并修复设备连接 Key 被旧配置反序列化清空的问题。每台 PC 只运行固定文件名 `CodexWorkspaceCollector.exe`；不要同时启动带版本号的旧副本。

默认采用智能同步：文件变化后等待 90 秒无新写入再同步，并在每天 `08:00,12:00,18:00,23:00` 兜底检查；也可以改成仅定时或仅手动。v0.9.4 的协议 v3 会复用服务端已接收偏移来断点续传，下载密文也保留本机断点；状态和项目文件均原子落盘，单个项目失败不会阻塞后续项目。

删除传播默认关闭。用户在采集器中明确启用后，本机删除会写成服务端墓碑；其他电脑不会直接抹除文件，而是移入项目内的 `.codex-sync-recovery` 可恢复目录。项目源码、配置和文档会在本机加密，`.git`、依赖、构建缓存、`.env` 和密钥文件不会上传。

托盘菜单的「同步进度」会显示当前项目、文件、阶段和百分比；CW 的「PC 与项目」页同步显示每台设备和工作区进度。

管理会话可读取 `GET /admin/api/diagnostics?limit=200`，返回脱敏的最近日志、进程状态，以及同步清单、缺失密文块、未完成上传和孤立对象检查。该接口不会返回管理密码、设备连接 Key 或项目明文。

## 更新

从旧仓库名迁移到 v0.9.0 时，先下载新版 `compose.yaml`，再执行：

```bash
docker compose down --remove-orphans
docker compose pull
docker compose up -d
```

`--remove-orphans` 会清理旧服务名留下的容器，但不会删除命名数据卷，因此已有管理设置和 Codex 授权会保留。此后普通更新只需执行后两行。镜像地址为 `ghcr.io/xudong7587/codex-workspace-hub:latest`。
