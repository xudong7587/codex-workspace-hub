import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGatewayServer } from "../src/http-server.js";
import { UsageStore } from "../src/usage-store.js";

const SECRET = "collector-test-secret-value";
const auth = { Authorization: `Bearer ${SECRET}` };

async function withServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "cw-snapshot-"));
  const usageStore = new UsageStore({ dataDir });
  await usageStore.initialize();
  const quotaService = { getStats: () => null, getHealth: () => ({}) };
  const server = createGatewayServer({ config: { tokenMonitorSecret: SECRET }, quotaService, usageStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, usageStore); }
  finally { await new Promise((resolve) => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); }
}

function post(baseUrl, path, body, secret = SECRET) {
  return fetch(`${baseUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("legacy collector usage remains available while project sync is removed", async () => {
  await withServer(async (baseUrl, usageStore) => {
    const status = await fetch(`${baseUrl}/api/collector/v1/status`, { headers: auth });
    assert.deepEqual(await status.json(), { ok: true, protocolVersion: 1, usage: true, sync: false });
    const period = { totalTokens: 10, inputTokens: 10, costUsd: 0 };
    const snapshot = { source: "tokscale", capturedAt: "2026-08-31T05:00:00Z", dayKey: "2026-08-31", weekKey: "2026-W36", monthKey: "2026-08", usdCnyRate: 7.2, periods: { day: period, week: period, month: period, total: period } };
    assert.equal((await post(baseUrl, "/api/collector/v1/usage", { deviceId: "office-pc", snapshot })).status, 200);
    assert.equal(usageStore.get().periods.total.totalTokens, 10);
    assert.equal((await post(baseUrl, "/api/collector/v1/sync/push", {})).status, 404);
  });
});

test("removed project endpoints reject uploads and downloads with 404", async () => {
  await withServer(async (baseUrl) => {
    for (const path of ["/api/cw/v1/snapshots/status", "/api/cw/v1/snapshots/list", "/api/cw/v1/snapshots/blob", "/api/cw/v1/snapshots/commit", "/api/collector/v1/sync/push", "/api/collector/v1/sync/pull"]) {
      for (const method of ["GET", "POST", "PUT"]) {
        const response = await fetch(`${baseUrl}${path}`, { method, headers: auth });
        assert.equal(response.status, 404, `${method} ${path}`);
      }
    }
    assert.equal((await post(baseUrl, "/api/collector/v1/usage", {}, "wrong")).status, 403);
  });
});
