# Codex Workspace Hub 协议说明

本文定义 Codex Workspace Hub、provider 与现有“额度桥接”APK 之间的协议和安全边界。正确链路是：

```text
手表 ↔ 手机额度桥接 ↔ HTTPS Hub ↔ provider
```

Hub 以 Token Monitor 兼容为目标，但不会把 provider 的内部协议、账号凭据或管理 API 直接暴露给手机。公司 PC 和公司网络不参与这条链路。

静态兼容基线为 `com.cencen.quota.bridge` v0.2.1（versionCode 14），APK SHA-256：`3B82B7651BFE14FA2980827C66262987EF0487A201FCF8663130C833DCD2CA43`。APK 更新后应重新核对接口与字段，不能只凭包名假设仍兼容。

## Provider 范围

`limits.providers` 是可扩展数组，但手机只选择当前套餐所配置的 provider。当前 Hub 只有 Codex 能生成手机桥接 payload，因此 `/api/stats` 只返回 `provider: "codex"`。OpenRouter 数据只进入管理面板。

当前 APK 的 Hub provider ID 仅为：

- `codex`
- `cursor`
- `antigravity`
- `opencode`
- `kiro`
- `grok`
- `copilot`

这些 adapter 的窗口和计费字段不同，不能只改名称或复用 Codex 数据。Hub 当前没有实现列表中除 Codex 外的 provider。

DeepSeek 按用户决定由手机 APK 内置直连处理，不进入 Hub，也不写入 `limits.providers`。OpenRouter 是实验性面板采集，不进入手表协议。Claude、Gemini 和其他 AI 当前既没有 Hub collector，也没有对应 APK Hub adapter；不应宣称支持。

| Provider | 采集方 | Hub 面板 | `/api/stats` | 手表链路 |
|---|---|---:|---:|---:|
| Codex | Hub 按需 app-server | 支持 | `provider: codex` | 完整 |
| DeepSeek | 手机 APK 内置直连 | 不进入 Hub | 不返回 | 手机端负责 |
| OpenRouter | Hub 官方 API | 实验支持 | 不返回 | 不进入手表 |
| 其他 APK provider ID | 尚未实现 | 不支持 | 不返回 | 无 Hub 数据 |

“APK 识别 ID”与“Hub 已实现 provider”是两件事。新增 provider 必须具备可靠的数据源和正确的 APK 字段映射，禁止冒充现有 ID。

## 外部 HTTP 接口

公网传输必须是 HTTPS。容器内的 HTTP 端口由 Compose 绑定到宿主机回环地址，并由同机 Caddy、Nginx 或 NAS 反向代理终止 TLS。公网默认只允许 `/api/health` 和 `/api/stats`。

所有 JSON 响应使用：

```http
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
```

### `GET /api/health`

Token Monitor 兼容的连通性检查，无需鉴权。成功时返回任意 JSON object，例如：

```json
{"ok":true}
```

桥接要求状态码为 2xx 且响应体能解析为 JSON object。实际响应可包含脱敏的 ready/fresh/更新时间状态，但不得返回账号、额度明细、凭据或内部错误堆栈。

### `GET /api/stats`

额度快照接口。桥接当前会同时发送：

```http
Authorization: Bearer <TOKEN_MONITOR_SECRET>
X-Token-Monitor-Secret: <TOKEN_MONITOR_SECRET>
Accept: application/json
```

服务端兼容这两种鉴权形式，并使用恒定时间比较。APK 当前同时发送两者。Secret 缺失返回 401，错误返回 403；桥接会把两者都显示为 Secret 鉴权失败。其他非 2xx 状态会显示为 Hub HTTP 错误。

最小有效响应：

```json
{
  "limits": {
    "providers": [
      {
        "provider": "codex",
        "status": "ok",
        "stale": false,
        "updatedAt": 1787738400000,
        "accountLabel": "Plus",
        "windows": [
          {
            "kind": "session",
            "usedPercent": 18,
            "resetsAt": "2026-08-26T18:00:00Z"
          },
          {
            "kind": "weekly",
            "usedPercent": 33,
            "resetsAt": "2026-09-01T00:00:00Z"
          }
        ]
      }
    ]
  }
}
```

