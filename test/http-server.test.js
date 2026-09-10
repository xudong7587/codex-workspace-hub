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

async function withGateway({ stats = FRESH_STATS, health, credentialStore, usageStore } = {}, run) {
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
    credentialStore,
    usageStore,
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
    const body = await response.text();
    assert.match(body, /Codex Workspace Hub/);
    assert.match(body, /id="coreQuotaDock"/);
    assert.match(body, /href="https:\/\/github\.com\/xudong7587\/codex-workspace-hub\/releases\/latest"/);
    assert.doesNotMatch(body, /mobile-download-button" href="\/admin\/downloads\//);
  });
});

test("mobile bridge APK is available from the management origin", async () => {
  await withGateway({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/downloads/CWQuotaBridge-android-v0.3.3-beta9.apk`, {
      method: "HEAD",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/vnd.android.package-archive");
    assert.match(response.headers.get("content-disposition"), /CWQuotaBridge-android-v0\.3\.3-beta9\.apk/);
    assert.equal(Number(response.headers.get("content-length")), 1_879_189);
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

test("GET /api/stats immediately uses a bridge secret rotated in the panel", async () => {
  let currentSecret = "c".repeat(64);
  const credentialStore = {
    getBridgeSecret: () => currentSecret,
    getStatus: () => ({ setupRequired: false }),
  };
  await withGateway({ credentialStore }, async (baseUrl) => {
    const original = await fetch(`${baseUrl}/api/stats`, {
      headers: apkHeaders({ bearer: currentSecret, custom: currentSecret }),
    });
    assert.equal(original.status, 200);

    const oldSecret = currentSecret;
    currentSecret = "d".repeat(64);
    const rejected = await fetch(`${baseUrl}/api/stats`, {
      headers: apkHeaders({ bearer: oldSecret, custom: oldSecret }),
    });
    assert.equal(rejected.status, 403);
    const accepted = await fetch(`${baseUrl}/api/stats`, {
      headers: apkHeaders({ bearer: currentSecret, custom: currentSecret }),
    });
    assert.equal(accepted.status, 200);
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

test("GET /api/stats keeps official missing periods and costs null and exposes local detail separately", async () => {
  const accountUsage = { accountCount: 1, capturedAt: "2026-09-10T09:59:00Z", periods: {
    day: { totalTokens: null, partial: true }, week: { totalTokens: 300, partial: true },
    month: { totalTokens: 400, partial: true }, total: { totalTokens: 7123456789, partial: false },
  } };
  const localDetails = { deviceId: "office-pc", periods: { total: { costUsd: 3, pricedCostUsd: 2, estimatedCostUsd: 1 } } };
  const usageStore = { get: () => ({ periods: { total: { totalTokens: 6000 } }, accountUsage, localDetails, usdCnyRate: 7.2 }) };
  await withGateway({ usageStore }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stats`, { headers: { Authorization: `Bearer ${SECRET}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.usage.periods.total.totalTokens, 7123456789);
    assert.equal(body.usage.periods.day.totalTokens, null);
    assert.equal(body.usage.periods.total.costUsd, null);
    assert.equal(body.usage.costAvailable, false);
    assert.equal(body.usage.mode, "official_account");
    assert.deepEqual(body.usage.localDetails, localDetails);
  });
});

test("GET /api/stats exposes CW usage and applies the dashboard estimate", async () => {
  const usageStore = {
    get: () => ({
      capturedAt: "2026-09-02T07:30:00.000Z",
      source: "cw-usage-reporter",
      deviceCount: 0,
      usdCnyRate: 7.2,
      periods: {
        day: { totalTokens: 250_000, costUsd: 0 },
        week: { totalTokens: 1_000_000, costUsd: 0 },
        month: { totalTokens: 2_000_000, costUsd: 5.5 },
        total: { totalTokens: 3_000_000, costUsd: 0 },
      },
    }),
  };
  await withGateway({ usageStore }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stats`, { headers: apkHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.limits, FRESH_STATS.limits);
    assert.equal(body.usage.periods.total.totalTokens, 3_000_000);
    assert.equal(body.usage.periods.total.costUsd, 12);
    assert.equal(body.usage.periods.total.estimated, true);
    assert.equal(body.usage.periods.month.costUsd, 5.5);
    assert.equal(body.usage.periods.month.estimated, false);
    assert.equal(body.usage.usdCnyRate, 7.2);
    assert.equal(body.usage.mode, "collector");
    assert.equal(body.usage.collectorOnline, true);
  });
});

test("GET /api/stats preserves a projected cost supplied by the usage store", async () => {
  const usageStore = {
    get: () => ({
      capturedAt: "2026-09-04T07:30:00.000Z",
      source: "hybrid",
      mode: "hybrid_estimate",
      collectorOnline: false,
      usdCnyRate: 7.2,
      periods: {
        day: { totalTokens: 300_000, costUsd: 2.25, estimated: true },
        week: { totalTokens: 1_200_000, costUsd: 8.5, estimated: true },
        month: { totalTokens: 2_500_000, costUsd: 17.75, estimated: true },
        total: { totalTokens: 3_500_000, costUsd: 25.25, estimated: true },
      },
    }),
  };
  await withGateway({ usageStore }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stats`, { headers: apkHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.usage.periods.total.costUsd, 25.25);
    assert.equal(body.usage.periods.total.estimated, true);
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
