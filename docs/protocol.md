# vivo-watch-hub 协议

## 鉴权

设备接口接受 `Authorization: Bearer <设备连接 Key>` 或兼容的 `X-Token-Monitor-Secret`。同时发送两种头时必须一致。管理接口使用独立的管理会话。

## 额度与管理接口

- `GET /api/health`：手机连接探测。
- `GET /api/stats`：兼容手机／手表的额度数据，需设备 Key。
- `GET /api/collector/v1/status`：返回 `{ok:true, protocolVersion:1, usage:true, sync:false}`；usage 取决于用量存储是否启用。
- `GET /admin/api/state`：管理状态，包括额度源、用量及桥接配置。
- `DELETE /admin/api/devices/:deviceId`：移除该设备的用量记录。
- `GET /admin/api/diagnostics`：版本、进程信息和有界诊断日志。

## Token 用量上报

`POST /api/collector/v1/usage` 是 Token 详情采集器的上报端点。Windows Token 详情采集器使用设备连接 Key 鉴权，提交 `deviceId` 与已经在本地汇总的 `snapshot`。服务端按设备 ID 覆盖保存最新快照，多台 PC 汇总时不会因同一设备重复上报而累加。

v1.0.5 新增 `snapshot.accountUsage`：`status` 为 `available` 或 `unavailable`，`accountKey` 为规范化 ChatGPT 邮箱经固定域前缀 `cw-chatgpt-usage-v1:` 加 SHA-256 的 64 位十六进制标识；成功结果包含 `capturedAt`、可空 `lifetimeTokens` 和可空 `dailyUsageBuckets: [{startDate,tokens}]`。只传输这些白名单字段，不传邮箱、凭据、会话正文或项目内容。`snapshot.periods` 和 `models` 继续保留本机日志数据，新增 `pricedCostUsd`、`estimatedCostUsd` 分别表示内置价格折算与未知价格估算，`costUsd` 保持两者之和。

服务端仍以 schemaVersion 2 兼容读写历史设备快照。官方统计按 `accountKey` 分组，每个账号采用最近成功的读取结果，不把设备快照相加，也不取历史最大值。相同账号的失败上报可保留该设备之前的成功结果并标记 `stale`；账号改变或身份缺失时不复用。过时的设备上报不会覆盖新快照。

管理接口中的 `accountUsage.periods` 为官方 Token，`totalTokens` 可为 `null`，`partial` 表示只包含部分返回数据；今日、周一开始的本周、当月以 UTC 当前日期匹配官方日期桶，缺失日期不会补零。`latestBucketDate` 为已返回日期中的最近日期，`capturedAt` 为参与汇总账号中最早的读取时间。没有账号身份的旧设备不混入官方总量，并通过 `unidentifiedDeviceCount` 标明。

`localDetails` 是最近上报设备的 `{deviceId,capturedAt,usdCnyRate,periods}`，用于独立显示本机日志费用；多设备费用不相加，避免拷贝的会话历史重复计价。官方接口不提供账单或完整模型费用。未知价格部分按每百万 Token 4 美元估算。

`/api/stats` 在新模式下返回 `mode: official_account`，主 `periods` 使用官方 Token，并将 `costUsd` 置为 `null`、`costAvailable` 置为 `false`。`localDetails` 单独保留费用明细，客户端不能将 `null` 转为零或据此给整个账号按默认单价计费。当前随包 APK 未新增此状态的展示支持；以管理页和新版 Windows 采集器显示为准。

新账号模式不使用额度百分比补估 Token。超过 15 分钟未成功读取时保留官方快照并标明缓存时间，`collectorOnline` 只描述设备上报是否在线，与官方日数据是否齐全无关。没有任何新版账号上报的旧设备集仍兼容原 `collector`、`collector_baseline`、`hybrid_estimate` 模式；这些只是本地日志或离线估算，不是官方账号总量。

## PC 项目同步已取消

`/api/cw/v1/*`、`/api/collector/v1/sync/*` 和 `/admin/api/sync` 均返回 404，不接受开发快照或项目文件。管理状态和诊断不再包含 sync 数据。不再分发 Development Sync 插件。

已有开发快照不会被新服务读写或自动删除。现有用量、凭据和设置的存储与加密标识保持兼容；Token 上报和 `/api/stats` 桥接协议保持兼容。