字段约束：

- `provider` 必须为 `codex`。
- `status` 仅使用 `ok` 或 `rateLimited`。
- `stale` 必须为 `false`；桥接会拒绝 `stale: true` 的 provider。
- `updatedAt` 是 Unix epoch 毫秒。
- `accountLabel` 是可选的套餐标签，不应包含邮箱。
- `windows` 至少包含 `session` 或 `weekly` 之一。
- 百分比可为 JSON number 或数字字符串。Hub 统一输出上游原值 `usedPercent`，不计算也不输出 `remainingPercent`。
- 桥接负责把 `usedPercent` 转换为剩余百分比，并在显示时四舍五入、限制到 0–100。把转换后的剩余值再次作为 `usedPercent` 输出会造成双重反转。
- `resetsAt` 使用 ISO-8601 Instant，例如 `2026-08-26T18:00:00Z`。无法解析时桥接只把重置时间显示为不可用。

桥接选择行为：

- 若出现多个 `codex` provider，先选 `status: ok`，再选 `updatedAt` 更新者。
- `session` 映射到表盘的短窗口额度和重置时间。
- `weekly` 映射到表盘的周额度和重置时间。
- 缺少 `weekly` 时，桥接会暂时复用 session 百分比，但周重置时间不可用。
- 缺少 `session` 时，桥接仍可显示周额度，但不会声称存在短窗口。

默认每 300 秒采集一次，最后一次成功快照在 900 秒内保持可用。尚未登录、从未成功采集，或最后一次成功快照超过 `STALE_AFTER_SECONDS` 时，`/api/stats` 返回 503，不把未知数据伪装成 0% 或 100%。OpenRouter 是否新鲜不影响 `/api/stats`，因为它不是 bridge-compatible provider。

### 本机运维接口

- `GET /livez`：进程和 HTTP 服务存活即返回 2xx；不要求已登录。
- `GET /readyz`：存在至少一个新鲜且可供手机桥接使用的 provider 快照才返回 2xx；当前即 Codex 快照。

两者都无需鉴权，但不应通过公网反向代理开放。Docker 健康检查用 `/bin/bash` 的内建 `/dev/tcp` 直接请求 `127.0.0.1:17321/livez`，不启动额外 Node VM、不依赖或安装 curl/wget，也不携带任何凭据。探针只判断本地 HTTP 进程存活，避免外部网络或账号登录过期触发容器重启风暴。

## 管理面板与管理 API

静态面板位于 `GET /admin/`，资源为 `/admin/app.css` 和 `/admin/app.js`。首次启动时 Hub 自动生成内部加密密钥和手机桥接 Secret，用户只需在面板设置至少 12 个字符的管理密码。首次设置拒绝代理请求，并且只接受 NAS 本机或 RFC 1918/ULA 局域网来源，避免服务尚未认领时被公网抢先接管。

管理密码使用 scrypt 加随机 salt 保存，不以明文落盘。登录成功后服务签发 12 小时内有效的随机内存会话；浏览器只把会话令牌保存在当前标签页的 `sessionStorage`，并对受保护的 `/admin/api/*` 使用：

```http
Authorization: Bearer <ADMIN_SESSION_TOKEN>
```

手机桥接 Secret 是独立的 32 字节随机值，只返回给已登录的管理面板。重新生成后旧 Secret 立即失效。管理 API 不会把 provider API Key 返回给浏览器。

当前面板使用的内部端点：

