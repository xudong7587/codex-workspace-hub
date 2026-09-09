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

快照只包含日、周、月、累计计数、模型汇总、汇率和估算金额，不包含会话正文或项目内容。管理页优先显示采集器的分模型估值；已识别模型按各自输入、缓存输入和输出单价计算，只有无法识别模型对应的 `unpricedTokens` 才按每百万 Token 4 美元补估。只要周期内含未知模型，该周期就标记为 `estimated: true`。

采集器最后上报时间在 15 分钟内时，`/api/stats`、管理页、手机和手表均采用采集器精确快照。采集器离线后，CW 保留最后精确快照作为基线，并利用 Codex 账号周额度窗口的 `usedPercent` 变化及在线阶段校准出的 Token/百分比关系推算新增用量；返回值以 `mode: hybrid_estimate`、`collectorOnline: false` 和周期级 `estimated: true` 明确标记。额度窗口重置时从新窗口当前百分比继续累计，采集器恢复后立即以新精确快照替换估算并重新校准。若没有历史基线或无法形成校准率，CW 只保留最后精确值，不虚构新增 Token。

## 旧接口边界

- 已移除：`/api/collector/v1/sync/pull|push|blob|progress` 及逐文件 manifest 存储。
- 保留：`/api/collector/v1/status` 和 `/api/collector/v1/usage`，仅用于独立 Token 详情采集器；status 明确返回 `sync: false` 和新协议地址。
- 手机、手表和 `/api/stats` 额度桥接协议不受开发快照协议影响。
