# VWatch Quota Hub

给 VWatch/OrbitV 额度表盘使用的轻量 Hub，用 NAS 替代需要常驻 PC 的 Token Monitor：

```text
手表 ↔ 手机额度桥接 ↔ HTTPS VWatch Quota Hub ↔ Codex
```

Codex 已支持完整额度链路；DeepSeek 继续由手机端处理。默认每 5 分钟刷新，服务常驻内存目标为几十 MiB。

## 部署

下载仓库里的 [`compose.yaml`](compose.yaml)，放到 NAS 的任意空目录，然后运行：

```bash
docker compose up -d
```

不需要 `.env`，也不需要手工生成任何 Key。Compose 会直接拉取 GitHub Container Registry 中公开的 amd64 镜像。

Compose 已按绿联 NAS 设置 `PUID=1000`、`PGID=10`。

浏览器打开：

```text
http://NAS-IP:17321
```

首次进入时：

1. 设置管理密码。
2. 在面板复制自动生成的手机桥接 Secret。
3. 点击“连接账号”完成 Codex 设备码登录。
4. 把 HTTPS 地址和 Secret 填入手机“额度桥接”App。

首次设置只能从 NAS 本机或局域网直连完成。请先完成设置，再配置公网访问。

## HTTPS

手机桥接请使用受 Android 信任的 HTTPS 地址。在 NAS 反向代理中把域名转发到：

```text
http://127.0.0.1:17321
```

手机中填写域名根地址，例如 `https://quota.example.com`，不要追加 `/api/stats`。

## 更新与查看日志

```bash
docker compose pull
docker compose up -d --force-recreate
docker compose logs -f quota-hub
```

配置、Codex 登录状态和自动生成的 Secret 都保存在 `hub-data` 数据卷中，更新或重启容器不会丢失。

旧版若出现 `/data/credentials.json` 的 `EACCES`，执行上面的更新命令即可；新版会在启动时修正数据卷权限，然后降权运行。
