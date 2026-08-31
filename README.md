# Codex Workspace Hub

轻量的 Codex 多设备项目、对话与额度同步中心，同时兼容 OrbitV / VWatch 手机桥接和手表表盘。

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

## Windows 采集器

从 [Releases](https://github.com/xudong7587/vwatch-quota-hub/releases) 下载 `CodexWorkspaceCollector.exe`，填写与手机相同的 Hub HTTPS 根地址和 Secret。

默认采用智能同步：文件变化后等待 90 秒无新写入再同步，并在每天 `08:00,12:00,18:00,23:00` 兜底检查；也可以改成仅定时或仅手动。项目源码、配置和文档会在本机加密后双向同步，`.git`、依赖、构建缓存、`.env` 和密钥文件不会上传。Codex 对话仅在停止写入后加密备份，不会覆盖另一台电脑正在使用的 Codex 数据。

## 更新

```bash
docker compose pull
docker compose up -d --force-recreate
```

镜像与仓库地址为了兼容旧版仍保留 `vwatch-quota-hub` 名称。