- `GET/POST /admin/api/setup`：读取首次设置状态，或从本机/局域网直连设置管理密码。
- `POST/DELETE /admin/api/session`：登录并创建会话，或退出当前会话。
- `GET /admin/api/state`：读取脱敏状态、设置、provider 指标和 Hub RSS。
- `POST /admin/api/bridge/rotate`：重新生成手机桥接 Secret。
- `PUT /admin/api/settings`：更新刷新周期和 stale 周期。
- `POST /admin/api/refresh`：手动刷新全部已启用且已配置的 provider。
- `PUT /admin/api/providers/:id`：启停或更新 provider 设置；Secret 留空表示保留原值。
- `POST /admin/api/providers/:id/refresh`：刷新指定 provider。
- `GET /admin/api/diagnostics?limit=200`：返回脱敏的内存日志、进程资源和同步存储一致性检查；`limit` 范围 1–1000。
- `POST /admin/api/providers/codex/login`：开始设备码登录；面板使用 `X-CW-Login-Id` 为本轮流程绑定随机会话 ID。
- `GET /admin/api/providers/codex/login`：读取设备码登录状态。
- `DELETE /admin/api/providers/codex/login?id=<session-id>`：仅在 ID 仍匹配时取消未完成的设备码登录并停止临时 app-server；面板关闭登录窗口或页面时会调用它，延迟到达的旧页面请求不会取消新会话。

手动刷新默认有 60 秒冷却，过于频繁返回 429 和 `Retry-After`。刷新周期允许 60–86400 秒；stale 周期不得短于刷新周期，最大 604800 秒。默认分别为 300 秒与 900 秒。

### Windows 工作区同步协议 v3

采集器接口使用设备连接 Key 鉴权，项目内容先在 PC 加密，Hub 只接触密文、文件哈希和相对路径。v3 请求携带 `protocolVersion: 3`、稳定的 `workspaceId`、用户可读 `workspaceName` 与 `deviceId`，Hub 在清单中持久记录设备到同步名称的映射，便于检查跨电脑匹配。

- `POST /api/collector/v1/sync/pull`：按 `sinceRevision` 拉取增量元数据；`full: true` 用于首次同步和仅下载模式的缺失文件修复。
- `PUT/GET /api/collector/v1/sync/blob`：最多 512 KiB 一块，v3 Hub 在 pull 响应中声明 `maxBlobBytes`（当前 32 MiB）。PUT 返回 `receivedBytes`，客户端必须按服务端偏移继续；GET 支持任意合法 offset，客户端下载断点保存在本机并在完成后校验密文 SHA-256。连接旧 Hub 时客户端回退到约 7 MiB 明文上限。
- `POST /api/collector/v1/sync/push`：批量提交普通文件或 v3 删除墓碑。`baseRevision` 不匹配时返回冲突，不静默覆盖较新版本。
- `POST /api/collector/v1/sync/progress`：上报设备、工作区名称、阶段、文件计数、字节数和百分比。

删除传播默认由客户端关闭。明确启用后，缺失的已跟踪文件会提交 `deleted: true` 墓碑；旧协议客户端不会收到墓碑。v3 客户端收到墓碑时把本机文件移动到 `.codex-sync-recovery`，不执行不可恢复删除。墓碑继续引用历史密文对象，自动垃圾回收不属于 v3。

首次设置必须直连 NAS 的 `17321` 端口完成。之后 `/admin/` 和 `/admin/api/*` 推荐只通过 LAN、VPN、SSH 端口转发或代理 IP 白名单访问；需要远程访问时仍必须使用 HTTPS。密码和会话鉴权是应用层边界，不替代网络访问控制。

管理页面响应设置严格 CSP、`X-Frame-Options: DENY`、`nosniff`、`no-referrer` 和权限策略；所有 JSON API 使用 `Cache-Control: no-store`。

## 设置持久化与凭据边界

运行时设置写入 named volume `hub-data` 中的 `/data/config.json`。文件内容是版本化 envelope，业务设置使用 AES-256-GCM 加密：

1. 首次启动时生成独立的 256 位内部秘密，保存在权限为 `0600` 的 `/data/credentials.json`，再经固定 domain separator 和 SHA-256 派生设置密钥。
2. 每次保存生成 12 字节随机 IV，并写入 GCM authentication tag。
3. 先写权限为 `0600` 的临时文件并同步，再原子重命名为 `config.json`。

