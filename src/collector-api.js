import { SYNC_MAX_BLOB_BYTES, SYNC_MAX_BLOB_CHUNK_BYTES } from "./sync-store.js";

const MAX_USAGE_BODY_BYTES = 512 * 1024;
const MAX_SYNC_BODY_BYTES = 12 * 1024 * 1024;

export class CollectorApiError extends Error {
  constructor(message, statusCode = 400, code = "invalid_request") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function readJsonBody(request, maxBytes) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new CollectorApiError("request must use application/json", 415, "unsupported_media_type");
  }
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new CollectorApiError("request body is too large", 413, "body_too_large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new CollectorApiError("request body is too large", 413, "body_too_large");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new CollectorApiError("invalid JSON request", 400, "invalid_json");
  }
}

async function readBinaryBody(request, maxBytes) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/octet-stream")) {
    throw new CollectorApiError("request must use application/octet-stream", 415, "unsupported_media_type");
  }
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (!Number.isFinite(declaredLength) || declaredLength <= 0 || declaredLength > maxBytes) {
    throw new CollectorApiError("blob chunk size is invalid", 413, "body_too_large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new CollectorApiError("blob chunk is too large", 413, "body_too_large");
    chunks.push(chunk);
  }
  if (size === 0) throw new CollectorApiError("blob chunk is empty", 400, "invalid_blob_chunk");
  return Buffer.concat(chunks, size);
}

function requiredQuery(url, name) {
  const value = url.searchParams.get(name)?.trim() || "";
  if (!value) throw new CollectorApiError(`${name} is required`, 400, "invalid_query");
  return value;
}

function numericQuery(url, name, fallback = null) {
  const raw = url.searchParams.get(name);
  if ((raw === null || raw === "") && fallback !== null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CollectorApiError(`${name} is invalid`, 400, "invalid_query");
  }
  return value;
}

function result(statusCode, payload, headers = {}) {
  return { statusCode, payload, headers };
}

export function createCollectorApi(options = {}) {
  const usageStore = options.usageStore;
  const syncStore = options.syncStore;
  return async function handleCollectorApi(request, pathname) {
    if (!pathname.startsWith("/api/collector/v1/")) return null;
    try {
      const url = new URL(request.url || pathname, "http://hub.invalid");
      if (pathname === "/api/collector/v1/status") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return result(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
        }
        return result(200, {
          ok: true,
          protocolVersion: 2,
          usage: Boolean(usageStore?.ingest),
          sync: Boolean(syncStore?.pull && syncStore?.push),
          maxEncryptedFileBytes: SYNC_MAX_BLOB_BYTES,
          maxBlobChunkBytes: SYNC_MAX_BLOB_CHUNK_BYTES,
        });
      }

      if (pathname === "/api/collector/v1/usage") {
        if (request.method !== "POST") {
          return result(405, { error: "method_not_allowed" }, { Allow: "POST" });
        }
        if (!usageStore?.ingest) return result(501, { error: "usage_store_unavailable" });
        const body = await readJsonBody(request, MAX_USAGE_BODY_BYTES);
        const usage = await usageStore.ingest(body.deviceId, body.snapshot);
        return result(200, { ok: true, usage });
      }

      if (pathname === "/api/collector/v1/sync/pull") {
        if (request.method !== "POST") {
          return result(405, { error: "method_not_allowed" }, { Allow: "POST" });
        }
        if (!syncStore?.pull) return result(501, { error: "sync_store_unavailable" });
        const body = await readJsonBody(request, MAX_USAGE_BODY_BYTES);
        return result(200, await syncStore.pull(body.workspaceId, body.sinceRevision, {
          metadataOnly: body.metadataOnly === true,
        }));
      }

      if (pathname === "/api/collector/v1/sync/push") {
        if (request.method !== "POST") {
          return result(405, { error: "method_not_allowed" }, { Allow: "POST" });
        }
        if (!syncStore?.push) return result(501, { error: "sync_store_unavailable" });
        const body = await readJsonBody(request, MAX_SYNC_BODY_BYTES);
        return result(200, await syncStore.push(body.workspaceId, body.deviceId, body.files));
      }

      if (pathname === "/api/collector/v1/sync/blob") {
        if (!syncStore?.readBlobChunk || !syncStore?.writeBlobChunk) {
          return result(501, { error: "sync_store_unavailable" });
        }
        const workspaceId = requiredQuery(url, "workspaceId");
        const object = requiredQuery(url, "object");
        const offset = numericQuery(url, "offset", 0);
        if (request.method === "GET") {
          const limit = numericQuery(url, "limit", SYNC_MAX_BLOB_CHUNK_BYTES);
          const response = await syncStore.readBlobChunk(workspaceId, object, offset, limit);
          return {
            statusCode: 200,
            body: response.chunk,
            contentType: "application/octet-stream",
            headers: {
              "Cache-Control": "no-store",
              "X-CW-Offset": String(response.offset),
              "X-CW-Total-Bytes": String(response.totalBytes),
            },
          };
        }
        if (request.method === "PUT") {
          const total = numericQuery(url, "total");
          const chunk = await readBinaryBody(request, SYNC_MAX_BLOB_CHUNK_BYTES);
          return result(200, await syncStore.writeBlobChunk(workspaceId, object, offset, total, chunk));
        }
        return result(405, { error: "method_not_allowed" }, { Allow: "GET, PUT" });
      }

      if (pathname === "/api/collector/v1/sync/progress") {
        if (request.method !== "POST") {
          return result(405, { error: "method_not_allowed" }, { Allow: "POST" });
        }
        if (!syncStore?.reportProgress) return result(501, { error: "sync_store_unavailable" });
        const body = await readJsonBody(request, MAX_USAGE_BODY_BYTES);
        return result(200, { ok: true, activity: syncStore.reportProgress(body.deviceId, body) });
      }

      return result(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof CollectorApiError) {
        return result(error.statusCode, { error: error.code, message: error.message });
      }
      return result(400, { error: "invalid_request", message: error?.message || "invalid request" });
    }
  };
}
