import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildStatsPayload,
  mapRateLimitsToStats,
  QuotaService,
  selectCodexRateLimit,
} from "../src/quota-service.js";
import {
  ACCOUNT_RESPONSE,
  CODEX_RATE_LIMIT_SNAPSHOT,
  EXPECTED_WINDOWS,
  FIXED_NOW,
  RATE_LIMITS_RESPONSE,
  freshStatsInput,
} from "./fixtures/codex-rate-limits.js";

test("selectCodexRateLimit selects the codex limit by canonical map key", () => {
  assert.equal(selectCodexRateLimit(RATE_LIMITS_RESPONSE), CODEX_RATE_LIMIT_SNAPSHOT);
});

test("selectCodexRateLimit accepts a case-insensitive limitId fallback", () => {
  const snapshot = { ...CODEX_RATE_LIMIT_SNAPSHOT, limitId: "CoDeX" };
  assert.equal(
    selectCodexRateLimit({ rateLimitsByLimitId: { anotherKey: snapshot } }),
    snapshot,
  );
});

test("buildStatsPayload emits the APK limits.providers schema", () => {
  const payload = buildStatsPayload(freshStatsInput());

  assert.deepEqual(Object.keys(payload), ["limits"]);
  assert.equal(Array.isArray(payload.limits.providers), true);
  assert.equal(payload.limits.providers.length, 1);

  const provider = payload.limits.providers[0];
  assert.equal(provider.provider, "codex");
  assert.equal(provider.status, "ok");
  assert.equal(provider.stale, false);
  assert.equal(provider.updatedAt, FIXED_NOW - 30_000);
  assert.equal(provider.accountLabel, "Plus");
  assert.deepEqual(provider.windows, EXPECTED_WINDOWS);
});

test("session and weekly resetsAt values are normalized to ISO instants", () => {
  const { windows } = buildStatsPayload(freshStatsInput()).limits.providers[0];
  assert.deepEqual(windows.map(({ kind }) => kind), ["session", "weekly"]);
  for (const window of windows) {
    assert.equal(new Date(window.resetsAt).toISOString(), window.resetsAt);
  }
});

test("used percentages remain compatible with the APK used-to-remaining fallback", () => {
  const { windows } = buildStatsPayload(freshStatsInput()).limits.providers[0];
  assert.deepEqual(
    windows.map(({ usedPercent }) => 100 - usedPercent),
    [82, 63],
  );
});

test("stale and incomplete snapshots are not served as current stats", () => {
  assert.equal(
    buildStatsPayload(freshStatsInput({ updatedAt: FIXED_NOW - 300_001 })),
    null,
  );
  assert.equal(
    buildStatsPayload(freshStatsInput({ rateLimits: { rateLimitsByLimitId: {} } })),
    null,
  );
});

test("mapRateLimitsToStats remains an alias for buildStatsPayload", () => {
  assert.deepEqual(
    mapRateLimitsToStats(freshStatsInput()),
    buildStatsPayload(freshStatsInput()),
  );
});

test("a primary-only short window maps to session", () => {
  const payload = buildStatsPayload(freshStatsInput({
    rateLimits: {
      primary: {
        usedPercent: 21,
        windowDurationMins: 300,
        resetsAt: 1_788_000_000,
      },
    },
  }));

  assert.deepEqual(
    payload.limits.providers[0].windows.map(({ kind, usedPercent }) => ({
      kind,
      usedPercent,
    })),
    [{ kind: "session", usedPercent: 21 }],
  );
});

test("a secondary-only long window maps to weekly", () => {
  const payload = buildStatsPayload(freshStatsInput({
    rateLimits: {
      secondary: {
        usedPercent: 42,
        windowDurationMins: 10_080,
        resetsAt: 1_788_600_000,
      },
    },
  }));

  assert.deepEqual(
    payload.limits.providers[0].windows.map(({ kind, usedPercent }) => ({
      kind,
      usedPercent,
    })),
    [{ kind: "weekly", usedPercent: 42 }],
  );
});

