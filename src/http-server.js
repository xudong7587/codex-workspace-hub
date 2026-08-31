import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAdminApi } from "./admin-api.js";
import { authenticateRequest } from "./auth.js";
import { createCollectorApi } from "./collector-api.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = join(MODULE_DIR, "..", "public");
const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
});
const ADMIN_CSP = "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'";

function hasCredentialHeaders(request) {
  const headers = request?.headers;
  if (!headers) return false;
  if (typeof headers.get === "function") {
    return headers.get("authorization") !== null
      || headers.get("x-token-monitor-secret") !== null;
  }
  return headers.authorization !== undefined
    || headers.Authorization !== undefined
    || headers["x-token-monitor-secret"] !== undefined
    || headers["X-Token-Monitor-Secret"] !== undefined;
}

function writeBody(request, response, statusCode, body, contentType, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  if (request.method === "HEAD") response.end();
  else response.end(body);
}

function writeJson(request, response, statusCode, payload, extraHeaders = {}) {
  writeBody(
    request,
    response,
    statusCode,
    `${JSON.stringify(payload)}\n`,
    "application/json; charset=utf-8",
    { "Cache-Control": "no-store", ...extraHeaders },
  );
}

function publicHealth(quotaService) {
  const health = quotaService?.getHealth?.() || {};
  return {
    ok: true,
    status: health.status || "degraded",
    ready: Boolean(health.ready),
    fresh: Boolean(health.fresh),
    running: Boolean(health.running),
    enabledProviders: health.enabledProviders ?? 0,
    updatedAt: health.updatedAt ?? null,
    lastAttemptAt: health.lastAttemptAt ?? null,
    consecutiveFailures: health.consecutiveFailures ?? 0,
  };
}

function loadAdminAssets(publicDir) {
  return new Map([
    ["/admin/", {
      body: readFileSync(join(publicDir, "index.html")),
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-store",
    }],
    ["/admin/app.css", {
      body: readFileSync(join(publicDir, "app.css")),
      contentType: "text/css; charset=utf-8",
      cacheControl: "no-store",
    }],
    ["/admin/app.js", {
      body: readFileSync(join(publicDir, "app.js")),
      contentType: "text/javascript; charset=utf-8",
      cacheControl: "no-store",
    }],
  ]);
}

export function createGatewayServer(input, maybeOptions = {}) {
  const options = input?.quotaService || input?.providerManager
    ? input
    : { ...maybeOptions, providerManager: input, quotaService: input };
  const config = options.config || options;
  const providerManager = options.providerManager || options.quotaService;
  const credentialStore = options.credentialStore || null;
  const usageStore = options.usageStore || null;
  const syncStore = options.syncStore || null;
  const logger = options.logger || null;
  const bridgeSecret = () => credentialStore?.getBridgeSecret()
    || config.tokenMonitorSecret
    || config.secret
    || "";
  if (!providerManager) throw new TypeError("createGatewayServer requires providerManager");
  const adminAssets = options.adminAssets || loadAdminAssets(options.publicDir || DEFAULT_PUBLIC_DIR);
  const handleAdminApi = options.handleAdminApi || createAdminApi({
    providerManager,
    adminToken: config.adminToken,
    credentialStore,
    usageStore,
    syncStore,
    logger,
  });
  const handleCollectorApi = options.handleCollectorApi || createCollectorApi({ usageStore, syncStore });

  return createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url || "/", "http://hub.invalid").pathname;

      if (pathname.startsWith("/admin/api/")) {
        const result = await handleAdminApi(request, pathname);
        writeJson(request, response, result.statusCode, result.payload, result.headers);
        return;
      }

      if (pathname.startsWith("/api/collector/v1/")) {
        if (!hasCredentialHeaders(request)) {
          writeJson(request, response, 401, { error: "authentication_required" }, { "WWW-Authenticate": "Bearer" });
          return;
        }
        if (!authenticateRequest(request, bridgeSecret())) {
          writeJson(request, response, 403, { error: "forbidden" });
          return;
        }
        const result = await handleCollectorApi(request, pathname);
        writeJson(request, response, result.statusCode, result.payload, result.headers);
        return;
      }

      if (pathname === "/" || pathname === "/admin") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          writeJson(request, response, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
          return;
        }
        response.writeHead(302, { Location: "/admin/", ...SECURITY_HEADERS });
        response.end();
        return;
      }

      const asset = adminAssets.get(pathname);
      if (asset) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          writeJson(request, response, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
          return;
        }
        writeBody(request, response, 200, asset.body, asset.contentType, {
          "Cache-Control": asset.cacheControl,
          "Content-Security-Policy": ADMIN_CSP,
        });
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        writeJson(request, response, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
        return;
      }

      if (pathname === "/livez") {
        writeJson(request, response, 200, { status: "ok" });
        return;
      }

      if (pathname === "/readyz") {
        const ready = Boolean(providerManager.getStats?.());
        writeJson(
          request,
          response,
          ready ? 200 : 503,
          { status: ready ? "ready" : "not_ready" },
        );
        return;
      }

      if (pathname === "/api/health") {
        writeJson(request, response, 200, publicHealth(providerManager));
        return;
      }

      if (pathname !== "/api/stats") {
        writeJson(request, response, 404, { error: "not_found" });
        return;
      }

      if (!hasCredentialHeaders(request)) {
        writeJson(
          request,
          response,
          401,
          { error: "authentication_required" },
          { "WWW-Authenticate": "Bearer" },
        );
        return;
      }
      if (!authenticateRequest(request, bridgeSecret())) {
        writeJson(request, response, 403, { error: "forbidden" });
        return;
      }

      const stats = providerManager.getStats?.();
      if (!stats) {
        writeJson(request, response, 503, {
          error: "quota_unavailable",
          message: "No fresh bridge-compatible quota snapshot is available",
        });
        return;
      }
      writeJson(request, response, 200, stats);
    })().catch((error) => {
      logger?.error?.("Unhandled HTTP request error", { errorType: error?.name || "Error" });
      if (!response.headersSent) {
        writeJson(request, response, 500, { error: "internal_error" });
      } else {
        response.destroy();
      }
    });
  });
}

export function startGatewayServer(serverOrOptions, maybeOptions = {}) {
  const server = typeof serverOrOptions?.listen === "function"
    ? serverOrOptions
    : createGatewayServer(serverOrOptions);
  const config = typeof serverOrOptions?.listen === "function"
    ? maybeOptions
    : serverOrOptions.config || serverOrOptions;

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });
}

export function closeGatewayServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}
