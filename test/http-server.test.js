import assert from "node:assert/strict";
import test from "node:test";

import { createGatewayServer } from "../src/http-server.js";
import { buildStatsPayload } from "../src/quota-service.js";
import { freshStatsInput } from "./fixtures/codex-rate-limits.js";

const SECRET = "watch-gateway-http-secret";
const FRESH_STATS = buildStatsPayload(freshStatsInput());

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}

async function withGateway({ stats = FRESH_STATS, health } = {}, run) {
  const quotaService = {
    getStats: () => stats,
    getHealth: () => health ?? ({
      status: stats ? "ok" : "degraded",
      ready: Boolean(stats),
      fresh: Boolean(stats),
      running: true,
      codexConnected: true,
      updatedAt: stats?.limits?.providers?.[0]?.updatedAt ?? null,
      consecutiveFailures: stats ? 0 : 1,
      error: stats ? null : "stale",
    }),
  };
  const server = createGatewayServer({
    config: { tokenMonitorSecret: SECRET },
    quotaService,
  });
  await listen(server);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run(baseUrl);
  } finally {
    await close(server);
  }
}

function apkHeaders({ bearer = SECRET, custom = SECRET } = {}) {
  const headers = { Accept: "application/json" };
  if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
  if (custom !== null) headers["X-Token-Monitor-Secret"] = custom;
  return headers;
}

test("GET /api/health is public for the APK pre-auth connectivity probe", async () => {
  await withGateway({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^application\/json\b/);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.fresh, true);
  });
});

test("admin shell is served with strict browser security headers", async () => {
  await withGateway({}, async (baseUrl) => {
    const redirect = await fetch(`${baseUrl}/admin`, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "/admin/");

    const response = await fetch(`${baseUrl}/admin/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html\b/);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(await response.text(), /VWatch Quota Hub/);
  });
});

test("GET /api/health does not expose upstream error details", async () => {
  const sensitiveError = "credential path C:/private/codex/auth.json failed";
  await withGateway({
    stats: null,
    health: {
      status: "degraded",
      ready: false,
      fresh: false,
      running: true,
      codexConnected: false,
      error: sensitiveError,
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(Object.hasOwn(body, "error"), false);
    assert.equal(JSON.stringify(body).includes(sensitiveError), false);
  });
});

test("GET /api/stats returns 401 when authentication headers are absent", async () => {
  await withGateway({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stats`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.equal((await response.json()).error, "authentication_required");
  });
});

test("GET /api/stats returns 403 for an incorrect secret", async () => {
  await withGateway({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stats`, {
      headers: apkHeaders({ bearer: "wrong", custom: "wrong" }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "forbidden");
  });
});

test("GET /api/stats rejects disagreeing APK dual authentication headers", async () => {
  await withGateway({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stats`, {
      headers: apkHeaders({ custom: "a-different-secret" }),
    });
    assert.equal(response.status, 403);
  });
});

test("GET /api/stats serves a fresh APK-compatible payload", async () => {
  await withGateway({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stats`, {
      headers: apkHeaders(),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), FRESH_STATS);
  });
});

test("GET /api/stats returns 503 instead of serving a stale snapshot", async () => {
  await withGateway({ stats: null }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stats`, {
      headers: apkHeaders(),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, "quota_unavailable");
  });
});
