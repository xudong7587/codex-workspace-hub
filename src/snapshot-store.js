import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SNAPSHOT_MAX_BLOB_BYTES = 256 * 1024 * 1024;
export const SNAPSHOT_MAX_BLOB_CHUNK_BYTES = 1024 * 1024;
const SCHEMA_VERSION = 1;
const MAX_SNAPSHOTS_PER_WORKSPACE = 10_000;

function safeId(value, name) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(text)) throw new Error(`${name} is invalid`);
  return text;
}

function safeHash(value, name = "object") {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${name} is invalid`);
  return text;
}

function boundedText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let created = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(value);
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

async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function emptyIndex(workspaceId) {
  return { schemaVersion: SCHEMA_VERSION, workspaceId, headSnapshotId: null, members: {}, snapshots: [] };
}

export class SnapshotConflictError extends Error {
  constructor(currentHeadSnapshotId) {
    super("snapshot parent is stale");
    this.code = "SNAPSHOT_CONFLICT";
    this.currentHeadSnapshotId = currentHeadSnapshotId;
  }
}

export class SnapshotStore {
  constructor(options = {}) {
    this.root = options.root || join(options.dataDir || "/data", "development-snapshots");
    this.queues = new Map();
    this.blobQueues = new Map();
    this.now = options.now || (() => Date.now());
    this.logger = options.logger || null;
  }

  workspaceDir(workspaceId) { return join(this.root, safeId(workspaceId, "workspaceId")); }
  indexPath(workspaceId) { return join(this.workspaceDir(workspaceId), "index.json"); }
  objectPath(workspaceId, objectId) { return join(this.workspaceDir(workspaceId), "objects", safeHash(objectId)); }

  async readIndex(workspaceId) {
    const id = safeId(workspaceId, "workspaceId");
    try {
      const parsed = JSON.parse(await readFile(this.indexPath(id), "utf8"));
      return {
        schemaVersion: SCHEMA_VERSION,
        workspaceId: id,
        headSnapshotId: typeof parsed.headSnapshotId === "string" ? parsed.headSnapshotId : null,
        members: parsed.members && typeof parsed.members === "object" ? parsed.members : {},
        snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots.slice(-MAX_SNAPSHOTS_PER_WORKSPACE) : [],
      };
    } catch (error) {
      if (error?.code === "ENOENT") return emptyIndex(id);
      throw error;
    }
  }

  async writeIndex(index) {
    await atomicWrite(this.indexPath(index.workspaceId), Buffer.from(`${JSON.stringify(index)}\n`, "utf8"));
  }

  async writeBlobChunk(workspaceId, objectId, offset, totalBytes, chunk) {
    const id = safeId(workspaceId, "workspaceId");
    const object = safeHash(objectId);
    const start = Number(offset);
    const total = Number(totalBytes);
    if (!Buffer.isBuffer(chunk) || chunk.length < 1 || chunk.length > SNAPSHOT_MAX_BLOB_CHUNK_BYTES) throw new Error("blob chunk is invalid");
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(total) || total < 1 || total > SNAPSHOT_MAX_BLOB_BYTES || start + chunk.length > total) {
      throw new Error("blob chunk range is invalid");
    }
    const queueKey = `${id}:${object}`;
    const previous = this.blobQueues.get(queueKey) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const finalPath = this.objectPath(id, object);
      try {
        const existing = await stat(finalPath);
        if (existing.size !== total) throw new Error("stored blob size does not match upload total");
        return { receivedBytes: total, totalBytes: total, complete: true };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const partialPath = join(this.workspaceDir(id), ".uploads", `${object}.part`);
      await mkdir(dirname(partialPath), { recursive: true, mode: 0o700 });
      let currentSize = 0;
      try { currentSize = (await stat(partialPath)).size; } catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (start < currentSize) {
        if (start + chunk.length > currentSize) throw new Error(`blob upload expects offset ${currentSize}`);
        const handle = await open(partialPath, "r");
        try {
          const stored = Buffer.alloc(chunk.length);
          await handle.read(stored, 0, stored.length, start);
          if (!stored.equals(chunk)) throw new Error("blob retry does not match stored data");
        } finally { await handle.close(); }
        return { receivedBytes: currentSize, totalBytes: total, complete: currentSize === total };
      }
      if (start !== currentSize) throw new Error(`blob upload expects offset ${currentSize}`);
      const handle = await open(partialPath, currentSize === 0 ? "w" : "a", 0o600);
      try { await handle.writeFile(chunk); await handle.sync(); } finally { await handle.close(); }
      const receivedBytes = currentSize + chunk.length;
      if (receivedBytes < total) return { receivedBytes, totalBytes: total, complete: false };
      if (await fileHash(partialPath) !== object) {
        await unlink(partialPath).catch(() => {});
        throw new Error("completed blob does not match its object hash");
      }
      await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
      await rename(partialPath, finalPath);
      this.logger?.info?.("Encrypted development snapshot uploaded", { workspaceId: id, objectId: object, encryptedBytes: total });
      return { receivedBytes, totalBytes: total, complete: true };
    });
    this.blobQueues.set(queueKey, operation);
    try { return await operation; } finally { if (this.blobQueues.get(queueKey) === operation) this.blobQueues.delete(queueKey); }
  }

  async readBlobChunk(workspaceId, objectId, offset = 0, limit = SNAPSHOT_MAX_BLOB_CHUNK_BYTES) {
    const id = safeId(workspaceId, "workspaceId");
    const object = safeHash(objectId);
    const index = await this.readIndex(id);
    if (!index.snapshots.some((snapshot) => snapshot.object === object)) throw new Error("blob is not referenced by this workspace");
    const path = this.objectPath(id, object);
    const metadata = await stat(path);
    const start = Math.max(0, Math.min(Number(offset) || 0, metadata.size));
    if (start >= metadata.size) return { chunk: Buffer.alloc(0), offset: start, totalBytes: metadata.size };
    const length = Math.min(Math.max(1, Number(limit) || SNAPSHOT_MAX_BLOB_CHUNK_BYTES), SNAPSHOT_MAX_BLOB_CHUNK_BYTES, metadata.size - start);
    const handle = await open(path, "r");
    try {
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, start);
      return { chunk: chunk.subarray(0, bytesRead), offset: start, totalBytes: metadata.size };
    } finally { await handle.close(); }
  }

  async commit(input = {}) {
    const id = safeId(input.workspaceId, "workspaceId");
    const deviceId = safeId(input.deviceId, "deviceId");
    const object = safeHash(input.object);
    const encryptedBytes = Number(input.encryptedBytes);
    if (!Number.isSafeInteger(encryptedBytes) || encryptedBytes < 1 || encryptedBytes > SNAPSHOT_MAX_BLOB_BYTES) throw new Error("encryptedBytes is invalid");
    const stored = await stat(this.objectPath(id, object));
    if (stored.size !== encryptedBytes) throw new Error("snapshot blob size does not match");
    const previous = this.queues.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const index = await this.readIndex(id);
      const parentSnapshotId = input.parentSnapshotId || null;
      if (parentSnapshotId !== index.headSnapshotId) throw new SnapshotConflictError(index.headSnapshotId);
      const snapshotId = `${this.now().toString(36)}-${randomBytes(8).toString("hex")}`;
      const createdAt = new Date(this.now()).toISOString();
      const snapshot = {
        snapshotId,
        parentSnapshotId,
        object,
        encryptedBytes,
        workspaceName: boundedText(input.workspaceName, 128) || id,
        deviceId,
        kind: input.kind === "baseline" ? "baseline" : "incremental",
        summary: boundedText(input.summary, 512),
        gitBranch: boundedText(input.gitBranch, 256),
        gitHead: /^[a-f0-9]{7,64}$/i.test(input.gitHead || "") ? input.gitHead.toLowerCase() : null,
        fileCount: Math.max(0, Math.min(100_000, Math.trunc(Number(input.fileCount) || 0))),
        deletedCount: Math.max(0, Math.min(100_000, Math.trunc(Number(input.deletedCount) || 0))),
        createdAt,
      };
      index.snapshots.push(snapshot);
      index.snapshots = index.snapshots.slice(-MAX_SNAPSHOTS_PER_WORKSPACE);
      index.headSnapshotId = snapshotId;
      index.members[deviceId] = { name: snapshot.workspaceName, lastSeenAt: createdAt };
      await this.writeIndex(index);
      this.logger?.info?.("Development snapshot committed", { workspaceId: id, snapshotId, parentSnapshotId, deviceId, fileCount: snapshot.fileCount });
      return { workspaceId: id, headSnapshotId: snapshotId, snapshot };
    });
    this.queues.set(id, operation);
    try { return await operation; } finally { if (this.queues.get(id) === operation) this.queues.delete(id); }
  }

  async list(workspaceId, options = {}) {
    const index = await this.readIndex(workspaceId);
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
    return { workspaceId: index.workspaceId, headSnapshotId: index.headSnapshotId, snapshots: index.snapshots.slice(-limit).reverse() };
  }

  async forgetDevice(deviceId) {
    const device = safeId(deviceId, "deviceId");
    let detachedSnapshots = 0;
    let directories = [];
    try { directories = await readdir(this.root, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return { deviceId: device, detachedSnapshots }; throw error; }
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      let index;
      try { index = await this.readIndex(directory.name); } catch { continue; }
      if (!index.headSnapshotId && index.snapshots.length === 0) continue;
      let changed = false;
      if (index.members[device]) { delete index.members[device]; changed = true; }
      for (const snapshot of index.snapshots) {
        if (snapshot.deviceId !== device) continue;
        snapshot.deviceId = null;
        detachedSnapshots += 1;
        changed = true;
      }
      if (changed) await this.writeIndex(index);
    }
    return { deviceId: device, detachedSnapshots };
  }

  async getSummary() {
    let directories = [];
    try { directories = await readdir(this.root, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return { workspaceCount: 0, snapshotCount: 0, totalBytes: 0, devices: [], workspaces: [] }; throw error; }
    const workspaces = [];
    const devices = new Map();
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      let index;
      try { index = await this.readIndex(directory.name); } catch { continue; }
      if (!index.headSnapshotId && index.snapshots.length === 0) continue;
      const totalBytes = index.snapshots.reduce((sum, snapshot) => sum + (Number(snapshot.encryptedBytes) || 0), 0);
      const head = index.snapshots.find((snapshot) => snapshot.snapshotId === index.headSnapshotId) || null;
      for (const [deviceId, member] of Object.entries(index.members)) devices.set(deviceId, member.lastSeenAt || null);
      workspaces.push({ id: index.workspaceId, name: head?.workspaceName || index.workspaceId, headSnapshotId: index.headSnapshotId, snapshotCount: index.snapshots.length, totalBytes, updatedAt: head?.createdAt || null, members: Object.entries(index.members).map(([deviceId, member]) => ({ deviceId, ...member })) });
    }
    workspaces.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    return { workspaceCount: workspaces.length, snapshotCount: workspaces.reduce((sum, item) => sum + item.snapshotCount, 0), totalBytes: workspaces.reduce((sum, item) => sum + item.totalBytes, 0), devices: [...devices].map(([id, lastSeenAt]) => ({ id, lastSeenAt })), workspaces };
  }

  async getDiagnostics() {
    const summary = await this.getSummary();
    const missingObjects = [];
    const partialUploads = [];
    const orphanObjects = [];
    for (const workspace of summary.workspaces) {
      const index = await this.readIndex(workspace.id);
      for (const snapshot of index.snapshots) {
        try { await stat(this.objectPath(workspace.id, snapshot.object)); } catch (error) { if (error?.code === "ENOENT") missingObjects.push({ workspaceId: workspace.id, snapshotId: snapshot.snapshotId, object: snapshot.object }); else throw error; }
      }
    }
    let directories = [];
    try { directories = await readdir(this.root, { withFileTypes: true }); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      let workspaceId;
      let index;
      try { workspaceId = safeId(directory.name, "workspaceId"); index = await this.readIndex(workspaceId); } catch { continue; }
      const referenced = new Set(index.snapshots.map((snapshot) => snapshot.object));
      try {
        for (const item of await readdir(join(this.workspaceDir(workspaceId), ".uploads"), { withFileTypes: true })) {
          if (item.isFile() && item.name.endsWith(".part")) partialUploads.push({ workspaceId, file: item.name });
        }
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
      try {
        for (const item of await readdir(join(this.workspaceDir(workspaceId), "objects"), { withFileTypes: true })) {
          if (item.isFile() && /^[a-f0-9]{64}$/.test(item.name) && !referenced.has(item.name)) orphanObjects.push({ workspaceId, object: item.name });
        }
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    return { ok: missingObjects.length === 0, ...summary, missingObjects, partialUploads, orphanObjects };
  }
}
