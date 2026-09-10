# CW 协议

## 鉴权

设备接口接受 `Authorization: Bearer <设备连接 Key>` 或兼容的 `X-Token-Monitor-Secret`。同时发送两种头时必须一致。管理接口使用独立的管理会话。

项目文件在客户端打包和加密，CW 只保存加密对象和有界的快照元数据。设备连接 Key 不写入服务端快照、日志或插件文件。

## 开发快照 v1

根路径：`/api/cw/v1/snapshots`。

### `GET /status`

返回协议版本、最大加密包大小和最大分块大小。当前限制为单包 256 MiB、单块 1 MiB。

### `POST /list`

请求：

```json
{ "workspaceId": "git-...", "limit": 50 }
```

响应按新到旧返回小型快照元数据和 `headSnapshotId`，不包含路径清单或文件内容。

### `PUT /blob`

查询参数为 `workspaceId`、加密包 SHA-256 `object`、`offset` 和 `total`。请求体为 `application/octet-stream`。

- 服务端把未完成内容写入 `.uploads/<object>.part`。
- 重试已接收区间时，字节必须完全相同。
- 偏移不连续时返回当前期望偏移错误。
- 收满后校验整个加密包 SHA-256，成功才原子移动到 `objects/<object>`。

### `POST /commit`

提交字段包括：

```json
{
  "workspaceId": "git-...",
  "workspaceName": "project",
  "deviceId": "office-pc",
  "parentSnapshotId": null,
  "object": "64 位 sha256",
  "encryptedBytes": 12345,
  "kind": "baseline",
  "summary": "reviewed initial baseline",
  "gitBranch": "main",
  "gitHead": "commit sha",
  "fileCount": 8,
  "deletedCount": 0
}
```

服务端先确认对象存在且长度一致，再在工作区串行提交。`parentSnapshotId` 必须等于当前 head；否则返回 HTTP 409 `snapshot_conflict` 和最新 head，客户端必须重新 list/preview，不能静默覆盖。

### `GET /blob`

只有已被该工作区快照引用的对象才可下载。查询参数为 `workspaceId`、`object`、`offset`、`limit`；响应头 `X-CW-Total-Bytes` 给出总长度。

## 客户端加密包

明文 JSON 先 gzip，再使用以下兼容格式加密：

1. `encKey = SHA256("enc\0" + deviceConnectionKey)`；
2. `macKey = SHA256("mac\0" + deviceConnectionKey)`；
3. AES-256-CBC，随机 16 字节 IV，PKCS#7 padding；
4. body 为 `[版本 0x01][IV][ciphertext]`；
5. 尾部附加 `HMAC-SHA256(macKey, body)`。

解密必须先验证 HMAC，再解析 gzip/JSON。包内每项包含相对路径、删除标记、当前 SHA-256、Git HEAD 基线 SHA-256 和非删除文件的 base64 内容。

## 客户端选择与应用

增量候选来自 `git status --porcelain -z --untracked-files=all`；首次 baseline 来自 Git tracked 和非 ignored untracked 文件。插件在预览后只接受准确路径白名单，并再次执行硬过滤和大小限制。

应用规则：

- 本机内容等于 incoming hash：noop；
- 本机内容等于 `baseHash`：安全更新；
- 新文件且 `baseHash` 为空：安全创建；
- 本机偏离 `baseHash`：不覆盖，incoming 写入 `.cw-conflicts/<snapshotId>/...`；
- 安全删除：移动到 `.cw-recovery/<snapshotId>/...`；
- 删除冲突：保留本机文件，不执行删除。

## 管理与诊断

`GET /admin/api/sync` 返回工作区、快照数、密文总量和设备最近提交时间。`GET /admin/api/diagnostics` 还检查缺失对象、未完成上传和未被快照引用的孤立对象。诊断不返回项目路径清单、明文、管理密码或设备连接 Key。

## Token 用量上报

`POST /api/collector/v1/usage` 是与项目快照协议独立的兼容端点。Windows Token 详情采集器使用设备连接 Key 鉴权，提交 `deviceId` 与已经在本地汇总的 `snapshot`。服务端按设备 ID 覆盖保存最新快照，多台 PC 汇总时不会因同一设备重复上报而累加。

v1.0.5 新增 `snapshot.accountUsage`：`status` 为 `available` 或 `unavailable`，`accountKey` 为规范化 ChatGPT 邮箱经固定域前缀 `cw-chatgpt-usage-v1:` 加 SHA-256 的 64 位十六进制标识；成功结果包含 `capturedAt`、可空 `lifetimeTokens` 和可空 `dailyUsageBuckets: [{startDate,tokens}]`。只传输这些白名单字段，不传邮箱、凭据、会话正文或项目内容。`snapshot.periods` 和 `models` 继续保留本机日志数据，新增 `pricedCostUsd`、`estimatedCostUsd` 分别表示内置价格折算与未知价格估算，`costUsd` 保持两者之和。

服务端仍以 schemaVersion 2 兼容读写历史设备快照。官方统计按 `accountKey` 分组，每个账号采用最近成功的读取结果，不把设备快照相加，也不取历史最大值。相同账号的失败上报可保留该设备之前的成功结果并标记 `stale`；账号改变或身份缺失时不复用。过时的设备上报不会覆盖新快照。

管理接口中的 `accountUsage.periods` 为官方 Token，`totalTokens` 可为 `null`，`partial` 表示只包含部分返回数据；今日、周一开始的本周、当月以 UTC 当前日期匹配官方日期桶，缺失日期不会补零。`latestBucketDate` 为已返回日期中的最近日期，`capturedAt` 为参与汇总账号中最早的读取时间。没有账号身份的旧设备不混入官方总量，并通过 `unidentifiedDeviceCount` 标明。

`localDetails` 是最近上报设备的 `{deviceId,capturedAt,usdCnyRate,periods}`，用于独立显示本机日志费用；多设备费用不相加，避免拷贝的会话历史重复计价。官方接口不提供账单或完整模型费用。未知价格部分按每百万 Token 4 美元估算。

`/api/stats` 在新模式下返回 `mode: official_account`，主 `periods` 使用官方 Token，并将 `costUsd` 置为 `null`、`costAvailable` 置为 `false`。`localDetails` 单独保留费用明细，客户端不能将 `null` 转为零或据此给整个账号按默认单价计费。当前随包 APK 未新增此状态的展示支持；以管理页和新版 Windows 采集器显示为准。

新账号模式不使用额度百分比补估 Token。超过 15 分钟未成功读取时保留官方快照并标明缓存时间，`collectorOnline` 只描述设备上报是否在线，与官方日数据是否齐全无关。没有任何新版账号上报的旧设备集仍兼容原 `collector`、`collector_baseline`、`hybrid_estimate` 模式；这些只是本地日志或离线估算，不是官方账号总量。

## 旧接口边界

- 已移除：`/api/collector/v1/sync/pull|push|blob|progress` 及逐文件 manifest 存储。
- 保留：`/api/collector/v1/status` 和 `/api/collector/v1/usage`，仅用于独立 Token 详情采集器；status 明确返回 `sync: false` 和新协议地址。
- 手机、手表和 `/api/stats` 额度桥接协议不受开发快照协议影响。
