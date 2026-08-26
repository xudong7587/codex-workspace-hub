import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CodexAppServerClient } from "../src/codex-app-server.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/fake-app-server.js", import.meta.url),
);

test("CodexAppServerClient completes initialize, requests, notifications, and stop", async () => {
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [FIXTURE_PATH],
    env: {
      ...process.env,
      CLAWD_TEST_FAKE_APP_SERVER: "1",
    },
    requestTimeoutMs: 2_000,
    startTimeoutMs: 2_000,
    stopTimeoutMs: 1_000,
  });

  try {
    const initialized = await client.start();
    assert.equal(initialized.protocolVersion, 1);
    assert.equal(client.ready, true);

    const account = await client.request("account/read", { refreshToken: false });
    assert.deepEqual(account, {
      account: { type: "chatgpt", planType: "plus" },
    });

    const rateLimits = await client.request("account/rateLimits/read");
    assert.equal(
      rateLimits.rateLimitsByLimitId.codex.primary.windowDurationMins,
      300,
    );
    assert.equal(
      rateLimits.rateLimitsByLimitId.codex.secondary.windowDurationMins,
      10_080,
    );

    const order = await client.request("fixture/order");
    assert.deepEqual(order.slice(0, 2), ["initialize", "initialized"]);
    assert.deepEqual(order.slice(2, 4), [
      "account/read",
      "account/rateLimits/read",
    ]);

    const notification = client.waitForNotification(
      "account/rateLimits/updated",
      {
        timeoutMs: 2_000,
        predicate: (params) => params?.source === "fake-app-server",
      },
    );
    assert.deepEqual(await client.request("fixture/emit"), { accepted: true });
    assert.deepEqual(await notification, {
      source: "fake-app-server",
      sequence: 1,
    });

    await client.stop();
    assert.equal(client.state, "stopped");
    assert.equal(client.child, null);
  } finally {
    await client.stop();
  }
});

test("start rejects cleanly when the child exits before initialization", async () => {
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [FIXTURE_PATH],
    env: {
      ...process.env,
      CLAWD_TEST_FAKE_APP_SERVER: "1",
      CLAWD_TEST_FAKE_APP_SERVER_EXIT_EARLY: "1",
    },
    requestTimeoutMs: 1_000,
    startTimeoutMs: 1_000,
    stopTimeoutMs: 200,
  });

  try {
    await assert.rejects(
      client.start(),
      /exited|not running|stdin|EPIPE/i,
    );
    assert.equal(client.state, "stopped");
  } finally {
    await client.stop();
  }
});

test("start rejects cleanly when the app-server command does not exist", async () => {
  const impossibleCommand = process.platform === "win32"
    ? "Z:\\definitely-missing\\codex-app-server.exe"
    : "/definitely-missing/codex-app-server";
  const client = new CodexAppServerClient({
    command: impossibleCommand,
    args: [],
    requestTimeoutMs: 1_000,
    startTimeoutMs: 1_000,
    stopTimeoutMs: 200,
  });

  try {
    await assert.rejects(
      client.start(),
      /failed to start|ENOENT|exited|not running/i,
    );
    assert.equal(client.state, "stopped");
  } finally {
    await client.stop();
  }
});
