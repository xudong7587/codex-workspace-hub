import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createCodexChildEnv, runLogin } from "../src/cli.js";

const NULL_LOGGER = Object.freeze({
  error() {},
  warn() {},
  info() {},
  debug() {},
});

test("Codex child environment never inherits the Token Monitor secret", () => {
  const childEnv = createCodexChildEnv(
    { codexHome: "/isolated/codex-home" },
    {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.invalid",
      TOKEN_MONITOR_SECRET: "must-not-leak",
      token_monitor_secret: "case-insensitive-must-not-leak",
    },
    { TOKEN_MONITOR_SECRET: "extra-env-must-not-leak" },
  );

  assert.equal(childEnv.PATH, "/usr/bin");
  assert.equal(childEnv.HTTPS_PROXY, "http://proxy.invalid");
  assert.equal(childEnv.CODEX_HOME, "/isolated/codex-home");
  assert.equal(
    Object.keys(childEnv).some((key) => key.toLowerCase() === "token_monitor_secret"),
    false,
  );
});

test("device-code login captures a completion notification sent before its response", async () => {
  class ImmediateLoginClient extends EventEmitter {
    async start() {}

    async request(method) {
      assert.equal(method, "account/login/start");
      this.emit("account/login/completed", {
        loginId: "login-immediate",
        success: true,
        error: null,
      });
      return {
        type: "chatgptDeviceCode",
        loginId: "login-immediate",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      };
    }

    async stop() {
      this.stopped = true;
    }
  }

  const client = new ImmediateLoginClient();
  const output = [];
  const exitCode = await runLogin(
    { logLevel: "error", loginTimeoutMs: 1_000 },
    {
      client,
      logger: NULL_LOGGER,
      stdout: { write: (chunk) => output.push(String(chunk)) },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(client.stopped, true);
  assert.match(output.join(""), /Codex login completed/);
});
