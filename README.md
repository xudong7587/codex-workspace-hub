# VWatch Quota Hub

面向 VWatch/OrbitV 额度表盘的轻量自托管 Hub。它运行在 NAS 或家庭服务器上，用 HTTPS 服务替代必须常驻 PC 的 Token Monitor/HUB，同时保留现有手表和手机“额度桥接”App。

- 默认每 5 分钟刷新，15 分钟后缓存过期
- 空闲内存目标为几十 MiB
- 原生 HTML/CSS/JavaScript 管理面板，无前端运行时依赖
- Codex 完整接入；DeepSeek 继续由手机端处理
- Docker Compose 部署，面向常见 x86-64 与 ARM64 NAS

[详细部署](#详细部署) · [协议说明](docs/protocol.md) · [问题反馈](https://github.com/xudong7587/vwatch-quota-hub/issues)

## 它解决什么问题

```text
手表 ↔ 手机额度桥接 ↔ HTTPS VWatch Quota Hub ↔ Codex
```

公司 PC 和受管控的公司网络不再参与数据链路。手机仍通过“蓝牙运动健康渠道”把标准化额度发送到手表；Hub 只负责采集额度，并提供现有 APK 能读取的 Token Monitor 兼容接口。DeepSeek 仍由手机 App 直接处理，不经过 Hub。

## 当前支持

| Provider | Hub 采集 | 管理面板 | 写入手表协议 | 状态 |
| --- | --- | --- | --- | --- |
| Codex | 是 | 是 | 是，使用 `provider: "codex"` | 完整链路 |
| DeepSeek | 否 | 否 | 由手机 App 负责 | 不进入 Hub |
| OpenRouter | 是 | 是 | 否 | 实验性面板采集 |

OpenRouter 可读取当前 API Key 限额或账户 credits，但暂不写入手表协议。代码采用 provider 注册结构，便于继续扩展；这不代表已经兼容所有主流 AI。

## 五分钟开始部署

```bash
git clone https://github.com/xudong7587/vwatch-quota-hub.git
cd vwatch-quota-hub
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

把两次随机输出分别填入 `.env` 的 `TOKEN_MONITOR_SECRET` 和 `HUB_ADMIN_TOKEN`，然后启动服务：

```bash
docker compose build
docker compose up -d quota-hub
docker compose logs --tail=100 quota-hub
```

接下来在 NAS 本机、SSH 端口转发或受控反向代理下打开 `http://127.0.0.1:17321/admin/` 登录 Codex；再通过可信 HTTPS 域名暴露 `/api/health` 和 `/api/stats`，把根地址与 `TOKEN_MONITOR_SECRET` 填进手机“额度桥接”App。生产部署前请继续阅读[详细部署](#详细部署)和[安全与运维](#安全与运维)。

## 兼容性基线

已静态分析并适配 `com.cencen.quota.bridge` v0.2.1（versionCode 14），APK SHA-256：

```text
3B82B7651BFE14FA2980827C66262987EF0487A201FCF8663130C833DCD2CA43
```

该 APK 的 Hub 适配器只识别 `codex`、`cursor`、`antigravity`、`opencode`、`kiro`、`grok`、`copilot`。各 ID 的字段规则不同，因此 Hub 不会把 DeepSeek、OpenRouter 或其他 AI 冒充成其中任何一个。本仓库不包含或分发第三方 APK、OrbitV 或表盘文件。

## 资源设计

- 默认刷新周期：5 分钟（`300` 秒）。
- 默认缓存过期：15 分钟（`900` 秒）。连续采集失败时，最后一次成功快照仅在这段时间内可用。
- Codex 使用按需进程：每次采集时启动 `codex app-server`，完成握手和读取后立即退出，不让 Codex 子进程常驻。
- Hub Node 进程的稳态设计目标为不超过 64 MiB RSS；实际值受 NAS 架构、Node/Codex 版本和 libc 影响，应以 `docker compose stats` 为准。
- Compose 默认 `mem_limit` 为 `128m`。这是为 Codex 刷新瞬时峰值预留的部署起点，不是常驻内存值；该上限尚未在目标 NAS 上实测验证，上线前必须用真实架构和账号完成一次刷新峰值测试。
- Node 运行时 old-space 上限为 32 MiB。若 Codex 刷新期间出现退出码 137，再把 `MEM_LIMIT` 调高到 `160m` 或 `192m`，不要把硬上限当作常驻占用。

管理面板是随服务提供的原生 HTML/CSS/JavaScript，无 React/Vite 和第三方前端运行时。

## 运行要求

- Docker Engine 与 Docker Compose v2。
- NAS 能访问 OpenAI/ChatGPT 登录和 Codex 服务；若启用 OpenRouter，还需能访问其官方 API。
- 手机能访问一个由 Caddy、Nginx 或 NAS 反向代理提供的 HTTPS 域名。
- 公网证书必须受 Android 信任。不要使用公网明文 HTTP 或自签名证书。

镜像基于 Node 24 bookworm-slim，并精确固定 `@openai/codex@0.149.1`。Codex app-server 协议会随版本演进，升级 CLI 前必须重跑协议和 APK 兼容测试。参见 [OpenAI Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)。

## 详细部署

### 1. 准备两个不同的 Secret

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

把两次输出分别写入 `.env`：

```dotenv
TOKEN_MONITOR_SECRET=第一组随机值
HUB_ADMIN_TOKEN=第二组随机值
```

两者用途不同，必须不同：

- `TOKEN_MONITOR_SECRET`：只给手机“额度桥接”，用于 `/api/stats`。
- `HUB_ADMIN_TOKEN`：只给管理面板和 `/admin/api/*`，同时用于派生本地设置加密密钥。

两个值都必须至少 32 字节，不能使用 `.env.example` 中的占位符。随后限制文件权限：

```bash
chmod 600 .env
```

不要把 `.env` 提交到 Git，也不要把两个 Secret 互换或发送到手机以外的非必要客户端。

### 2. 构建并启动

```bash
docker compose build
docker compose up -d quota-hub
docker compose ps
docker compose logs --tail=100 quota-hub
```

默认只发布 NAS 宿主机回环地址 `127.0.0.1:17321`，不会直接把明文 HTTP 暴露到局域网或公网。

### 3. 登录 Codex

推荐打开管理面板，在 Codex 卡片中发起设备码登录。面板会显示验证地址和一次性代码，授权完成后会自动刷新额度。

也保留命令行方式：

```bash
docker compose run --rm quota-hub login
```

需要在命令行重新登录或切换账号时，先停止常驻服务，避免两个 app-server 同时操作认证状态：

```bash
docker compose stop quota-hub
docker compose run --rm quota-hub login
docker compose up -d quota-hub
```

Codex 登录状态保存在 `hub-data` 卷的 `/data/providers/codex`。普通 `docker compose down` 不会删除 named volume；不要执行 `docker compose down -v`，除非确定要删除 Hub 设置、provider 凭据和 Codex 登录状态。

### 4. 本机验证

```bash
curl -fsS http://127.0.0.1:17321/livez
curl -fsS http://127.0.0.1:17321/readyz
curl -fsS -H "X-Token-Monitor-Secret: $TOKEN_MONITOR_SECRET" http://127.0.0.1:17321/api/stats
docker compose stats --no-stream quota-hub
```

`/livez` 只表示进程存活；取得新鲜且可供手机桥接使用的 Codex 快照后，`/readyz` 才返回 2xx。Docker 健康检查使用镜像内的 Bash 内建 `/dev/tcp`，只向容器回环地址请求 `/livez`：它不会启动额外的 Node VM，不依赖或安装 curl/wget，也不会携带两个 Hub Secret。这样既减少每 30 秒探测的瞬时内存，也避免外网波动或登录过期触发无意义的容器重启。

容器停止宽限为 75 秒。一次全量刷新最坏可包含 Codex 约 30 秒启动与初始化、15 秒额度请求、约 4 秒子进程清理，以及可选 OpenRouter 的 15 秒请求；剩余余量用于 HTTP 收尾。该宽限让在途刷新有机会完整退出，而不是在原来的 15 秒处被强制终止。

## 管理面板

面板地址为：

```text
http://127.0.0.1:17321/admin/
```

如果浏览器不在 NAS 本机，应通过 NAS 的内网反向代理、VPN 或 SSH 端口转发访问。输入 `HUB_ADMIN_TOKEN` 后可以：

- 查看 Hub、手机桥接和 provider 状态；
- 调整刷新周期和数据过期时间；
- 在浏览器中完成 Codex 设备码登录；
- 启用、配置和手动刷新实验性 OpenRouter 采集；
- 查看 Hub 进程当前 RSS，辅助收紧资源上限。

管理令牌只保存在当前浏览器标签页的 `sessionStorage`，关闭标签页后需重新输入。静态页面本身不含凭据；所有 `/admin/api/*` 请求都要求 `Authorization: Bearer <HUB_ADMIN_TOKEN>`。

运行时设置保存在 `hub-data` 卷中的 `/data/config.json`。该文件采用 AES-256-GCM 加密，密钥由 `HUB_ADMIN_TOKEN` 派生；OpenRouter API Key 等面板配置不会以明文写入该文件。Codex 自己管理的登录文件位于 `/data/providers/codex`，同样必须把整个卷视为敏感数据。

> 更换 `HUB_ADMIN_TOKEN` 后，旧 `/data/config.json` 无法用新令牌解密。当前版本不会自动轮换密钥；变更前先规划备份和重新配置 provider。不要只改 `.env` 后直接重启。

## HTTPS 反向代理

公网只需开放 `/api/health` 和 `/api/stats`。`/livez`、`/readyz` 与 `/admin/` 不应默认暴露到公网。

### Caddy

```caddyfile
quota.example.com {
    @bridge_api path /api/health /api/stats

    handle @bridge_api {
        header Cache-Control "no-store"
        reverse_proxy 127.0.0.1:17321
    }

    handle {
        respond 404
    }
}
```

### Nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name quota.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location ~ ^/api/(health|stats)$ {
        proxy_pass http://127.0.0.1:17321;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Token-Monitor-Secret $http_x_token_monitor_secret;
        add_header Cache-Control "no-store" always;
    }

    location / {
        return 404;
    }
}
```

上面两份配置刻意不代理管理面板。需要在其他设备管理时，优先使用 LAN/VPN，并在反向代理上对 `/admin` 和 `/admin/*` 加 IP 白名单。确实需要远程访问时也必须使用 HTTPS；不要只依赖 `HUB_ADMIN_TOKEN` 把管理面板直接暴露到整个公网。若前面还有 CDN 或其他代理，先正确配置真实客户端 IP，再使用源 IP 白名单。

如果反向代理也运行在容器内，应让它与 `quota-hub` 位于同一 Docker 网络，并使用 `http://quota-hub:17321` 作为上游；不要为容器互通把端口发布到 `0.0.0.0`。

## 手机额度桥接

在“额度桥接”中填写：

- Hub URL：`https://quota.example.com`
- Secret：`.env` 中完整的 `TOKEN_MONITOR_SECRET`

Hub URL 填域名根地址，不需要追加 `/api/stats`。桥接会先访问 `/api/health`，再同时携带以下两个请求头访问 `/api/stats`：

```http
Authorization: Bearer <TOKEN_MONITOR_SECRET>
X-Token-Monitor-Secret: <TOKEN_MONITOR_SECRET>
```

若提示 Secret 鉴权失败，检查反向代理是否保留这两个请求头，以及手机和 NAS 的 Secret 是否完全一致。若提示 Hub HTTP 错误，依次检查正式证书、DNS、反向代理路径、Codex 登录和 `/readyz`。

DeepSeek 不配置在 Hub 面板中。按当前决定，它归手机 APK 的内置直连逻辑负责，再沿手机到手表的既有通道发送；若当前安装包尚未包含该能力，应在手机端另行实现和验证。Hub 的 `/api/stats` 不返回 DeepSeek，也不会借用 `opencode`、`grok` 等 ID 伪装。

## Provider 兼容矩阵

| Provider | 数据采集位置 | Hub 面板 | `/api/stats` | 手表链路 | 当前状态 |
|---|---|---:|---:|---:|---|
| Codex | Hub 按需 app-server | 支持 | `provider: codex` | 完整 | 已实现 |
| DeepSeek | 手机 APK 内置直连 | 不进入 Hub | 不返回 | 由手机端负责 | Hub 不实现 |
| OpenRouter | Hub 官方 API | 实验支持 | 不返回 | 不进入手表 | 已实现面板采集 |
| Cursor / Antigravity / OpenCode / Kiro / Grok / Copilot | 尚未实现 | 不支持 | 不返回 | 无 Hub 数据 | 仅 APK 识别这些 ID |
| Claude / Gemini / 其他 AI | 尚未实现 | 不支持 | 不返回 | 当前 APK 无对应 Hub 适配 | 未实现 |

“APK 识别 provider ID”不等于“Hub 已实现 provider”。新增 provider 必须同时具备可靠的官方额度来源、正确的字段语义、凭据保护和对应 APK 适配，不能靠改名称实现。

## OpenRouter 实验采集

面板可配置两种官方接口：

- API Key 模式：调用 `GET https://openrouter.ai/api/v1/key`，读取当前 Key 的 `usage`、`limit` 和 `limit_remaining`。
- Account credits 模式：调用 `GET https://openrouter.ai/api/v1/credits`；该接口要求 management key，读取 `total_credits` 与 `total_usage`。

参考 [OpenRouter Get current API key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key) 和 [OpenRouter Get remaining credits](https://openrouter.ai/docs/api/api-reference/credits/get-credits)。OpenRouter 数据只显示在管理面板，不会进入 Token Monitor 兼容 payload，也不会发送到手表。

## Multi-architecture 镜像

Node 24 bookworm-slim 与 Codex npm 包会按目标平台分别安装，适合常见 x86-64 和 ARM64 NAS。不要从 amd64 构建结果复制 `node_modules` 到 ARM64 镜像。

```bash
docker buildx build --platform linux/amd64,linux/arm64 --tag registry.example.com/vwatch-quota-hub:0.2.0 --push .
```

多架构发布前，应在两个目标架构分别执行 `codex --version`、设备码登录、刷新、`/api/stats` 和峰值内存冒烟测试。镜像发布时建议同时固定基础镜像 digest。

## 安全与运维

- 容器以非 root `node` 用户运行，根文件系统只读，仅 `/tmp` 和 `/data` 可写。
- Linux capabilities 已全部移除，并启用 `no-new-privileges`、PID/CPU/内存限制和日志轮转。
- Docker liveness probe 只通过容器内回环 HTTP 访问 `/livez`，不读取或发送任何 Secret。
- `codex app-server` 只通过 stdio 与 Hub 通信，绝不能直接暴露到网络。
- Provider 请求只访问实现中固定的官方 HTTPS endpoint；管理面板不能填写任意上游 URL。
- 不要在反向代理访问日志、错误页、监控标签或截图中输出 Secret/API Key。
- 怀疑 `TOKEN_MONITOR_SECRET` 泄露时更换它并同步更新手机；怀疑管理令牌泄露时，应连同 `/data/config.json` 的重新加密/重配一起规划。
- `hub-data` 包含加密设置和 Codex 登录凭据，不应进入普通 NAS 云同步；确需备份时再做卷级加密。
- Hub 不向手机返回账号邮箱、OAuth token、Cookie、API Key 或对话内容。

详细接口、字段映射和安全边界见 [docs/protocol.md](docs/protocol.md)。

## 项目状态与反馈

当前版本为 `0.2.0`。协议兼容、配置校验和服务逻辑已有自动化测试；不同 NAS 架构下的 Codex 登录、刷新峰值内存和长期运行情况仍建议在真实设备上验证。发现兼容问题或希望扩展 provider，请提交 [GitHub Issue](https://github.com/xudong7587/vwatch-quota-hub/issues)，并附上脱敏后的日志、NAS 架构、镜像版本和手机桥接版本。

这是独立的社区项目，不隶属于 vivo、OrbitV、OpenAI、DeepSeek 或 OpenRouter。第三方名称仅用于说明兼容性。