OpenRouter API Key 存在加密 payload 中。管理状态仅返回 `hasApiKey` 等布尔信息，不返回明文。设置密钥与管理密码相互独立，因此管理认证不会成为业务配置文件的明文加密密钥。

Codex 托管登录状态由 Codex 自己写在 `/data/providers/codex`，不属于上述 `config.json` envelope。整个 `hub-data` 卷都必须视为敏感数据。Docker/NAS 管理员仍能读取容器环境和卷，因此卷级权限与备份加密仍然必要。

## Codex app-server 内部协议

Hub 只在一次额度采集或设备码登录期间启动 `codex app-server` 子进程，并使用默认 stdio。stdio 是逐行 JSON（JSONL），每一行恰好是一条省略 `"jsonrpc":"2.0"` 的 JSON-RPC 消息。官方协议见 [OpenAI Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。

每次定时采集都执行完整的短生命周期：

1. 发送带 `clientInfo` 的 `initialize` 请求并等待成功响应。
2. 发送无 `id` 的 `initialized` notification。
3. 调用 `account/read` 检查当前认证状态，同时调用 `account/rateLimits/read` 读取额度。
4. 验证并映射响应，记录本次成功时间。
5. 在 `finally` 中停止 app-server，不让 Codex 子进程常驻。

子进程存活期间，Hub 必须持续读取 stdout，以请求 `id` 关联响应，并容忍与当前请求无关的 notification。stdout 只能承载 JSONL；app-server 的 stderr 默认不落日志，避免认证上下文泄露。EOF、非法 JSON、请求超时或意外退出会使本次采集失败，子进程仍被清理；Hub 保留尚未 stale 的旧快照，到下一次调度再重试。

默认调度周期是 300 秒，不是 45 秒。该设计以少量启动 CPU 换取较低稳态内存，目标是 Hub 稳态 RSS 不超过 64 MiB。Compose 的 `128m` 是为 Codex 启动峰值预留的硬上限起点，不是常驻内存承诺；该值尚未在目标 NAS 上验证，部署前必须实测完整刷新峰值。

### 设备码登录

管理面板和 `login` 子命令都通过临时 app-server 完成 `initialize/initialized`，然后发送：

```json
{
  "method": "account/login/start",
  "id": 4,
  "params": {"type":"chatgptDeviceCode"}
}
```

管理面板把 `verificationUrl` 和 `userCode` 显示给已登录管理会话的浏览器；命令行则显示到终端。两者都等待相同 `loginId` 的 `account/login/completed` 成功通知，并在完成、失败、取消或超时后停止子进程。

命令行入口是：

```bash
docker compose run --rm quota-hub login
```

Codex managed ChatGPT 登录负责持久化和刷新 token，`CODEX_HOME` 为 `/data/providers/codex`，由 `hub-data` named volume 保存。认证文件不得进入镜像、普通 HTTP 响应或日志。管理面板状态只返回一次性设备码流程所需字段，不返回 OAuth token。

### 额度字段映射

`account/rateLimits/read` 返回的窗口包含 `usedPercent`、`windowDurationMins` 与 Unix 秒级 `resetsAt`。Hub 转换规则：

- `usedPercent` 使用 app-server 返回的上游原值；Hub 不反转、不舍入，也不输出 `remainingPercent`。
- 短窗口输出为 `kind: session`，长周期窗口输出为 `kind: weekly`。
- `resetsAt` 从 Unix 秒转换为 UTC ISO-8601 字符串。
- `updatedAt` 使用本次成功采集完成时的 Unix 毫秒。
- `accountLabel` 只取套餐类型的显示名称，不输出账号邮箱。

实现优先使用 `rateLimitsByLimitId.codex`，不存在时才回退到向后兼容的 `rateLimits`。其他 metered bucket 不能随意覆盖到 session/weekly。

## OpenRouter 实验性采集

OpenRouter collector 只访问实现中固定的官方 HTTPS endpoint，使用 Bearer API Key，不接受用户填写任意 URL。

### API Key 模式

调用 `GET https://openrouter.ai/api/v1/key`，读取当前 Key 的 `usage`、`limit` 和 `limit_remaining`。缺少 remaining 时，可在 limit 与 usage 都有效时计算差值；只有 limit 大于 0 时才派生使用百分比。

官方定义见 [OpenRouter Get current API key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)。

### Account credits 模式

调用 `GET https://openrouter.ai/api/v1/credits`。该 endpoint 需要 management key，读取 `total_credits` 和 `total_usage`，再计算余额与已用比例。

官方定义见 [OpenRouter Get remaining credits](https://openrouter.ai/docs/api/api-reference/credits/get-credits)。

OpenRouter 的标准化 snapshot 只由 `/admin/api/state` 返回脱敏指标。provider 声明 `bridgeCompatible: false`，因此无论是否启用，都不会进入 `/api/stats` 或手表。API Key 仅以 AES-256-GCM 加密形式保存在 `/data/config.json`，日志和管理响应不得输出明文。

## DeepSeek 边界

DeepSeek 不在 Hub 中配置、采集或转换。按当前产品决定，它归手机 APK 的内置直连逻辑处理，再通过手机到手表的既有通道发送；对应能力是否存在必须由手机端版本实现和验证。Hub 不提供 `deepseek` provider，也不借用 `opencode`、`grok`、`kiro` 等现有 APK ID。手机端实现和测试属于独立边界。

## 运行时与容器边界

- Compose service 名为 `quota-hub`，持久卷名为 `hub-data`。
- 默认刷新/过期时间分别为 300/900 秒。
- Node old-space 上限为 32 MiB，Hub 稳态 RSS 设计目标为不超过 64 MiB。
- Compose 默认硬内存上限为 `128m`；这是为 app-server 刷新峰值预留的部署起点，不是常驻占用，并且尚未在目标 NAS 上验证。
- 若出现退出码 137，先在目标 NAS 上测量采集峰值，再按需把硬上限增至 `160m` 或 `192m`。
- 根文件系统只读，容器以非 root 用户运行；只有 `/tmp` 和 `/data` 可写。
- app-server 仅通过 stdio 访问，不监听网络端口。
- 健康检查仅用 Bash 内建 `/dev/tcp` 请求容器回环地址的 `/livez`，不启动 Node、不安装 curl/wget、不发送 Secret。
- `stop_grace_period` 为 75 秒，以覆盖 Codex 默认 30 秒启动/初始化、15 秒请求、约 4 秒 app-server 清理，以及可选 OpenRouter 的 15 秒串行请求，并为 HTTP 收尾保留余量。

## 版本与兼容测试

- 容器精确固定 `@openai/codex@0.149.1`，禁止浮动 `latest`、`^` 或 `~`。
- 每次升级 Codex CLI，先生成或核对该版本 schema，再运行 JSONL 握手、按需子进程退出、面板/CLI 设备码登录、rate-limit 映射和 APK payload fixture 测试。
- 对 `/api/stats` 保留黄金样例，至少覆盖原值 `usedPercent`、禁止输出 `remainingPercent`、缺 session、缺 weekly、stale、错误 Secret 与无效重置时间。
- 覆盖管理密码哈希、内存会话与 bridge Secret 分离、管理 API 鉴权、Secret 脱敏、配置 AES-GCM 往返、错误密钥解密失败和原子保存测试。
- 覆盖 OpenRouter 两种官方响应映射，并断言它永远不进入 `/api/stats`。
- 以 APK SHA-256 `3B82B7651BFE14FA2980827C66262987EF0487A201FCF8663130C833DCD2CA43` 为静态基线；APK 更新后重新分析 adapter ID 和字段。
- x86-64 与 ARM64 镜像必须分别执行 `codex --version`、登录、刷新、接口和峰值 RSS 冒烟测试。128m 硬限能否覆盖刷新峰值必须在目标 NAS 上验证。