test("two windows are classified by duration rather than primary/secondary labels", () => {
  const payload = buildStatsPayload(freshStatsInput({
    rateLimits: {
      primary: {
        usedPercent: 71,
        windowDurationMins: 10_080,
        resetsAt: 1_788_600_000,
      },
      secondary: {
        usedPercent: 9,
        windowDurationMins: 300,
        resetsAt: 1_788_000_000,
      },
    },
  }));

  assert.deepEqual(
    payload.limits.providers[0].windows.map(({ kind, usedPercent }) => ({
      kind,
      usedPercent,
    })),
    [
      { kind: "session", usedPercent: 9 },
      { kind: "weekly", usedPercent: 71 },
    ],
  );
});

test("an upstream reached-limit marker maps to APK-compatible rateLimited", () => {
  const payload = buildStatsPayload(freshStatsInput({
    rateLimits: {
      rateLimitReachedType: "primary",
      primary: {
        usedPercent: 100,
        windowDurationMins: 300,
        resetsAt: 1_788_000_000,
      },
    },
  }));

  assert.equal(payload.limits.providers[0].status, "rateLimited");
});

test("null or empty usage is rejected instead of being misreported as zero", () => {
  for (const usedPercent of [null, undefined, "", "   ", false]) {
    const payload = buildStatsPayload(freshStatsInput({
      rateLimits: {
        primary: {
          usedPercent,
          windowDurationMins: 300,
          resetsAt: 1_788_000_000,
        },
      },
    }));
    assert.equal(payload, null);
  }
});

test("a secondary-only window without duration keeps its weekly meaning", () => {
  const payload = buildStatsPayload(freshStatsInput({
    rateLimits: {
      secondary: {
        usedPercent: 42,
        resetsAt: null,
      },
    },
  }));

  assert.deepEqual(payload.limits.providers[0].windows, [
    { kind: "weekly", usedPercent: 42 },
  ]);
});

test("QuotaService polls app-server, caches fresh stats, and expires them", async () => {
  let now = FIXED_NOW;
  class FakeClient extends EventEmitter {
    ready = false;

    async start() {
      this.ready = true;
    }

    async request(method) {
      if (method === "account/read") return ACCOUNT_RESPONSE;
      if (method === "account/rateLimits/read") return RATE_LIMITS_RESPONSE;
      throw new Error(`unexpected method: ${method}`);
    }

    async stop() {
      this.ready = false;
    }
  }

  const service = new QuotaService({
    client: new FakeClient(),
    now: () => now,
    staleAfterMs: 300_000,
  });
  try {
    assert.ok(await service.pollNow());
    assert.ok(service.getStats());
    now += 300_001;
    assert.equal(service.getStats(), null);
  } finally {
    await service.stop();
  }
});

test("QuotaService keeps a fresh cache on failure without exposing upstream error text", async () => {
  let now = FIXED_NOW;
  let fail = false;
  class FlakyClient extends EventEmitter {
    ready = false;

    async start() {
      this.ready = true;
    }

    async request(method) {
      if (fail) {
        const error = new Error("upstream leaked Bearer sensitive-token");
        error.name = "CodexAppServerError";
        error.code = 401;
        throw error;
      }
      if (method === "account/read") return ACCOUNT_RESPONSE;
      return RATE_LIMITS_RESPONSE;
    }

    async stop() {
      this.ready = false;
    }
  }

  const service = new QuotaService({
    client: new FlakyClient(),
    now: () => now,
    staleAfterMs: 300_000,
  });
  try {
    assert.ok(await service.pollNow());
    fail = true;
    now += 1_000;
    assert.equal(await service.pollNow(), null);
    assert.ok(service.getStats());
    assert.doesNotMatch(service.getHealth().error, /sensitive-token|Bearer/i);
  } finally {
    await service.stop();
  }
});
