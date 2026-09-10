import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAccountUsage, aggregateAccountUsage } from "../src/account-usage.js";
import { UsageStore } from "../src/usage-store.js";

const NOW = Date.parse("2026-09-10T10:00:00Z");
function account(overrides = {}) {
  return normalizeAccountUsage({
    accountKey: "a".repeat(64), status: "available", capturedAt: "2026-09-10T09:59:00Z",
    lifetimeTokens: 7_123_456_789,
    dailyUsageBuckets: [{ startDate: "2026-09-08", tokens: 100 }, { startDate: "2026-09-09", tokens: 200 }],
    ...overrides,
  });
}
const snapshot = (accountUsage = account(), capturedAt = "2026-09-10T09:59:00Z") => ({
  source: "cw-usage-reporter", capturedAt, dayKey: "2026-09-10", weekKey: "2026-W37", monthKey: "2026-09", accountUsage,
  periods: { total: { totalTokens: 6000, costUsd: 3, pricedCostUsd: 2, estimatedCostUsd: 1, unpricedTokens: 250000 } },
});
async function storeFor(t) {
  const directory = await mkdtemp(join(tmpdir(), "cw-account-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new UsageStore({ dataDir: directory });
  await store.initialize();
  return { store, directory };
}

test("official counters preserve 64-bit values and whitelist identity/usage fields", () => {
  const result = account({ email: "never-upload@example.com", accessToken: "never-store", threadUsage: [{ text: "private" }] });
  assert.equal(result.lifetimeTokens, 7_123_456_789);
  assert.equal(result.email, undefined);
  assert.equal(result.accessToken, undefined);
  assert.equal(result.threadUsage, undefined);
});

test("same account on two PCs takes the latest read instead of summing or taking the maximum", () => {
  const result = aggregateAccountUsage([
    { accountUsage: account({ lifetimeTokens: 8000, capturedAt: "2026-09-10T09:50:00Z" }) },
    { accountUsage: account({ lifetimeTokens: 7000 }) },
  ], NOW);
  assert.equal(result.accountCount, 1);
  assert.equal(result.periods.total.totalTokens, 7000);
});

test("different identified accounts contribute once each; legacy PCs are not added", () => {
  const result = aggregateAccountUsage([
    { accountUsage: account({ lifetimeTokens: 100 }) },
    { accountUsage: account({ accountKey: "b".repeat(64), lifetimeTokens: 200 }) },
    { periods: { total: { totalTokens: 999999 } } },
  ], NOW);
  assert.equal(result.periods.total.totalTokens, 300);
  assert.equal(result.accountCount, 2);
  assert.equal(result.unidentifiedDeviceCount, 1);
  assert.equal(result.periods.total.partial, true);
});

test("missing today stays null and partial week is labelled without inventing zero days", () => {
  const result = aggregateAccountUsage([{ accountUsage: account() }], NOW);
  assert.equal(result.periods.day.totalTokens, null);
  assert.equal(result.periods.week.totalTokens, 300);
  assert.equal(result.periods.week.partial, true);
  assert.equal(result.latestBucketDate, "2026-09-09");
});

test("an explicitly returned zero is available; absent summary/buckets remain null", () => {
  const zero = aggregateAccountUsage([{ accountUsage: account({ lifetimeTokens: 0, dailyUsageBuckets: [{ startDate: "2026-09-10", tokens: 0 }] }) }], NOW);
  assert.deepEqual(zero.periods.day, { totalTokens: 0, partial: false });
  assert.equal(zero.periods.total.totalTokens, 0);
  const missing = aggregateAccountUsage([{ accountUsage: account({ lifetimeTokens: null, dailyUsageBuckets: null }) }], NOW);
  assert.equal(missing.periods.total.totalTokens, null);
  assert.equal(missing.periods.month.totalTokens, null);
});

test("invalid and duplicate buckets, unsafe counters, and plaintext identities are rejected", () => {
  assert.throws(() => account({ lifetimeTokens: -1 }), /counter/);
  assert.throws(() => account({ lifetimeTokens: 1.5 }), /counter/);
  assert.throws(() => account({ lifetimeTokens: Number.MAX_SAFE_INTEGER + 1 }), /counter/);
  assert.throws(() => account({ dailyUsageBuckets: [{ startDate: "2026-02-30", tokens: 1 }] }), /date/);
  assert.throws(() => account({ dailyUsageBuckets: [{ startDate: "2026-09-10", tokens: 1 }, { startDate: "2026-09-10", tokens: 2 }] }), /Duplicate/);
  assert.equal(account({ accountKey: "email@example.com" }).status, "unavailable");
});

test("period boundaries use Monday and calendar month independently of collector date", () => {
  const result = aggregateAccountUsage([{ accountUsage: account({ dailyUsageBuckets: [
    { startDate: "2026-08-31", tokens: 1 }, { startDate: "2026-09-01", tokens: 2 }, { startDate: "2026-09-07", tokens: 4 },
  ] }) }], Date.parse("2026-09-07T00:00:00Z"));
  assert.equal(result.periods.day.totalTokens, 4);
  assert.equal(result.periods.week.totalTokens, 4);
  assert.equal(result.periods.month.totalTokens, 6);
});

test("official data never grows from quota projection and remains cached while offline", async (t) => {
  const { store } = await storeFor(t);
  await store.ingest("office-pc", snapshot());
  const stats = { limits: { providers: [{ provider: "codex", windows: [{ kind: "weekly", usedPercent: 99 }] }] } };
  const usage = await store.getProjected(stats, NOW + 3600000);
  assert.equal(usage.mode, "official_account");
  assert.equal(usage.accountUsage.periods.total.totalTokens, 7_123_456_789);
  assert.equal(usage.accountUsage.stale, true);
  assert.equal(store.projection, null);
});

test("same-account API failure preserves last success, including after restart", async (t) => {
  const { store, directory } = await storeFor(t);
  await store.ingest("office-pc", snapshot());
  await store.ingest("office-pc", snapshot({ status: "unavailable", accountKey: "a".repeat(64) }, "2026-09-10T10:01:00Z"));
  const restarted = new UsageStore({ dataDir: directory });
  await restarted.initialize();
  const result = restarted.get(NOW);
  assert.equal(result.accountUsage.periods.total.totalTokens, 7_123_456_789);
  assert.equal(result.accountUsage.stale, true);
  assert.equal(result.accountUsage.capturedAt, "2026-09-10T09:59:00.000Z");
});

test("account change or unidentifiable login cannot reuse the previous account totals", async (t) => {
  const { store } = await storeFor(t);
  await store.ingest("office-pc", snapshot());
  await store.ingest("office-pc", snapshot({ status: "unavailable", accountKey: "b".repeat(64) }, "2026-09-10T10:01:00Z"));
  assert.equal(store.get(NOW).accountUsage.periods.total.totalTokens, null);
  await store.ingest("office-pc", snapshot({ status: "unavailable" }, "2026-09-10T10:02:00Z"));
  assert.equal(store.get(NOW).accountUsage.accountCount, 0);
  assert.equal(store.get(NOW).accountUsage.periods.total.totalTokens, null);
});

test("out-of-order delivery cannot roll back a device or its account identity", async (t) => {
  const { store } = await storeFor(t);
  await store.ingest("office-pc", snapshot());
  await store.ingest("office-pc", snapshot(account({ lifetimeTokens: 1 }), "2026-09-10T09:50:00Z"));
  assert.equal(store.get(NOW).accountUsage.periods.total.totalTokens, 7_123_456_789);
});

test("cost detail is one named PC, with known-price and estimated portions separate", async (t) => {
  const { store } = await storeFor(t);
  await store.ingest("office-pc", snapshot());
  await store.ingest("home-pc", snapshot(account(), "2026-09-10T10:01:00Z"));
  const result = store.get(NOW);
  assert.equal(result.accountUsage.accountCount, 1);
  assert.equal(result.localDetails.deviceId, "home-pc");
  assert.equal(result.localDetails.periods.total.pricedCostUsd, 2);
  assert.equal(result.localDetails.periods.total.estimatedCostUsd, 1);
  assert.equal(result.localDetails.periods.total.costUsd, 3, "never sum copied local histories as account cost");
});
