import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_CHUNK_BYTES = 512 * 1024;
const ACTIVE_PROGRESS_TTL_MS = 24 * 60 * 60_000;
const STALLED_PROGRESS_MS = 10 * 60_000;

function safeId(value, name) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(text)) throw new Error(`${name} is invalid`);
  return text;
}

function safePath(value) {
  const text = typeof value === "string" ? value.replaceAll("\\", "/").trim() : "";
  if (!text || text.length > 512 || text.startsWith("/") || text.includes("\0")) {
    throw new Error("path is invalid");
  }
  const parts = text.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("path is invalid");
  return parts.join("/");
}

function safeHash(value, name = "hash") {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${name} is invalid`);
  return text;
}

function boundedText(value, max = 512) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function atomicWrite(path, body) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let created = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    created = false;
  } finally {
    if (created) await unlink(temporaryPath).catch(() => {});
  }
}

export class SyncStore {
  constructor(options = {}) {
    this.root = options.root || join(options.dataDir || "/data", "sync");
    this.queues = new Map();
    this.blobQueues = new Map();
    this.activities = new Map();
    this.now = options.now || (() => Date.now());
  }

  workspaceDir(workspaceId) {
    return join(this.root, safeId(workspaceId, "workspaceId"));
  }

  manifestPath(workspaceId) {
    return join(this.workspaceDir(workspaceId), "manifest.json");
  }

  async readManifest(workspaceId) {
    const id = safeId(workspaceId, "workspaceId");
    try {
      const raw = await readFile(this.manifestPath(id));
      if (raw.byteLength > MAX_MANIFEST_BYTES) throw new Error("sync manifest is too large");
      const parsed = JSON.parse(raw.toString("utf8"));
      return {
        schemaVersion: SCHEMA_VERSION,
        workspaceId: id,
        revision: Math.max(0, Number(parsed.revision) || 0),
        files: parsed.files && typeof parsed.files === "object" ? parsed.files : {},
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return { schemaVersion: SCHEMA_VERSION, workspaceId: id, revision: 0, files: {} };
    }
  }

  async pull(workspaceId, sinceRevision = 0, options = {}) {
    const manifest = await this.readManifest(workspaceId);
    const since = Math.max(0, Number(sinceRevision) || 0);
    const files = [];
    for (const entry of Object.values(manifest.files)) {
      if ((entry.revision || 0) <= since) continue;
      if (options.metadataOnly === true) {
        files.push({ ...entry });
        continue;
      }
      const blob = await readFile(join(this.workspaceDir(manifest.workspaceId), "objects", entry.object));
      files.push({ ...entry, blob: blob.toString("base64") });
    }
    return { workspaceId: manifest.workspaceId, revision: manifest.revision, files };
  }

  async readBlobChunk(workspaceId, objectId, offset = 0, limit = MAX_BLOB_CHUNK_BYTES) {
    const id = safeId(workspaceId, "workspaceId");
    const object = safeHash(objectId, "object");
    const manifest = await this.readManifest(id);
    if (!Object.values(manifest.files).some((entry) => entry?.object === object)) {
      throw new Error("blob is not referenced by this workspace");
    }
    const filePath = join(this.workspaceDir(id), "objects", object);
    const metadata = await stat(filePath);
    const start = Math.max(0, Math.min(Number(offset) || 0, metadata.size));
    const length = Math.max(1, Math.min(Number(limit) || MAX_BLOB_CHUNK_BYTES, MAX_BLOB_CHUNK_BYTES, metadata.size - start));
    if (start >= metadata.size) return { chunk: Buffer.alloc(0), totalBytes: metadata.size, offset: start };
    const handle = await open(filePath, "r");
    try {
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, start);
      return { chunk: chunk.subarray(0, bytesRead), totalBytes: metadata.size, offset: start };
    } finally {
      await handle.close();
    }
  }

  async writeBlobChunk(workspaceId, objectId, offset, totalBytes, chunk) {
    const id = safeId(workspaceId, "workspaceId");
    const object = safeHash(objectId, "object");
    const start = Math.max(0, Number(offset) || 0);
    const total = Math.max(1, Number(totalBytes) || 0);
    if (!Buffer.isBuffer(chunk) || chunk.byteLength === 0 || chunk.byteLength > MAX_BLOB_CHUNK_BYTES) {
      throw new Error("blob chunk is invalid");
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(total) || total > MAX_BLOB_BYTES || start + chunk.byteLength > total) {
      throw new Error("blob chunk range is invalid");
    }
    const queueKey = `${id}:${object}`;
    const previous = this.blobQueues.get(queueKey) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const finalPath = join(this.workspaceDir(id), "objects", object);
      try {
        const existing = await stat(finalPath);
        return { receivedBytes: existing.size, totalBytes: existing.size, complete: true };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }

      const partialPath = join(this.workspaceDir(id), ".uploads", `${object}.part`);
      await mkdir(dirname(partialPath), { recursive: true, mode: 0o700 });
      let currentSize = 0;
      try { currentSize = (await stat(partialPath)).size; } catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (start < currentSize) {
        if (start + chunk.byteLength > currentSize) throw new Error(`blob upload expects offset ${currentSize}`);
        const handle = await open(partialPath, "r");
        try {
          const existing = Buffer.alloc(chunk.byteLength);
          await handle.read(existing, 0, existing.length, start);
          if (!existing.equals(chunk)) throw new Error("blob retry does not match stored data");
        } finally {
          await handle.close();
        }
        if (currentSize === total) {
          const complete = await readFile(partialPath);
          if (createHash("sha256").update(complete).digest("hex") !== object) {
            await unlink(partialPath).catch(() => {});
            throw new Error("completed blob does not match its object hash");
          }
          await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
          await rename(partialPath, finalPath);
        }
        return { receivedBytes: currentSize, totalBytes: total, complete: currentSize === total };
      }
      if (start !== currentSize) throw new Error(`blob upload expects offset ${currentSize}`);

      const handle = await open(partialPath, currentSize === 0 ? "w" : "a", 0o600);
      try {
        await handle.writeFile(chunk);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const receivedBytes = currentSize + chunk.byteLength;
      if (receivedBytes < total) return { receivedBytes, totalBytes: total, complete: false };

      const complete = await readFile(partialPath);
      if (complete.byteLength !== total || createHash("sha256").update(complete).digest("hex") !== object) {
        await unlink(partialPath).catch(() => {});
        throw new Error("completed blob does not match its object hash");
      }
      await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
      await rename(partialPath, finalPath);
      return { receivedBytes, totalBytes: total, complete: true };
    });
    this.blobQueues.set(queueKey, operation);
    try {
      return await operation;
    } finally {
      if (this.blobQueues.get(queueKey) === operation) this.blobQueues.delete(queueKey);
    }
  }

  reportProgress(deviceId, input = {}) {
    const device = safeId(deviceId, "deviceId");
    const workspaceId = safeId(input.workspaceId || "workspace", "workspaceId");
    const status = new Set(["running", "complete", "error"]).has(input.status) ? input.status : "running";
    const percent = Math.max(0, Math.min(100, Math.round(Number(input.percent) || 0)));
    const activity = {
      deviceId: device,
      workspaceId,
      status,
      phase: boundedText(input.phase, 48) || "同步中",
      percent,
      currentFile: boundedText(input.currentFile, 512),
      completedFiles: Math.max(0, Math.round(Number(input.completedFiles) || 0)),
      totalFiles: Math.max(0, Math.round(Number(input.totalFiles) || 0)),
      transferredBytes: Math.max(0, Math.round(Number(input.transferredBytes) || 0)),
      totalBytes: Math.max(0, Math.round(Number(input.totalBytes) || 0)),
      message: boundedText(input.message, 512),
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.activities.set(`${device}:${workspaceId}`, activity);
    return activity;
  }

  getActivities() {
    const now = this.now();
    const values = [];
    for (const [key, activity] of this.activities) {
      const age = now - Date.parse(activity.updatedAt || 0);
      if (age > ACTIVE_PROGRESS_TTL_MS) {
        this.activities.delete(key);
        continue;
      }
      values.push(age > STALLED_PROGRESS_MS && activity.status === "running"
        ? { ...activity, status: "error", phase: "连接中断", message: "超过 10 分钟没有收到进度" }
        : { ...activity });
    }
    return values.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  async getSummary() {
    let directories = [];
    try {
      directories = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        const activities = this.getActivities();
        const devices = new Map();
        for (const activity of activities) {
          const previous = devices.get(activity.deviceId);
          if (!previous || Date.parse(activity.updatedAt) > Date.parse(previous)) devices.set(activity.deviceId, activity.updatedAt);
        }
        return {
          workspaceCount: 0,
          conversationBackupCount: 0,
          fileCount: 0,
          totalBytes: 0,
          devices: [...devices].map(([id, lastSeenAt]) => ({ id, lastSeenAt })),
          workspaces: [],
          activities,
        };
      }
      throw error;
    }
    const workspaces = [];
    const devices = new Map();
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      let manifest;
      try { manifest = await this.readManifest(directory.name); } catch { continue; }
      const files = Object.values(manifest.files || {});
      let totalBytes = 0;
      let updatedAt = null;
      for (const file of files) {
        totalBytes += Math.max(0, Number(file.size) || 0);
        if (!updatedAt || Date.parse(file.updatedAt || 0) > Date.parse(updatedAt)) updatedAt = file.updatedAt || updatedAt;
        if (file.deviceId) {
          const previous = devices.get(file.deviceId);
          if (!previous || Date.parse(file.updatedAt || 0) > Date.parse(previous)) devices.set(file.deviceId, file.updatedAt || null);
        }
      }
      workspaces.push({
        id: manifest.workspaceId,
        kind: manifest.workspaceId.startsWith("codex-chats-") ? "conversation-backup" : "project",
        revision: manifest.revision,
        fileCount: files.length,
        totalBytes,
        updatedAt,
      });
    }
    workspaces.sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));
    const activities = this.getActivities();
    for (const activity of activities) {
      const previous = devices.get(activity.deviceId);
      if (!previous || Date.parse(activity.updatedAt) > Date.parse(previous)) devices.set(activity.deviceId, activity.updatedAt);
    }
    return {
      workspaceCount: workspaces.filter((item) => item.kind === "project").length,
      conversationBackupCount: workspaces.filter((item) => item.kind === "conversation-backup").length,
      fileCount: workspaces.reduce((sum, item) => sum + item.fileCount, 0),
      totalBytes: workspaces.reduce((sum, item) => sum + item.totalBytes, 0),
      devices: [...devices].map(([id, lastSeenAt]) => ({ id, lastSeenAt })),
      workspaces,
      activities,
    };
  }

  async push(workspaceId, deviceId, inputFiles) {
    const id = safeId(workspaceId, "workspaceId");
    const device = safeId(deviceId, "deviceId");
    if (!Array.isArray(inputFiles) || inputFiles.length > 64) throw new Error("files must contain at most 64 entries");
    const previous = this.queues.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const manifest = await this.readManifest(id);
      const accepted = [];
      const conflicts = [];
      for (const input of inputFiles) {
        const path = safePath(input?.path);
        const hash = safeHash(input?.hash);
        const baseRevision = Math.max(0, Number(input?.baseRevision) || 0);
        const current = manifest.files[path];
        if (current && current.hash !== hash && current.revision !== baseRevision) {
          conflicts.push({ path, current });
          continue;
        }
        if (current?.hash === hash) {
          accepted.push(current);
          continue;
        }
        let object;
        let encryptedSize;
        if (input?.object) {
          object = safeHash(input.object, "object");
          const metadata = await stat(join(this.workspaceDir(id), "objects", object));
          if (metadata.size === 0 || metadata.size > MAX_BLOB_BYTES) throw new Error(`blob for ${path} is invalid`);
          encryptedSize = metadata.size;
        } else {
          const blob = Buffer.from(String(input?.blob || ""), "base64");
          if (blob.byteLength === 0 || blob.byteLength > MAX_BLOB_BYTES) throw new Error(`blob for ${path} is invalid`);
          object = createHash("sha256").update(blob).digest("hex");
          encryptedSize = blob.byteLength;
          await atomicWrite(join(this.workspaceDir(id), "objects", object), blob);
        }
        manifest.revision += 1;
        const entry = {
          path,
          hash,
          object,
          size: Math.max(0, Number(input?.size) || 0),
          encryptedSize,
          modifiedAt: new Date(input?.modifiedAt || Date.now()).toISOString(),
          updatedAt: new Date().toISOString(),
          deviceId: device,
          revision: manifest.revision,
        };
        manifest.files[path] = entry;
        accepted.push(entry);
      }
      const body = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
      if (body.byteLength > MAX_MANIFEST_BYTES) throw new Error("sync manifest is too large");
      await atomicWrite(this.manifestPath(id), body);
      return { workspaceId: id, revision: manifest.revision, accepted, conflicts };
    });
    this.queues.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.queues.get(id) === operation) this.queues.delete(id);
    }
  }
}

export const SYNC_SCHEMA_VERSION = SCHEMA_VERSION;
export const SYNC_MAX_BLOB_BYTES = MAX_BLOB_BYTES;
export const SYNC_MAX_BLOB_CHUNK_BYTES = MAX_BLOB_CHUNK_BYTES;
