import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { UsageStore, normalizeUsageSnapshot } from "../src/usage-store.js";

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
