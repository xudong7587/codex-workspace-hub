import assert from "node:assert/strict";
import test from "node:test";

import { ProviderManager } from "../src/provider-manager.js";

function clone(value) {
  return structuredClone(value);
}

class FakeSettingsStore {
  constructor(value) {
    this.value = clone(value);
  }

  async load() {
    return clone(this.value);
  }

  async update(value) {
    this.value = clone(value);
    return clone(this.value);
  }
}

function settings(overrides = {}) {
  return {
    schemaVersion: 1,
    pollIntervalSeconds: 300,
    staleAfterSeconds: 900,
    providers: {
      codex: { enabled: true },
      openrouter: { enabled: true, apiKey: "test-key", mode: "key" },
    },
    ...overrides,
  };
}

function codexSnapshot(updatedAt) {
  const bridgePayload = {
    provider: "codex",
    status: "ok",
    stale: false,
    updatedAt,
    accountLabel: "Plus",
    windows: [
      { kind: "session", usedPercent: 18, resetsAt: "2026-08-26T13:00:00.000Z" },
      { kind: "weekly", usedPercent: 37, resetsAt: "2026-09-01T00:00:00.000Z" },
    ],
  };
  return {
    id: "codex",
    displayName: "Codex",
    status: "ok",
    updatedAt,
    accountLabel: "Plus",
    bridgePayload,
    metrics: [],
  };
}

function openRouterSnapshot(updatedAt) {
  return {
    id: "openrouter",
    displayName: "OpenRouter",
    status: "ok",
    updatedAt,
    accountLabel: "API key",
    metrics: [{ metricType: "spend_limit", usedPercent: 25 }],
  };
}

