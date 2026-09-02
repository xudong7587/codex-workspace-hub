import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGatewayServer } from "../src/http-server.js";
import { SnapshotStore } from "../src/snapshot-store.js";
import { UsageStore } from "../src/usage-store.js";

const SECRET = "collector-test-secret-value";
const auth = { Authorization: `Bearer ${SECRET}` };

async function withServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "cw-snapshot-"));
  const usageStore = new UsageStore({ dataDir });
  const snapshotStore = new SnapshotStore({ dataDir });
  await usageStore.initialize();
  const quotaService = { getStats: () => null, getHealth: () => ({}) };
  const server = createGatewayServer({ config: { tokenMonitorSecret: SECRET }, quotaService, usageStore, snapshotStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, usageStore, snapshotStore); }
  finally { await new Promise((resolve) => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); }
}

function post(baseUrl, path, body, secret = SECRET) {
  return fetch(`${baseUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function upload(baseUrl, workspaceId, encrypted, chunkBytes = 512 * 1024) {
  const object = createHash("sha256").update(encrypted).digest("hex");
  let offset = 0;
  while (offset < encrypted.length) {
    const chunk = encrypted.subarray(offset, Math.min(encrypted.length, offset + chunkBytes));
    const response = await fetch(`${baseUrl}/api/cw/v1/snapshots/blob?workspaceId=${workspaceId}&object=${object}&offset=${offset}&total=${encrypted.length}`, { method: "PUT", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: chunk });
    assert.equal(response.status, 200);
    offset = (await response.json()).receivedBytes;
  }
  return object;
}

test("legacy collector usage remains available while project sync is deprecated", async () => {
  await withServer(async (baseUrl, usageStore) => {
    const status = await fetch(`${baseUrl}/api/collector/v1/status`, { headers: auth });
    assert.deepEqual(await status.json(), { ok: true, protocolVersion: 1, usage: true, sync: false, deprecated: true, replacement: "/api/cw/v1/snapshots/status" });
    const period = { totalTokens: 10, inputTokens: 10, costUsd: 0 };
    const snapshot = { source: "tokscale", capturedAt: "2026-08-31T05:00:00Z", dayKey: "2026-08-31", weekKey: "2026-W36", monthKey: "2026-08", usdCnyRate: 7.2, periods: { day: period, week: period, month: period, total: period } };
    assert.equal((await post(baseUrl, "/api/collector/v1/usage", { deviceId: "office-pc", snapshot })).status, 200);
    assert.equal(usageStore.get().periods.total.totalTokens, 10);
    assert.equal((await post(baseUrl, "/api/collector/v1/sync/push", {})).status, 404);
  });
});

test("snapshot endpoints require the bridge key", async () => {
  await withServer(async (baseUrl) => assert.equal((await post(baseUrl, "/api/cw/v1/snapshots/list", { workspaceId: "project-a" }, "wrong")).status, 403));
});

test("encrypted snapshot upload resumes and committed blobs download in chunks", async () => {
  await withServer(async (baseUrl, usageStore, snapshotStore) => {
    const encrypted = Buffer.alloc(1_400_000);
    for (let index = 0; index < encrypted.length; index += 1) encrypted[index] = index % 251;
    const object = createHash("sha256").update(encrypted).digest("hex");
    const first = encrypted.subarray(0, 400_000);
    const put = (offset, body) => fetch(`${baseUrl}/api/cw/v1/snapshots/blob?workspaceId=project-a&object=${object}&offset=${offset}&total=${encrypted.length}`, { method: "PUT", headers: { ...auth, "Content-Type": "application/octet-stream" }, body });
    assert.equal((await (await put(0, first)).json()).receivedBytes, first.length);
    assert.equal((await (await put(0, first)).json()).receivedBytes, first.length);
    let offset = first.length;
    while (offset < encrypted.length) offset = (await (await put(offset, encrypted.subarray(offset, Math.min(encrypted.length, offset + 512 * 1024)))).json()).receivedBytes;
    const committed = await post(baseUrl, "/api/cw/v1/snapshots/commit", { workspaceId: "project-a", workspaceName: "Project A", deviceId: "office-pc", parentSnapshotId: null, object, encryptedBytes: encrypted.length, kind: "baseline", fileCount: 4, summary: "Initial reviewed baseline" });
    assert.equal(committed.status, 201);
    const head = (await committed.json()).headSnapshotId;
    const received = [];
    offset = 0;
    while (offset < encrypted.length) {
      const response = await fetch(`${baseUrl}/api/cw/v1/snapshots/blob?workspaceId=project-a&object=${object}&offset=${offset}&limit=524288`, { headers: auth });
      assert.equal(response.status, 200);
      const chunk = Buffer.from(await response.arrayBuffer());
      received.push(chunk);
      offset += chunk.length;
    }
    assert.deepEqual(Buffer.concat(received), encrypted);
    assert.equal((await (await post(baseUrl, "/api/cw/v1/snapshots/list", { workspaceId: "project-a" })).json()).headSnapshotId, head);
    const summary = await snapshotStore.getSummary();
    assert.equal(summary.workspaceCount, 1);
    assert.equal(summary.snapshotCount, 1);
    assert.equal(summary.workspaces[0].name, "Project A");
  });
});

test("snapshot commit uses compare-and-swap head", async () => {
  await withServer(async (baseUrl) => {
    const first = Buffer.from("encrypted-baseline");
    const firstObject = await upload(baseUrl, "shared-project", first);
    const initial = await post(baseUrl, "/api/cw/v1/snapshots/commit", { workspaceId: "shared-project", workspaceName: "Shared Project", deviceId: "office-pc", parentSnapshotId: null, object: firstObject, encryptedBytes: first.length, kind: "baseline", fileCount: 2 });
    const head = (await initial.json()).headSnapshotId;
    const second = Buffer.from("encrypted-increment");
    const secondObject = await upload(baseUrl, "shared-project", second);
    const stale = await post(baseUrl, "/api/cw/v1/snapshots/commit", { workspaceId: "shared-project", deviceId: "home-pc", parentSnapshotId: null, object: secondObject, encryptedBytes: second.length, fileCount: 1 });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).currentHeadSnapshotId, head);
    assert.equal((await post(baseUrl, "/api/cw/v1/snapshots/commit", { workspaceId: "shared-project", deviceId: "home-pc", parentSnapshotId: head, object: secondObject, encryptedBytes: second.length, fileCount: 1 })).status, 201);
    assert.equal((await (await post(baseUrl, "/api/cw/v1/snapshots/list", { workspaceId: "shared-project" })).json()).snapshots.length, 2);
  });
});

test("uncommitted objects cannot be downloaded and diagnostics report upload residue", async () => {
  await withServer(async (baseUrl, usageStore, snapshotStore) => {
    const encrypted = Buffer.from("encrypted but not committed");
    const object = await upload(baseUrl, "uncommitted", encrypted);
    const response = await fetch(`${baseUrl}/api/cw/v1/snapshots/blob?workspaceId=uncommitted&object=${object}&offset=0`, { headers: auth });
    assert.equal(response.status, 400);
    const unfinished = Buffer.from("unfinished encrypted package");
    const unfinishedObject = createHash("sha256").update(unfinished).digest("hex");
    const partial = await fetch(`${baseUrl}/api/cw/v1/snapshots/blob?workspaceId=uncommitted&object=${unfinishedObject}&offset=0&total=${unfinished.length}`, { method: "PUT", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: unfinished.subarray(0, 5) });
    assert.equal(partial.status, 200);
    const diagnostics = await snapshotStore.getDiagnostics();
    assert.equal(diagnostics.workspaceCount, 0);
    assert.deepEqual(diagnostics.orphanObjects, [{ workspaceId: "uncommitted", object }]);
    assert.equal(diagnostics.partialUploads.length, 1);
  });
});
