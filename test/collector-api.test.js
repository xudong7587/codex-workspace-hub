import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const dataDir = await mkdtemp(join(tmpdir(), "cw-collector-"));
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
    assert.deepEqual(summary.devices.map((device) => device.id), ["office-pc", "home-pc"]);
  });
});

test("collector endpoints require the bridge key", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, "/api/collector/v1/usage", {}, "wrong");
    assert.equal(response.status, 403);
  });
});

test("collector progress exposes a device before its first workspace commit", async () => {
  await withServer(async (baseUrl, usageStore, syncStore) => {
    const response = await post(baseUrl, "/api/collector/v1/sync/progress", {
      deviceId: "new-laptop", workspaceId: "first-project", status: "running", phase: "扫描本机差异", percent: 8,
    });
    assert.equal(response.status, 200);
    const summary = await syncStore.getSummary();
    assert.deepEqual(summary.devices.map((device) => device.id), ["new-laptop"]);
  });
});

test("forgetting a sync device preserves workspace files and detaches its records", async () => {
  await withServer(async (baseUrl, usageStore, syncStore) => {
    await post(baseUrl, "/api/collector/v1/sync/push", {
      workspaceId: "keep-project", deviceId: "old-terminal",
      files: [{ path: "README.md", hash: "d".repeat(64), baseRevision: 0, size: 9, blob: Buffer.from("encrypted").toString("base64") }],
    });
    syncStore.reportProgress("old-terminal", { workspaceId: "keep-project", status: "running", percent: 50 });

    const result = await syncStore.forgetDevice("old-terminal");
    assert.equal(result.detachedFiles, 1);
    assert.equal(result.removedActivities, 1);
    const summary = await syncStore.getSummary();
    assert.equal(summary.workspaceCount, 1);
    assert.equal(summary.fileCount, 1);
    assert.deepEqual(summary.devices, []);
    assert.equal((await syncStore.pull("keep-project", 0)).files.length, 1);
  });
});

test("collector protocol v2 transfers blobs in small chunks and publishes progress", async () => {
  await withServer(async (baseUrl, usageStore, syncStore) => {
    const encrypted = Buffer.alloc(900_000);
    for (let index = 0; index < encrypted.length; index += 1) encrypted[index] = index % 251;
    const object = createHash("sha256").update(encrypted).digest("hex");
    let offset = 0;
    while (offset < encrypted.length) {
      const chunk = encrypted.subarray(offset, Math.min(offset + 512 * 1024, encrypted.length));
      const response = await fetch(`${baseUrl}/api/collector/v1/sync/blob?workspaceId=project-a&object=${object}&offset=${offset}&total=${encrypted.length}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/octet-stream" },
        body: chunk,
      });
      assert.equal(response.status, 200);
      offset += chunk.length;
    }
    const commit = await post(baseUrl, "/api/collector/v1/sync/push", {
      workspaceId: "project-a", deviceId: "office-pc",
      files: [{ path: "src/app.js", hash: "c".repeat(64), baseRevision: 0, size: 880_000, object }],
    });
    assert.equal(commit.status, 200);
    const metadata = await post(baseUrl, "/api/collector/v1/sync/pull", { workspaceId: "project-a", sinceRevision: 0, metadataOnly: true });
    const metadataBody = await metadata.json();
    assert.equal(metadataBody.files[0].object, object);
    assert.equal(metadataBody.files[0].blob, undefined);
    const received = [];
    offset = 0;
    while (offset < encrypted.length) {
      const response = await fetch(`${baseUrl}/api/collector/v1/sync/blob?workspaceId=project-a&object=${object}&offset=${offset}&limit=${512 * 1024}`, {
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      assert.equal(response.status, 200);
      assert.equal(Number(response.headers.get("x-cw-total-bytes")), encrypted.length);
      const chunk = Buffer.from(await response.arrayBuffer());
      received.push(chunk);
      offset += chunk.length;
    }
    assert.deepEqual(Buffer.concat(received), encrypted);
    const progress = await post(baseUrl, "/api/collector/v1/sync/progress", {
      deviceId: "office-pc", workspaceId: "project-a", status: "running", phase: "上传本机更新", percent: 63,
      completedFiles: 3, totalFiles: 8, currentFile: "src/app.js",
    });
    assert.equal(progress.status, 200);
    const summary = await syncStore.getSummary();
    assert.equal(summary.activities[0].percent, 63);
    assert.equal(summary.activities[0].deviceId, "office-pc");
  });
});

test("collector protocol v3 records project mappings and keeps deletions as tombstones", async () => {
  await withServer(async (baseUrl, usageStore, syncStore) => {
    const hash = "e".repeat(64);
    const created = await post(baseUrl, "/api/collector/v1/sync/push", {
      protocolVersion: 3, workspaceId: "shared-notes", workspaceName: "Shared Notes", deviceId: "office-pc",
      files: [{ path: "notes/today.md", hash, baseRevision: 0, size: 5, blob: Buffer.from("opaque").toString("base64") }],
    });
    const createdBody = await created.json();
    assert.equal(createdBody.accepted[0].deleted, false);

    const removed = await post(baseUrl, "/api/collector/v1/sync/push", {
      protocolVersion: 3, workspaceId: "shared-notes", workspaceName: "Shared Notes", deviceId: "office-pc",
      files: [{ path: "notes/today.md", baseRevision: createdBody.accepted[0].revision, deleted: true }],
    });
    const removedBody = await removed.json();
    assert.equal(removedBody.accepted[0].deleted, true);

    const legacyPull = await post(baseUrl, "/api/collector/v1/sync/pull", { workspaceId: "shared-notes", sinceRevision: 0, metadataOnly: true });
    assert.deepEqual((await legacyPull.json()).files, []);
    const v3Pull = await post(baseUrl, "/api/collector/v1/sync/pull", {
      protocolVersion: 3, workspaceId: "shared-notes", workspaceName: "Shared Notes", deviceId: "home-pc", sinceRevision: 0, metadataOnly: true,
    });
    assert.equal((await v3Pull.json()).files[0].deleted, true);

    const summary = await syncStore.getSummary();
    assert.equal(summary.fileCount, 0);
    assert.equal(summary.workspaces[0].tombstoneCount, 1);
    assert.deepEqual(summary.workspaces[0].names, ["Shared Notes"]);
    assert.equal((await syncStore.getDiagnostics()).ok, true);
  });
});

test("blob upload resumes from the server-reported partial offset", async () => {
  await withServer(async (baseUrl) => {
    const encrypted = Buffer.alloc(700_000, 7);
    const object = createHash("sha256").update(encrypted).digest("hex");
    const first = encrypted.subarray(0, 400_000);
    const put = (offset, body) => fetch(`${baseUrl}/api/collector/v1/sync/blob?workspaceId=resume-test&object=${object}&offset=${offset}&total=${encrypted.length}`, {
      method: "PUT", headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/octet-stream" }, body,
    });
    assert.equal((await put(0, first)).status, 200);
    const retryBody = await (await put(0, first)).json();
    assert.equal(retryBody.receivedBytes, first.length);
    const completed = await put(retryBody.receivedBytes, encrypted.subarray(retryBody.receivedBytes));
    assert.equal((await completed.json()).complete, true);
  });
});
