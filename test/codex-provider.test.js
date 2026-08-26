import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  CodexLoginManager,
  collectCodexQuota,
  createCodexProvider,
} from "../src/providers/codex.js";
import {
  ACCOUNT_RESPONSE,
  EXPECTED_WINDOWS,
  FIXED_NOW,
  RATE_LIMITS_RESPONSE,
} from "./fixtures/codex-rate-limits.js";

test("Codex collection maps app-server quotas and always stops its short-lived client", async () => {
  const calls = [];
  const client = {
    async start() {
      calls.push("start");
    },
    async request(method) {
      calls.push(method);
      if (method === "account/read") return ACCOUNT_RESPONSE;
      if (method === "account/rateLimits/read") return RATE_LIMITS_RESPONSE;
      throw new Error(`unexpected method: ${method}`);
    },
    async stop() {
      calls.push("stop");
    },
  };

  const snapshot = await collectCodexQuota({
    clientFactory: () => client,
    now: () => FIXED_NOW,
  });

  assert.equal(calls[0], "start");
  assert.deepEqual(new Set(calls.slice(1, 3)), new Set([
    "account/read",
    "account/rateLimits/read",
  ]));
  assert.equal(calls.at(-1), "stop");
  assert.equal(calls.filter((call) => call === "stop").length, 1);
  assert.deepEqual(snapshot.bridgePayload, {
    provider: "codex",
    status: "ok",
    stale: false,
    updatedAt: FIXED_NOW,
    accountLabel: "Plus",
    windows: EXPECTED_WINDOWS,
  });
  assert.deepEqual(snapshot.metrics.map((metric) => ({
    window: metric.window,
    usedPercent: metric.usedPercent,
    remaining: metric.remaining,
    resetsAt: metric.resetsAt,
  })), [
    {
      window: "session",
      usedPercent: 18,
      remaining: 82,
      resetsAt: "2026-08-26T13:00:00.000Z",
    },
    {
      window: "weekly",
      usedPercent: 37,
      remaining: 63,
      resetsAt: "2026-09-01T00:00:00.000Z",
    },
  ]);
});

test("Codex collection stops its client when an app-server request fails", async () => {
  let stopped = 0;
  const client = {
    async start() {},
    async request(method) {
      if (method === "account/read") throw new Error("request failed");
      return RATE_LIMITS_RESPONSE;
    },
    async stop() {
      stopped += 1;
    },
  };

  await assert.rejects(
    collectCodexQuota({ clientFactory: () => client }),
    /request failed/,
  );
  assert.equal(stopped, 1);
});

test("Codex login accepts a completion notification emitted before the challenge response", async () => {
  class EarlyNotificationClient extends EventEmitter {
    async start() {
      this.started = true;
    }

    async request(method, params) {
      assert.equal(method, "account/login/start");
      assert.deepEqual(params, { type: "chatgptDeviceCode" });
      this.emit("account/login/completed", {
        loginId: "early-login",
        success: true,
      });
      return {
        type: "chatgptDeviceCode",
        loginId: "early-login",
        verificationUrl: "https://auth.example/device",
        userCode: "EARLY-1234",
      };
    }

    async stop() {
      this.stopped = (this.stopped || 0) + 1;
    }
  }

  const client = new EarlyNotificationClient();
  const manager = new CodexLoginManager({
    clientFactory: () => client,
    timeoutMs: 1_000,
  });

  const challenge = await manager.begin();
  assert.equal(challenge.status, "waiting");
  assert.equal(challenge.userCode, "EARLY-1234");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getState().status, "complete");
  assert.equal(client.stopped, 1);
  await manager.cancel();
});

