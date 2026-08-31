import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

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

  async pull(workspaceId, sinceRevision = 0) {
    const manifest = await this.readManifest(workspaceId);
    const since = Math.max(0, Number(sinceRevision) || 0);
    const files = [];
    for (const entry of Object.values(manifest.files)) {
      if ((entry.revision || 0) <= since) continue;
      const blob = await readFile(join(this.workspaceDir(manifest.workspaceId), "objects", entry.object));
      files.push({ ...entry, blob: blob.toString("base64") });
    }
    return { workspaceId: manifest.workspaceId, revision: manifest.revision, files };
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
        const blob = Buffer.from(String(input?.blob || ""), "base64");
        if (blob.byteLength === 0 || blob.byteLength > MAX_BLOB_BYTES) throw new Error(`blob for ${path} is invalid`);
        const object = createHash("sha256").update(blob).digest("hex");
        await atomicWrite(join(this.workspaceDir(id), "objects", object), blob);
        manifest.revision += 1;
        const entry = {
          path,
          hash,
          object,
          size: Math.max(0, Number(input?.size) || 0),
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
