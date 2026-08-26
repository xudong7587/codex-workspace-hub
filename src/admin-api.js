import { authenticateAdminRequest } from "./auth.js";

const MAX_BODY_BYTES = 32 * 1_024;

class AdminApiError extends Error {
  constructor(message, statusCode = 400, code = "invalid_request", headers = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }
}

async function readJsonBody(request) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new AdminApiError("请求必须使用 application/json", 415, "unsupported_media_type");
  }
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new AdminApiError("请求内容过大", 413, "body_too_large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new AdminApiError("请求内容过大", 413, "body_too_large");
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new AdminApiError("JSON 请求内容无效", 400, "invalid_json");
  }
}

function result(statusCode, payload, headers = {}) {
  return { statusCode, payload, headers };
}

function routeProvider(pathname) {
  const match = /^\/admin\/api\/providers\/([a-z0-9_-]+)(?:\/(refresh|login))?$/.exec(pathname);
  return match ? { providerId: match[1], action: match[2] || null } : null;
}

function requestHeader(request, name) {
  const value = request?.headers?.[name.toLowerCase()] ?? request?.headers?.[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return value ?? null;
}

function loginSessionId(value, fieldName) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value)) {
    throw new AdminApiError(`${fieldName} 无效`, 400, "invalid_login_session");
  }
  return value;
}

export function createAdminApi(options = {}) {
  const providerManager = options.providerManager;
  const adminToken = options.adminToken || "";
  const logger = options.logger || null;
  if (!providerManager) throw new TypeError("createAdminApi requires providerManager");
  let refreshedLoginId = null;
  let refreshingLoginId = null;

  const refreshCompletedLogin = (loginId) => {
    if (!loginId || loginId === refreshedLoginId || loginId === refreshingLoginId) return;
    refreshingLoginId = loginId;
    providerManager.invalidateProvider?.("codex");
    void providerManager.pollNow("codex").then(() => {
      refreshedLoginId = loginId;
    }).catch((error) => {
      logger?.warn?.("Codex post-login refresh failed", {
        errorType: error?.name || "Error",
      });
    }).finally(() => {
      if (refreshingLoginId === loginId) refreshingLoginId = null;
    });
  };

  return async function handleAdminApi(request, pathname) {
    if (!pathname.startsWith("/admin/api/")) return null;
    if (!authenticateAdminRequest(request, adminToken)) {
      return result(
        401,
        { error: "admin_authentication_required", message: "管理令牌无效" },
        { "WWW-Authenticate": "Bearer" },
      );
    }

    try {
      if (pathname === "/admin/api/state") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return result(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
        }
        return result(200, providerManager.getAdminState());
      }

      if (pathname === "/admin/api/settings") {
        if (request.method !== "PUT") {
          return result(405, { error: "method_not_allowed" }, { Allow: "PUT" });
        }
        const body = await readJsonBody(request);
        return result(200, await providerManager.updateSettings(body));
      }

      if (pathname === "/admin/api/refresh") {
        if (request.method !== "POST") {
          return result(405, { error: "method_not_allowed" }, { Allow: "POST" });
        }
        await providerManager.pollNow(null, { manual: true });
        return result(200, providerManager.getAdminState());
      }

      const providerRoute = routeProvider(pathname);
      if (!providerRoute) return result(404, { error: "not_found" });
      const provider = providerManager.getProvider(providerRoute.providerId);
      if (!provider) return result(404, { error: "provider_not_found" });

      if (providerRoute.action === null) {
        if (request.method !== "PUT") {
          return result(405, { error: "method_not_allowed" }, { Allow: "PUT" });
        }
        const body = await readJsonBody(request);
        return result(200, await providerManager.updateProvider(providerRoute.providerId, body));
      }

      if (providerRoute.action === "refresh") {
        if (request.method !== "POST") {
          return result(405, { error: "method_not_allowed" }, { Allow: "POST" });
        }
        await providerManager.pollNow(providerRoute.providerId, { manual: true });
        return result(200, providerManager.getAdminState());
      }

      if (providerRoute.action === "login" && providerRoute.providerId === "codex") {
        if (!provider.loginManager) return result(404, { error: "login_not_supported" });
        if (request.method === "POST") {
          const sessionId = loginSessionId(
            requestHeader(request, "x-vwatch-login-id"),
            "登录会话 ID",
          );
          return result(202, await provider.loginManager.begin({ sessionId }));
        }
        if (request.method === "DELETE") {
          const expectedId = loginSessionId(
            new URL(request.url || pathname, "http://hub.invalid").searchParams.get("id"),
            "待取消登录会话 ID",
          );
          const current = provider.loginManager.getState();
          if (expectedId && current.id && current.id !== expectedId) {
            return result(409, {
              error: "login_session_changed",
              message: "登录会话已变化，未取消当前会话",
            });
          }
          await provider.loginManager.cancel();
          return result(200, provider.loginManager.getState());
        }
        if (request.method === "GET" || request.method === "HEAD") {
          const state = provider.loginManager.getState();
          if (state.status === "complete") refreshCompletedLogin(state.id);
          return result(200, state);
        }
        return result(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD, POST, DELETE" });
      }

      return result(404, { error: "not_found" });
    } catch (error) {
      if (error?.code === "REFRESH_COOLDOWN") {
        return result(
          429,
          { error: "refresh_cooldown", message: "手动刷新过于频繁" },
          { "Retry-After": String(error.retryAfterSeconds || 60) },
        );
      }
      if (error instanceof AdminApiError) {
        return result(
          error.statusCode,
          { error: error.code, message: error.message },
          error.headers,
        );
      }
      return result(400, {
        error: "invalid_request",
        message: "设置无效，请检查输入值",
      });
    }
  };
}

export { MAX_BODY_BYTES };
