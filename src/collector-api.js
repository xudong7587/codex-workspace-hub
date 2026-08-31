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

function result(statusCode, payload, headers = {}) {
  return { statusCode, payload, headers };
}

export function createCollectorApi(options = {}) {
  const usageStore = options.usageStore;
  const syncStore = options.syncStore;
  return async function handleCollectorApi(request, pathname) {
    if (!pathname.startsWith("/api/collector/v1/")) return null;
    try {
      if (pathname === "/api/collector/v1/status") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return result(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
        }
        return result(200, {
          ok: true,
          protocolVersion: 1,
          usage: Boolean(usageStore?.ingest),
          sync: Boolean(syncStore?.pull && syncStore?.push),
          maxEncryptedFileBytes: 8 * 1024 * 1024,
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
        return result(200, await syncStore.pull(body.workspaceId, body.sinceRevision));
      }

      if (pathname === "/api/collector/v1/sync/push") {
        if (request.method !== "POST") {
          return result(405, { error: "method_not_allowed" }, { Allow: "POST" });
        }
        if (!syncStore?.push) return result(501, { error: "sync_store_unavailable" });
        const body = await readJsonBody(request, MAX_SYNC_BODY_BYTES);
        return result(200, await syncStore.push(body.workspaceId, body.deviceId, body.files));
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
