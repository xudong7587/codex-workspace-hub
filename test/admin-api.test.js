import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { MAX_BODY_BYTES, createAdminApi } from "../src/admin-api.js";

const ADMIN_TOKEN = "admin-api-token-0123456789abcdef0123456789abcdef";

function request({ method = "GET", token, body, headers = {}, url, remoteAddress } = {}) {
  const encoded = body === undefined
    ? null
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const stream = Readable.from(encoded ? [encoded] : []);
  stream.method = method;
  stream.socket = { remoteAddress: remoteAddress || "127.0.0.1" };
  if (url) stream.url = url;
  stream.headers = { ...headers };
  if (token !== undefined) stream.headers.authorization = `Bearer ${token}`;
  if (encoded && stream.headers["content-type"] === undefined) {
    stream.headers["content-type"] = "application/json";
  }
  if (encoded && stream.headers["content-length"] === undefined) {
    stream.headers["content-length"] = String(encoded.length);
  }
  return stream;
}

function createManager(overrides = {}) {
  const calls = [];
  const loginManager = {
    state: { status: "idle" },
    async begin(options = {}) {
      calls.push(["login:begin", structuredClone(options)]);
      this.state = {
        id: options.sessionId || "login-1",
        status: "waiting",
        verificationUrl: "https://auth.example/device",
        userCode: "ABCD-EFGH",
      };
      return structuredClone(this.state);
    },
    getState() {
      return structuredClone(this.state);
    },
    async cancel() {
      calls.push(["login:cancel"]);
      this.state = { ...this.state, status: "cancelled" };
    },
  };
  const manager = {
    calls,
    loginManager,
    getAdminState() {
      return { productName: "VWatch Quota Hub", settings: {} };
    },
    async updateSettings(body) {
      calls.push(["settings", structuredClone(body)]);
      return { settings: structuredClone(body) };
    },
    async updateProvider(providerId, body) {
      calls.push(["provider", providerId, structuredClone(body)]);
      return { providerId };
    },
    getProvider(providerId) {
      return providerId === "codex"
        ? { id: "codex", loginManager }
        : providerId === "openrouter" ? { id: "openrouter" } : null;
    },
    async pollNow(providerId, options) {
      calls.push(["poll", providerId, options]);
    },
    invalidateProvider(providerId) {
      calls.push(["invalidate", providerId]);
    },
    ...overrides,
  };
  return manager;
}

test("admin API requires the dedicated Bearer token", async () => {
  const handle = createAdminApi({
    providerManager: createManager(),
    adminToken: ADMIN_TOKEN,
  });

  const missing = await handle(request(), "/admin/api/state");
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.payload.error, "admin_authentication_required");
  assert.equal(missing.headers["WWW-Authenticate"], "Bearer");

  const wrong = await handle(
    request({ token: `${ADMIN_TOKEN}-wrong` }),
    "/admin/api/state",
  );
  assert.equal(wrong.statusCode, 401);

  const accepted = await handle(
    request({ token: ADMIN_TOKEN }),
    "/admin/api/state",
  );
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.payload.productName, "VWatch Quota Hub");
});

test("panel setup creates a session and manages the generated bridge secret", async () => {
  let setupRequired = true;
  let password = "";
  let bridgeSecret = "a".repeat(64);
  const credentialStore = {
    getStatus: () => ({ setupRequired }),
    async completeSetup(nextPassword) {
      if (!setupRequired) {
        const error = new Error("初始化已经完成");
        error.code = "SETUP_COMPLETE";
        throw error;
      }
      password = nextPassword;
      setupRequired = false;
    },
    authenticateAdmin: async (candidate) => candidate === password,
    getBridgeSecret: () => bridgeSecret,
    async rotateBridgeSecret() {
      bridgeSecret = "b".repeat(64);
      return bridgeSecret;
    },
  };
  const handle = createAdminApi({ providerManager: createManager(), credentialStore });

  const status = await handle(request(), "/admin/api/setup");
  assert.deepEqual(status.payload, { setupRequired: true });

  const publicClaim = await handle(request({
    method: "POST",
    body: { adminPassword: "a long management password" },
    remoteAddress: "203.0.113.8",
  }), "/admin/api/setup");
  assert.equal(publicClaim.statusCode, 403);

  const forwardedClaim = await handle(request({
    method: "POST",
    body: { adminPassword: "a long management password" },
    headers: { "x-forwarded-for": "192.168.1.20" },
  }), "/admin/api/setup");
  assert.equal(forwardedClaim.statusCode, 403);

  const setup = await handle(request({
    method: "POST",
    body: { adminPassword: "a long management password" },
    remoteAddress: "192.168.1.20",
  }), "/admin/api/setup");
  assert.equal(setup.statusCode, 201);
  assert.match(setup.payload.sessionToken, /^[a-f0-9]{64}$/);

  const state = await handle(
    request({ token: setup.payload.sessionToken }),
    "/admin/api/state",
  );
  assert.equal(state.statusCode, 200);
  assert.equal(state.payload.bridge.secret, "a".repeat(64));

  const rotated = await handle(
    request({ method: "POST", token: setup.payload.sessionToken }),
    "/admin/api/bridge/rotate",
  );
  assert.equal(rotated.statusCode, 200);
  assert.equal(rotated.payload.bridge.secret, "b".repeat(64));

  const login = await handle(request({
    method: "POST",
    body: { adminPassword: "a long management password" },
  }), "/admin/api/session");
  assert.equal(login.statusCode, 200);
  assert.match(login.payload.sessionToken, /^[a-f0-9]{64}$/);

  const passwordIsNotASession = await handle(
    request({ token: "a long management password" }),
    "/admin/api/state",
  );
  assert.equal(passwordIsNotASession.statusCode, 401);
});

