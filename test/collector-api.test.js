import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGatewayServer } from "../src/http-server.js";
import { SyncStore } from "../src/sync-store.js";
import { UsageStore } from "../src/usage-store.js";

const SECRET = "collector-test-secret-value";

function period(tokens, cost = 0) {
  return { totalTokens: tokens, inputTokens: tokens, costUsd: cost };
}

async function withServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "vwatch-collector-"));
  const usageStore = new UsageStore({ dataDir });
  const syncStore = new SyncStore({ dataDir });
  await usageStore.initialize();
  const quotaService = { getStats: () => null, getHealth: () => ({}) };
  const server = createGatewayServer({
    config: { tokenMonitorSecret: SECRET }, quotaService, usageStore, syncStore,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl, usageStore, syncStore);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

function post(baseUrl, path, body, secret = SECRET) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("collector usage replaces one device and aggregates multiple devices", async () => {
  await withServer(async (baseUrl, usageStore) => {
    const snapshot = {
      source: "tokscale", capturedAt: "2026-08-31T05:00:00Z",
      dayKey: "2026-08-31", weekKey: "2026-W36", monthKey: "2026-08", usdCnyRate: 7.2,
      periods: { day: period(10), week: period(20), month: period(30), total: period(40, 1) },
    };
    assert.equal((await post(baseUrl, "/api/collector/v1/usage", { deviceId: "office-pc", snapshot })).status, 200);
    assert.equal((await post(baseUrl, "/api/collector/v1/usage", { deviceId: "office-pc", snapshot: { ...snapshot, periods: { ...snapshot.periods, total: period(50, 2) } } })).status, 200);
    assert.equal((await post(baseUrl, "/api/collector/v1/usage", { deviceId: "home-pc", snapshot })).status, 200);
    assert.equal(usageStore.get().periods.total.totalTokens, 90);
    assert.equal(usageStore.get().deviceCount, 2);
  });
});

test("collector sync stores opaque blobs, reports workspaces, and rejects stale base revisions", async () => {
  await withServer(async (baseUrl, usageStore, syncStore) => {
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const first = await post(baseUrl, "/api/collector/v1/sync/push", {
      workspaceId: "notes", deviceId: "office-pc",
      files: [{ path: "README.md", hash: hashA, baseRevision: 0, size: 3, blob: Buffer.from("cipher-a").toString("base64") }],
    });
    assert.equal(first.status, 200);
    const stale = await post(baseUrl, "/api/collector/v1/sync/push", {
      workspaceId: "notes", deviceId: "home-pc",
      files: [{ path: "README.md", hash: hashB, baseRevision: 0, size: 3, blob: Buffer.from("cipher-b").toString("base64") }],
    });
    const staleBody = await stale.json();
    assert.equal(staleBody.conflicts.length, 1);
    const pull = await post(baseUrl, "/api/collector/v1/sync/pull", { workspaceId: "notes", sinceRevision: 0 });
    const pullBody = await pull.json();
    assert.equal(Buffer.from(pullBody.files[0].blob, "base64").toString(), "cipher-a");
    const summary = await syncStore.getSummary();
    assert.equal(summary.workspaceCount, 1);
    assert.equal(summary.fileCount, 1);
    assert.equal(summary.totalBytes, 3);
    assert.deepEqual(summary.devices.map((device) => device.id), ["office-pc"]);
  });
});

test("collector endpoints require the bridge key", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, "/api/collector/v1/usage", {}, "wrong");
    assert.equal(response.status, 403);
  });
});