test("ProviderManager collects providers sequentially and schedules the next poll in five minutes", async () => {
  const order = [];
  const scheduled = [];
  const manager = new ProviderManager({
    settingsStore: new FakeSettingsStore(settings()),
    providers: [
      {
        id: "codex",
        displayName: "Codex",
        bridgeCompatible: true,
        collect: async () => {
          order.push("codex:start");
          await Promise.resolve();
          order.push("codex:end");
          return codexSnapshot(1_000_000);
        },
      },
      {
        id: "openrouter",
        displayName: "OpenRouter",
        bridgeCompatible: false,
        isConfigured: (config) => Boolean(config.apiKey),
        collect: async () => {
          order.push("openrouter:start");
          await Promise.resolve();
          order.push("openrouter:end");
          return openRouterSnapshot(1_000_000);
        },
      },
    ],
    setTimeout: (callback, delayMs) => {
      const timer = { callback, delayMs, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout: () => {},
  });

  await manager.start();
  assert.deepEqual(order, [
    "codex:start",
    "codex:end",
    "openrouter:start",
    "openrouter:end",
  ]);
  assert.equal(scheduled.at(-1).delayMs, 300_000);
  await manager.stop();
});

test("fresh bridge stats contain Codex only and never export dashboard-only OpenRouter", async () => {
  const updatedAt = 2_000_000;
  const manager = new ProviderManager({
    settingsStore: new FakeSettingsStore(settings()),
    providers: [
      {
        id: "codex",
        displayName: "Codex",
        bridgeCompatible: true,
        collect: async () => codexSnapshot(updatedAt),
      },
      {
        id: "openrouter",
        displayName: "OpenRouter",
        bridgeCompatible: false,
        collect: async () => openRouterSnapshot(updatedAt),
      },
    ],
    now: () => updatedAt,
  });

  await manager.pollNow();
  assert.deepEqual(manager.getStats(updatedAt), {
    limits: { providers: [codexSnapshot(updatedAt).bridgePayload] },
  });
  assert.equal(
    manager.getStats(updatedAt).limits.providers.some(({ provider }) => provider === "openrouter"),
    false,
  );
  manager.invalidateProvider("codex");
  assert.equal(manager.getStats(updatedAt), null);
  await manager.stop();
});

test("bridge stats expire after the configured stale window", async () => {
  const updatedAt = 3_000_000;
  const manager = new ProviderManager({
    settingsStore: new FakeSettingsStore(settings({
      staleAfterSeconds: 900,
      providers: {
        codex: { enabled: true },
        openrouter: { enabled: false, apiKey: "", mode: "key" },
      },
    })),
    providers: [{
      id: "codex",
      displayName: "Codex",
      bridgeCompatible: true,
      collect: async () => codexSnapshot(updatedAt),
    }],
    now: () => updatedAt,
  });

  await manager.pollNow();
  assert.ok(manager.getStats(updatedAt + 900_000));
  assert.equal(manager.getStats(updatedAt + 900_001), null);
  assert.equal(manager.getHealth(updatedAt + 900_001).fresh, false);
  await manager.stop();
});

test("different targeted refreshes queue instead of receiving the wrong result", async () => {
  let releaseOpenRouter;
  const gate = new Promise((resolve) => {
    releaseOpenRouter = resolve;
  });
  const calls = [];
  const manager = new ProviderManager({
    settingsStore: new FakeSettingsStore(settings()),
    providers: [
      {
        id: "codex",
        displayName: "Codex",
        bridgeCompatible: true,
        collect: async () => {
          calls.push("codex");
          return codexSnapshot(4_000_000);
        },
      },
      {
        id: "openrouter",
        displayName: "OpenRouter",
        bridgeCompatible: false,
        collect: async () => {
          calls.push("openrouter");
          await gate;
          return openRouterSnapshot(4_000_000);
        },
      },
    ],
  });

  const openRouterRefresh = manager.pollNow("openrouter");
  await new Promise((resolve) => setImmediate(resolve));
  const codexRefresh = manager.pollNow("codex");
  assert.deepEqual(calls, ["openrouter"]);
  releaseOpenRouter();
  assert.deepEqual(await openRouterRefresh, {
    openrouter: openRouterSnapshot(4_000_000),
  });
  assert.deepEqual(await codexRefresh, {
    codex: codexSnapshot(4_000_000),
  });
  assert.deepEqual(calls, ["openrouter", "codex"]);
  await manager.stop();
});

test("a full refresh requested behind a targeted refresh still visits every provider", async () => {
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const calls = [];
  let openRouterCalls = 0;
  const manager = new ProviderManager({
    settingsStore: new FakeSettingsStore(settings()),
    providers: [
      {
        id: "codex",
        displayName: "Codex",
        bridgeCompatible: true,
        collect: async () => {
          calls.push("codex");
          return codexSnapshot(5_000_000);
        },
      },
      {
        id: "openrouter",
        displayName: "OpenRouter",
        bridgeCompatible: false,
        collect: async () => {
          calls.push("openrouter");
          openRouterCalls += 1;
          if (openRouterCalls === 1) await gate;
          return openRouterSnapshot(5_000_000);
        },
      },
    ],
  });

  const targeted = manager.pollNow("openrouter");
  await new Promise((resolve) => setImmediate(resolve));
  const full = manager.pollNow();
  releaseFirst();
  await targeted;
  const fullResult = await full;
  assert.deepEqual(Object.keys(fullResult), ["codex", "openrouter"]);
  assert.deepEqual(calls, ["openrouter", "codex", "openrouter"]);
  await manager.stop();
});

test("provider changes invalidate old snapshots and concurrent settings changes are preserved", async () => {
  const store = new FakeSettingsStore(settings());
  const manager = new ProviderManager({
    settingsStore: store,
    providers: [
      {
        id: "codex",
        displayName: "Codex",
        bridgeCompatible: true,
        collect: async () => codexSnapshot(6_000_000),
      },
      {
        id: "openrouter",
        displayName: "OpenRouter",
        bridgeCompatible: false,
        isConfigured: (config) => Boolean(config.apiKey),
        collect: async () => openRouterSnapshot(6_000_000),
      },
    ],
  });

  await manager.pollNow();
  assert.equal(
    manager.getAdminState(6_000_000).providers.find(({ id }) => id === "openrouter").metrics.length,
    1,
  );
  await Promise.all([
    manager.updateSettings({ pollIntervalSeconds: 600, staleAfterSeconds: 1_800 }),
    manager.updateProvider("openrouter", { apiKey: "replacement-key", mode: "credits" }),
  ]);
  const finalSettings = manager.getSettings();
  assert.equal(finalSettings.pollIntervalSeconds, 600);
  assert.equal(finalSettings.staleAfterSeconds, 1_800);
  assert.equal(finalSettings.providers.openrouter.apiKey, "replacement-key");
  assert.equal(finalSettings.providers.openrouter.mode, "credits");
  const openRouter = manager.getAdminState(6_000_000).providers.find(({ id }) => id === "openrouter");
  assert.equal(openRouter.metrics.length, 0);
  assert.equal(openRouter.updatedAt, null);
  await manager.stop();
});

test("stop aborts an in-flight provider collection before waiting for it", async () => {
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  let observedAbort = false;
  let collectCalls = 0;
  const manager = new ProviderManager({
    settingsStore: new FakeSettingsStore(settings({
      providers: {
        codex: { enabled: true },
        openrouter: { enabled: false, apiKey: "", mode: "key" },
      },
    })),
    providers: [{
      id: "codex",
      displayName: "Codex",
      bridgeCompatible: true,
      collect: async (_config, { signal }) => new Promise((resolve, reject) => {
        collectCalls += 1;
        started();
        signal.addEventListener("abort", () => {
          observedAbort = true;
          const error = new Error("cancelled");
          error.code = "CANCELLED";
          reject(error);
        }, { once: true });
      }),
    }],
  });

  const refresh = manager.pollNow();
  await startedPromise;
  const queuedRefresh = manager.pollNow("codex");
  await manager.stop();
  await refresh;
  assert.deepEqual(await queuedRefresh, {});
  assert.equal(observedAbort, true);
  assert.equal(collectCalls, 1);
});

test("aborting an old refresh after a provider change does not publish a false failure", async () => {
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const manager = new ProviderManager({
    settingsStore: new FakeSettingsStore(settings({
      providers: {
        codex: { enabled: true },
        openrouter: { enabled: false, apiKey: "", mode: "key" },
      },
    })),
    providers: [{
      id: "codex",
      displayName: "Codex",
      bridgeCompatible: true,
      collect: async (_config, { signal }) => new Promise((resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(new Error("client stopped")), { once: true });
      }),
    }],
  });

  const oldRefresh = manager.pollNow("codex");
  await startedPromise;
  await manager.updateProvider("codex", { enabled: false });
  await oldRefresh;
  const state = manager.getAdminState();
  const codex = state.providers.find(({ id }) => id === "codex");
  assert.equal(codex.status, "disabled");
  assert.equal(codex.error, null);
  assert.equal(state.providers[0].updatedAt, null);
  assert.equal(manager.getHealth().consecutiveFailures, 0);
  await manager.stop();
});