test("concurrent Codex login requests share one app-server and cancellation stops it", async () => {
  const clients = [];
  class WaitingLoginClient extends EventEmitter {
    async start() {
      this.started = true;
    }

    async request(method) {
      assert.equal(method, "account/login/start");
      return {
        type: "chatgptDeviceCode",
        loginId: "shared-login",
        verificationUrl: "https://auth.example/device",
        userCode: "SHARED-1",
      };
    }

    async stop() {
      this.stopped = true;
    }
  }

  const manager = new CodexLoginManager({
    clientFactory: () => {
      const client = new WaitingLoginClient();
      clients.push(client);
      return client;
    },
    timeoutMs: 1_000,
  });

  const [first, second] = await Promise.all([
    manager.begin({ sessionId: "client-session-123" }),
    manager.begin({ sessionId: "client-session-123" }),
  ]);
  assert.equal(clients.length, 1);
  assert.equal(first.id, second.id);
  assert.equal(first.id, "client-session-123");
  assert.equal(first.status, "waiting");
  await manager.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(clients.every((client) => client.stopped));
  assert.equal(manager.getState().status, "cancelled");
});

test("Codex collection and device login never overlap app-server clients", async () => {
  let releaseCollection;
  const collectionGate = new Promise((resolve) => {
    releaseCollection = resolve;
  });
  let factoryCalls = 0;
  let activeClients = 0;
  let maxActiveClients = 0;

  class CoordinatedClient extends EventEmitter {
    constructor(kind) {
      super();
      this.kind = kind;
      this.stopped = false;
    }

    async start() {
      activeClients += 1;
      maxActiveClients = Math.max(maxActiveClients, activeClients);
    }

    async request(method) {
      if (this.kind === "collect") {
        if (method === "account/read") {
          await collectionGate;
          return ACCOUNT_RESPONSE;
        }
        if (method === "account/rateLimits/read") return RATE_LIMITS_RESPONSE;
      }
      if (method === "account/login/start") {
        return {
          type: "chatgptDeviceCode",
          loginId: "after-collect",
          verificationUrl: "https://auth.example/device",
          userCode: "AFTER-1",
        };
      }
      throw new Error(`unexpected method: ${method}`);
    }

    async stop() {
      if (this.stopped) return;
      this.stopped = true;
      activeClients -= 1;
    }
  }

  const provider = createCodexProvider({
    clientFactory: () => {
      factoryCalls += 1;
      return new CoordinatedClient(factoryCalls === 1 ? "collect" : "login");
    },
    timeoutMs: 1_000,
    now: () => FIXED_NOW,
  });

  const collection = provider.collect();
  await new Promise((resolve) => setImmediate(resolve));
  const login = provider.loginManager.begin();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(factoryCalls, 1);
  releaseCollection();
  await collection;
  const challenge = await login;
  assert.equal(challenge.status, "waiting");
  assert.equal(factoryCalls, 2);
  assert.equal(maxActiveClients, 1);
  await provider.loginManager.cancel();
});

test("Codex login is not published complete until its app-server has stopped", async () => {
  let releaseStop;
  const stopGate = new Promise((resolve) => {
    releaseStop = resolve;
  });
  class SlowStopClient extends EventEmitter {
    async start() {}

    async request() {
      return {
        type: "chatgptDeviceCode",
        loginId: "slow-stop",
        verificationUrl: "https://auth.example/device",
        userCode: "SLOW-1",
      };
    }

    async stop() {
      await stopGate;
    }
  }

  const client = new SlowStopClient();
  const manager = new CodexLoginManager({
    clientFactory: () => client,
    timeoutMs: 1_000,
  });
  assert.equal((await manager.begin()).status, "waiting");
  client.emit("account/login/completed", { loginId: "slow-stop", success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getState().status, "finishing");
  releaseStop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getState().status, "complete");
});

test("cancelling while Codex starts does not retain the stopped client", async () => {
  let announceStart;
  const startObserved = new Promise((resolve) => {
    announceStart = resolve;
  });
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const client = new EventEmitter();
  client.start = async () => {
    announceStart();
    await startGate;
  };
  client.request = async () => {
    throw new Error("request must not run after cancellation");
  };
  client.stop = async () => {
    client.stopped = true;
  };

  const manager = new CodexLoginManager({
    clientFactory: () => client,
    timeoutMs: 1_000,
  });
  const begin = manager.begin();
  await startObserved;
  const cancellation = manager.cancel();
  releaseStart();
  await Promise.all([begin, cancellation]);
  assert.equal(manager.getState().status, "cancelled");
  assert.equal(client.stopped, true);
  assert.equal(Object.hasOwn(manager.session, "client"), false);
  assert.equal(Object.hasOwn(manager.session, "waiter"), false);
});
