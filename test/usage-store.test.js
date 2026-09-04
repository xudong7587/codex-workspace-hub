import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { UsageStore, normalizeUsageSnapshot, projectUsageSnapshot } from "../src/usage-store.js";

function sample() {
  const period = {
    totalTokens: 1_000_000,
    inputTokens: 100_000,
    cacheReadTokens: 850_000,
    cacheWriteTokens: 0,
    outputTokens: 50_000,
    reasoningTokens: 12_000,
    messageCount: 42,
    costUsd: 3.25,
  };
  return {
    source: "token-monitor",
    capturedAt: "2026-08-31T08:00:00.000Z",
    dayKey: "2026-08-31",
    monthKey: "2026-08",
    usdCnyRate: 7.2,
    periods: { day: period, month: period, total: period },
  };
}

test("usage snapshots preserve exact counters and validate the exchange rate", () => {
  const snapshot = normalizeUsageSnapshot(sample(), Date.parse("2026-08-31T09:00:00Z"));
  assert.equal(snapshot.periods.day.totalTokens, 1_000_000);
  assert.equal(snapshot.periods.day.cacheReadTokens, 850_000);
  assert.equal(snapshot.periods.day.costUsd, 3.25);
  assert.equal(snapshot.usdCnyRate, 7.2);
  assert.throws(() => normalizeUsageSnapshot({ ...sample(), usdCnyRate: 0.5 }), /usdCnyRate/i);
});

test("usage snapshots preserve the lightweight reporter source", () => {
  const snapshot = normalizeUsageSnapshot({ ...sample(), source: "cw-usage-reporter" });
  assert.equal(snapshot.source, "cw-usage-reporter");
});

test("usage history persists atomically across restarts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cw-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new UsageStore({ dataDir: directory });
  await first.initialize();
  assert.equal(first.get(), null);
  await first.replace(sample());

  const raw = JSON.parse(await readFile(join(directory, "usage-history.json"), "utf8"));
  assert.equal(raw.periods.total.totalTokens, 1_000_000);

  const second = new UsageStore({ dataDir: directory });
  await second.initialize();
  assert.equal(second.get().periods.month.costUsd, 3.25);
});

test("forgetting one device removes only its usage snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cw-usage-forget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new UsageStore({ dataDir: directory });
  await store.initialize();
  await store.ingest("office-pc", sample());
  await store.ingest("home-pc", { ...sample(), periods: { ...sample().periods, total: { ...sample().periods.total, totalTokens: 250 } } });

  const result = await store.forgetDevice("office-pc");
  assert.equal(result.removed, true);
  assert.equal(store.get().deviceCount, 1);
  assert.equal(store.get().devices[0].id, "home-pc");

  const restarted = new UsageStore({ dataDir: directory });
  await restarted.initialize();
  assert.deepEqual(restarted.get().devices.map((device) => device.id), ["home-pc"]);
});

function quota(usedPercent, resetsAt = "2026-09-08T00:00:00.000Z") {
  return { limits: { providers: [{ provider: "codex", windows: [{ kind: "weekly", usedPercent, resetsAt }] }] } };
}

test("offline usage grows from the last collector baseline and recalibrates on reconnect", () => {
  const exact = normalizeUsageSnapshot({
    ...sample(), capturedAt: "2026-09-04T10:00:00.000Z", dayKey: "2026-09-04",
    weekKey: "2026-W36", monthKey: "2026-09",
  });
  const online = projectUsageSnapshot(exact, quota(40), null, Date.parse("2026-09-04T10:05:00.000Z"));
  assert.equal(online.usage.mode, "collector");
  assert.equal(online.usage.collectorOnline, true);

  const offline = projectUsageSnapshot(exact, quota(45), online.state, Date.parse("2026-09-04T10:20:01.000Z"));
  assert.equal(offline.usage.mode, "hybrid_estimate");
  assert.equal(offline.usage.collectorOnline, false);
  assert.equal(offline.usage.periods.total.totalTokens, 1_125_000);
  assert.equal(offline.usage.periods.total.estimated, true);

  const unchanged = projectUsageSnapshot(exact, quota(45), offline.state, Date.parse("2026-09-04T10:25:00.000Z"));
  assert.equal(unchanged.usage.periods.total.totalTokens, 1_125_000, "repeated reads must not double count the same quota point");

  const reset = projectUsageSnapshot(exact, quota(2, "2026-09-15T00:00:00.000Z"), unchanged.state, Date.parse("2026-09-04T10:30:00.000Z"));
  assert.equal(reset.usage.periods.total.totalTokens, 1_175_000);

  const refreshed = normalizeUsageSnapshot({ ...exact, capturedAt: "2026-09-04T10:31:00.000Z", periods: { ...exact.periods, total: { ...exact.periods.total, totalTokens: 1_200_000 } } });
  const reconnected = projectUsageSnapshot(refreshed, quota(3, "2026-09-15T00:00:00.000Z"), reset.state, Date.parse("2026-09-04T10:32:00.000Z"));
  assert.equal(reconnected.usage.mode, "collector");
  assert.equal(reconnected.usage.periods.total.totalTokens, 1_200_000, "fresh exact data replaces the estimate");
});

test("offline projection calibration survives a hub restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cw-usage-projection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const exact = {
    ...sample(), capturedAt: "2026-09-04T10:00:00.000Z", dayKey: "2026-09-04",
    weekKey: "2026-W36", monthKey: "2026-09",
  };
  const first = new UsageStore({ dataDir: directory });
  await first.initialize();
  await first.ingest("office-pc", exact);
  await first.getProjected(quota(40), Date.parse("2026-09-04T10:05:00.000Z"));

  const restarted = new UsageStore({ dataDir: directory });
  await restarted.initialize();
  const projected = await restarted.getProjected(quota(44), Date.parse("2026-09-04T10:20:01.000Z"));
  assert.equal(projected.mode, "hybrid_estimate");
  assert.equal(projected.periods.total.totalTokens, 1_100_000);
});
