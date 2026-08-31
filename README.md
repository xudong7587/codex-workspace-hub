# VWatch Quota Hub

给 OrbitV / VWatch 额度表盘使用的轻量 Hub：

```text
手表 ↔ 手机额度桥接 ↔ HTTPS Hub ↔ Codex
                              ↕
                     Windows 采集器 / 多电脑
```

Hub 支持 Codex 登录与额度查询，默认每 5 分钟刷新，也可限制每天的刷新时段。Windows 采集器会汇总日、周、月、累计 token 和按模型 API 单价折算的人民币参考价值，还可通过 Hub 加密同步多台电脑的项目文档。

## Docker 部署

只需下载 [`compose.yaml`](compose.yaml)：

```bash
docker compose up -d
```

Compose 会拉取公开的 amd64 `latest` 镜像，已按绿联 NAS 默认使用 `PUID=1000`、`PGID=10`。不需要 `.env`，Key 会在首次打开管理面板时生成。

浏览器打开 `http://NAS-IP:17321`，设置管理密码、连接 Codex，然后复制手机桥接 Secret。公网使用时，在 NAS 反向代理中把 HTTPS 域名转发到 `http://127.0.0.1:17321`；手机和采集器都填写 HTTPS 根地址，不追加接口路径。

## Windows 采集器

从 [Releases](https://github.com/xudong7587/vwatch-quota-hub/releases) 下载 `VWatchCollector.exe`。它是几十 KB 的单文件程序，不捆绑 Node.js、Python 或 Token Monitor。填写与手机相同的 Hub 地址和 Secret 即可。

项目文档在本机加密后同步，Hub 看不到明文；冲突会保留副本。Compose 会把中转密文保存到同目录的 `sync-data`，方便在 NAS 上备份。这里不是可直接阅读的项目副本，请勿手工修改。Codex 对话目前只做安全备份，不会覆盖或合并 Codex 的运行中数据库。详情见 [`collector-windows/README.md`](collector-windows/README.md)。

## 更新

```bash
docker compose pull
docker compose up -d --force-recreate
```

配置、登录状态、用量与同步密文都保存在 `hub-data` 数据卷中。