test("settings updates accept JSON but reject bodies larger than 32 KiB", async () => {
  const manager = createManager();
  const handle = createAdminApi({ providerManager: manager, adminToken: ADMIN_TOKEN });
  const update = { pollIntervalSeconds: 300, staleAfterSeconds: 900 };

  const accepted = await handle(
    request({ method: "PUT", token: ADMIN_TOKEN, body: update }),
    "/admin/api/settings",
  );
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(manager.calls[0], ["settings", update]);

  const oversized = await handle(request({
    method: "PUT",
    token: ADMIN_TOKEN,
    headers: {
      "content-type": "application/json",
      "content-length": String(MAX_BODY_BYTES + 1),
    },
  }), "/admin/api/settings");
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.payload.error, "body_too_large");

  const chunkedOversized = await handle(request({
    method: "PUT",
    token: ADMIN_TOKEN,
    body: { padding: "x".repeat(MAX_BODY_BYTES) },
    headers: { "content-length": null },
  }), "/admin/api/settings");
  assert.equal(chunkedOversized.statusCode, 413);
  assert.equal(chunkedOversized.payload.error, "body_too_large");
  assert.equal(manager.calls.length, 1);
});

test("manual refresh cooldown is exposed as 429 with Retry-After", async () => {
  const cooldown = new Error("cooldown");
  cooldown.code = "REFRESH_COOLDOWN";
  cooldown.retryAfterSeconds = 41;
  const manager = createManager({
    async pollNow() {
      throw cooldown;
    },
  });
  const handle = createAdminApi({ providerManager: manager, adminToken: ADMIN_TOKEN });

  const response = await handle(
    request({ method: "POST", token: ADMIN_TOKEN }),
    "/admin/api/providers/codex/refresh",
  );
  assert.equal(response.statusCode, 429);
  assert.equal(response.payload.error, "refresh_cooldown");
  assert.equal(response.payload.message, "请等待 41 秒后再手动刷新");
  assert.equal(response.headers["Retry-After"], "41");
});

test("global refresh runs the manager once for all enabled providers", async () => {
  const manager = createManager();
  const handle = createAdminApi({ providerManager: manager, adminToken: ADMIN_TOKEN });

  const response = await handle(
    request({ method: "POST", token: ADMIN_TOKEN }),
    "/admin/api/refresh",
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    manager.calls.find(([kind]) => kind === "poll"),
    ["poll", null, { manual: true }],
  );
});

test("Codex login route starts device flow and refreshes once after completion", async () => {
  const manager = createManager();
  const handle = createAdminApi({ providerManager: manager, adminToken: ADMIN_TOKEN });

  const started = await handle(
    request({ method: "POST", token: ADMIN_TOKEN }),
    "/admin/api/providers/codex/login",
  );
  assert.equal(started.statusCode, 202);
  assert.equal(started.payload.status, "waiting");
  assert.equal(started.payload.userCode, "ABCD-EFGH");

  manager.loginManager.state = { id: "login-1", status: "complete" };
  const first = await handle(
    request({ token: ADMIN_TOKEN }),
    "/admin/api/providers/codex/login",
  );
  const second = await handle(
    request({ token: ADMIN_TOKEN }),
    "/admin/api/providers/codex/login",
  );
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(
    manager.calls.filter(([kind]) => kind === "poll").length,
    1,
  );
  assert.deepEqual(
    manager.calls.find(([kind]) => kind === "poll"),
    ["poll", "codex", undefined],
  );
  assert.deepEqual(
    manager.calls.find(([kind]) => kind === "invalidate"),
    ["invalidate", "codex"],
  );
});

test("Codex login route explicitly cancels a temporary app-server", async () => {
  const manager = createManager();
  const handle = createAdminApi({ providerManager: manager, adminToken: ADMIN_TOKEN });
  await handle(
    request({ method: "POST", token: ADMIN_TOKEN }),
    "/admin/api/providers/codex/login",
  );

  const cancelled = await handle(
    request({ method: "DELETE", token: ADMIN_TOKEN }),
    "/admin/api/providers/codex/login",
  );
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.payload.status, "cancelled");
  assert.equal(
    manager.calls.filter(([kind]) => kind === "login:cancel").length,
    1,
  );
});

test("a delayed delete cannot cancel a newer Codex login session", async () => {
  const manager = createManager();
  const handle = createAdminApi({ providerManager: manager, adminToken: ADMIN_TOKEN });
  const sessionId = "browser-session-123";
  const started = await handle(
    request({
      method: "POST",
      token: ADMIN_TOKEN,
      headers: { "x-vwatch-login-id": sessionId },
    }),
    "/admin/api/providers/codex/login",
  );
  assert.equal(started.payload.id, sessionId);

  const staleDelete = await handle(
    request({
      method: "DELETE",
      token: ADMIN_TOKEN,
      url: "/admin/api/providers/codex/login?id=older-session-456",
    }),
    "/admin/api/providers/codex/login",
  );
  assert.equal(staleDelete.statusCode, 409);
  assert.equal(manager.loginManager.getState().status, "waiting");
  assert.equal(manager.calls.filter(([kind]) => kind === "login:cancel").length, 0);

  const matchingDelete = await handle(
    request({
      method: "DELETE",
      token: ADMIN_TOKEN,
      url: `/admin/api/providers/codex/login?id=${sessionId}`,
    }),
    "/admin/api/providers/codex/login",
  );
  assert.equal(matchingDelete.statusCode, 200);
  assert.equal(matchingDelete.payload.status, "cancelled");
});
