import { randomBytes } from "node:crypto";

import { authenticateAdminRequest } from "./auth.js";

const MAX_BODY_BYTES = 32 * 1_024;
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60_000;
const MAX_ADMIN_SESSIONS = 64;

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

function bearerToken(request) {
  const authorization = requestHeader(request, "authorization");
  if (typeof authorization !== "string") return "";
  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(authorization.trim());
  return match ? match[1] : "";
}

function privateSetupRequest(request) {
  if (
    requestHeader(request, "forwarded")
    || requestHeader(request, "x-forwarded-for")
    || requestHeader(request, "x-real-ip")
  ) {
    return false;
  }
  const raw = String(request?.socket?.remoteAddress || "").toLowerCase();
  const address = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address.startsWith("10.") || address.startsWith("192.168.")) return true;
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  const parts = address.split(".").map(Number);
  return parts.length === 4
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 172
    && parts[1] >= 16
    && parts[1] <= 31;
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
  const credentialStore = options.credentialStore || null;
  const usageStore = options.usageStore || null;
  const syncStore = options.syncStore || null;
  const logger = options.logger || null;
  if (!providerManager) throw new TypeError("createAdminApi requires providerManager");
  let refreshedLoginId = null;
  let refreshingLoginId = null;
  const sessions = new Map();

  const removeExpiredSessions = (now = Date.now()) => {
    for (const [token, expiresAt] of sessions) {
      if (expiresAt <= now) sessions.delete(token);
    }
  };
  const issueSession = () => {
    removeExpiredSessions();
    while (sessions.size >= MAX_ADMIN_SESSIONS) {
      sessions.delete(sessions.keys().next().value);
    }
    const token = randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
    return token;
  };
  const sessionAuthenticated = (request) => {
    if (!credentialStore) return authenticateAdminRequest(request, adminToken);
    const token = bearerToken(request);
    if (!token) return false;
    const expiresAt = sessions.get(token) || 0;
    if (expiresAt <= Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  };
  const adminState = async () => {
    const state = providerManager.getAdminState();
    const enriched = {
      ...state,
      usage: usageStore?.get?.() || null,
      sync: await syncStore?.getSummary?.() || null,
    };
    if (!credentialStore) return enriched;
    return {
      ...enriched,
      bridge: {
        ...(state.bridge || {}),
        secret: credentialStore.getBridgeSecret(),
      },
    };
  };

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
    try {
      if (credentialStore && pathname === "/admin/api/setup") {
        if (request.method === "GET" || request.method === "HEAD") {
          return result(200, credentialStore.getStatus());
        }
        if (request.method !== "POST") {
          return result(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD, POST" });
        }
        if (!privateSetupRequest(request)) {
          return result(403, {
            error: "local_setup_required",
            message: "首次设置只能从 NAS 本机或局域网直连完成",
          });
        }
        const body = await readJsonBody(request);
        await credentialStore.completeSetup(body.adminPassword);
        return result(201, {
          setupRequired: false,
          sessionToken: issueSession(),
        });
      }

      if (credentialStore && pathname === "/admin/api/session" && request.method === "POST") {
        const body = await readJsonBody(request);
        if (!await credentialStore.authenticateAdmin(body.adminPassword)) {
          return result(
            401,
            { error: "admin_authentication_required", message: "管理密码错误" },
            { "WWW-Authenticate": "Bearer" },
          );
        }
        return result(200, { sessionToken: issueSession() });
      }

      if (credentialStore?.getStatus().setupRequired) {
        return result(428, { error: "setup_required", message: "请先完成首次设置" });
      }

      if (!sessionAuthenticated(request)) {
        return result(
          401,
          { error: "admin_authentication_required", message: "管理会话无效" },
          { "WWW-Authenticate": "Bearer" },
        );
      }

      if (credentialStore && pathname === "/admin/api/session") {
        if (request.method !== "DELETE") {
          return result(405, { error: "method_not_allowed" }, { Allow: "POST, DELETE" });
        }
        sessions.delete(bearerToken(request));
        return result(200, { ok: true });
      }

      if (pathname === "/admin/api/state") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return result(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
        }
        return result(200, await adminState());
      }

      if (pathname === "/admin/api/sync") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return result(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
        }
        return result(200, await syncStore?.getSummary?.() || null);
      }

      if (credentialStore && pathname === "/admin/api/bridge/rotate") {
        if (request.method !== "POST") {
          return result(405, { error: "method_not_allowed" }, { Allow: "POST" });
        }
        await credentialStore.rotateBridgeSecret();
        return result(200, await adminState());
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
        return result(200, await adminState());
      }

      if (pathname === "/admin/api/usage") {
        if (request.method !== "PUT") {
          return result(405, { error: "method_not_allowed" }, { Allow: "PUT" });
        }
        if (!usageStore?.replace) {
          return result(501, { error: "usage_store_unavailable", message: "用量历史存储未启用" });
        }
        const body = await readJsonBody(request);
        await usageStore.replace(body);
        return result(200, await adminState());
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
        return result(200, await adminState());
      }

      if (providerRoute.action === "login" && providerRoute.providerId === "codex") {
        if (!provider.loginManager) return result(404, { error: "login_not_supported" });
        if (request.method === "POST") {
          const sessionId = loginSessionId(
            requestHeader(request, "x-cw-login-id"),
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
      if (error?.code === "SETUP_COMPLETE") {
        return result(409, { error: "setup_complete", message: error.message });
      }
      if (error?.code === "REFRESH_COOLDOWN") {
        const retryAfterSeconds = error.retryAfterSeconds || 5;
        return result(
          429,
          { error: "refresh_cooldown", message: `请等待 ${retryAfterSeconds} 秒后再手动刷新` },
          { "Retry-After": String(retryAfterSeconds) },
        );
      }
      if (error instanceof AdminApiError) {
        return result(
          error.statusCode,
          { error: error.code, message: error.message },
          error.headers,
        );
      }
      if (pathname === "/admin/api/setup" || pathname === "/admin/api/session") {
        return result(400, {
          error: "invalid_credentials",
          message: error?.message || "凭据无效",
        });
      }
      return result(400, {
        error: "invalid_request",
        message: "设置无效，请检查输入值",
      });
    }
  };
}

export { MAX_BODY_BYTES };
