import {
  SNAPSHOT_MAX_BLOB_BYTES,
  SNAPSHOT_MAX_BLOB_CHUNK_BYTES,
  SnapshotConflictError,
} from "./snapshot-store.js";

const MAX_JSON_BYTES = 64 * 1024;

class SnapshotApiError extends Error {
  constructor(message, statusCode = 400, code = "invalid_request") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function readJson(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new SnapshotApiError("request must use application/json", 415, "unsupported_media_type");
  }
  const declared = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new SnapshotApiError("request body is too large", 413, "body_too_large");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new SnapshotApiError("request body is too large", 413, "body_too_large");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new SnapshotApiError("invalid JSON request", 400, "invalid_json");
  }
}

async function readBinary(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/octet-stream")) {
    throw new SnapshotApiError("request must use application/octet-stream", 415, "unsupported_media_type");
  }
  const declared = Number(request.headers["content-length"] || 0);
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > SNAPSHOT_MAX_BLOB_CHUNK_BYTES) {
    throw new SnapshotApiError("blob chunk size is invalid", 413, "body_too_large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > SNAPSHOT_MAX_BLOB_CHUNK_BYTES) throw new SnapshotApiError("blob chunk is too large", 413, "body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function query(url, name, fallback = null) {
  const value = url.searchParams.get(name);
  if ((value === null || value === "") && fallback !== null) return fallback;
  if (!value) throw new SnapshotApiError(`${name} is required`, 400, "invalid_query");
  return value;
}

function numberQuery(url, name, fallback = null) {
  const raw = query(url, name, fallback === null ? null : String(fallback));
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new SnapshotApiError(`${name} is invalid`, 400, "invalid_query");
  return value;
}

function json(statusCode, payload, headers = {}) { return { statusCode, payload, headers }; }

export function createSnapshotApi(options = {}) {
  const store = options.snapshotStore;
  const logger = options.logger || null;
  return async function handleSnapshotApi(request, pathname) {
    if (!pathname.startsWith("/api/cw/v1/snapshots/")) return null;
    const startedAt = Date.now();
    try {
      const url = new URL(request.url || pathname, "http://hub.invalid");
      if (pathname === "/api/cw/v1/snapshots/status") {
        if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
        return json(200, { ok: true, protocolVersion: 1, encryptedSnapshots: true, maxBlobBytes: SNAPSHOT_MAX_BLOB_BYTES, maxBlobChunkBytes: SNAPSHOT_MAX_BLOB_CHUNK_BYTES });
      }
      if (!store) return json(501, { error: "snapshot_store_unavailable" });
      if (pathname === "/api/cw/v1/snapshots/list") {
        if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
        const body = await readJson(request);
        return json(200, await store.list(body.workspaceId, { limit: body.limit }));
      }
      if (pathname === "/api/cw/v1/snapshots/commit") {
        if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
        const body = await readJson(request);
        const result = await store.commit(body);
        return json(201, result);
      }
      if (pathname === "/api/cw/v1/snapshots/blob") {
        const workspaceId = query(url, "workspaceId");
        const object = query(url, "object");
        const offset = numberQuery(url, "offset", 0);
        if (request.method === "PUT") {
          const total = numberQuery(url, "total");
          return json(200, await store.writeBlobChunk(workspaceId, object, offset, total, await readBinary(request)));
        }
        if (request.method === "GET") {
          const value = await store.readBlobChunk(workspaceId, object, offset, numberQuery(url, "limit", SNAPSHOT_MAX_BLOB_CHUNK_BYTES));
          return { statusCode: 200, body: value.chunk, contentType: "application/octet-stream", headers: { "Cache-Control": "no-store", "X-CW-Offset": String(value.offset), "X-CW-Total-Bytes": String(value.totalBytes) } };
        }
        return json(405, { error: "method_not_allowed" }, { Allow: "GET, PUT" });
      }
      return json(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof SnapshotConflictError) {
        return json(409, { error: "snapshot_conflict", message: error.message, currentHeadSnapshotId: error.currentHeadSnapshotId });
      }
      if (error instanceof SnapshotApiError) return json(error.statusCode, { error: error.code, message: error.message });
      logger?.warn?.("Snapshot API request failed", { method: request.method, pathname, errorType: error?.name || "Error", errorMessage: error?.message || "invalid request", durationMs: Date.now() - startedAt });
      return json(400, { error: "invalid_request", message: error?.message || "invalid request" });
    }
  };
}
