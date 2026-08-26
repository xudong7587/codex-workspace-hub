import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { loadConfig, validateServeConfig } from "../src/config.js";

const STRONG_SECRET = "8c97c97791db4540a8d7bd2d614de4536f958f4062adba6dbf7908b4e20f4285";
const STRONG_ADMIN_TOKEN = "92782f5b6f4a4ad48996caa94d0dc0f1bc8e621ec4d0f407a1d92872ef0142c7";

test("loadConfig defaults to the APK Token Monitor port 17321", () => {
  const config = loadConfig({});
  assert.equal(config.port, 17_321);
});

test("loadConfig derives the Codex home from a custom data directory", () => {
  const dataDir = join("custom", "vwatch-data");
  const config = loadConfig({ DATA_DIR: dataDir });

  assert.equal(config.dataDir, dataDir);
  assert.equal(config.codexHome, join(dataDir, "providers", "codex"));
  assert.equal(
    loadConfig({ DATA_DIR: dataDir, CODEX_HOME: "explicit-codex-home" }).codexHome,
    "explicit-codex-home",
  );
  assert.equal(
    loadConfig({}, { dataDir }).codexHome,
    join(dataDir, "providers", "codex"),
  );
});

test("loadConfig rejects values that exceed Node's maximum timer delay", () => {
  const tooLargeMilliseconds = "2147483648";
  const tooLargeSeconds = "2147484";
  const millisecondNames = [
    "CODEX_REQUEST_TIMEOUT_MS",
    "CODEX_START_TIMEOUT_MS",
    "CODEX_STOP_TIMEOUT_MS",
    "CODEX_LOGIN_TIMEOUT_MS",
    "MAX_BACKOFF_MS",
    "PROVIDER_REQUEST_TIMEOUT_MS",
    "MANUAL_REFRESH_COOLDOWN_MS",
  ];

  for (const name of millisecondNames) {
    assert.throws(
      () => loadConfig({ [name]: tooLargeMilliseconds }),
      new RegExp(`${name} must be an integer between 1 and 2147483647`),
    );
  }
  assert.throws(
    () => loadConfig({ POLL_INTERVAL_SECONDS: tooLargeSeconds }),
    /POLL_INTERVAL_SECONDS must be an integer between 1 and 2147483/,
  );
  assert.throws(
    () => loadConfig({ MAX_STALE_MS: tooLargeMilliseconds }),
    /MAX_STALE_MS must be an integer between 1 and 2147483647/,
  );
});

test("validateServeConfig rejects missing and weak secrets", () => {
  assert.throws(
    () => validateServeConfig(loadConfig({})),
    /TOKEN_MONITOR_SECRET/i,
  );
  assert.throws(
    () => validateServeConfig(loadConfig({ TOKEN_MONITOR_SECRET: "too-short" })),
    /at least 32 bytes/i,
  );
});

test("validateServeConfig rejects a long placeholder secret", () => {
  assert.throws(
    () => validateServeConfig(loadConfig({
      TOKEN_MONITOR_SECRET: "CHANGE_ME_CHANGE_ME_CHANGE_ME_CHANGE_ME",
    })),
    /placeholder|replace|random|secret/i,
  );
});

test("validateServeConfig requires a separate strong admin token", () => {
  assert.throws(
    () => validateServeConfig(loadConfig({ TOKEN_MONITOR_SECRET: STRONG_SECRET })),
    /HUB_ADMIN_TOKEN.*at least 32 bytes/i,
  );
  assert.throws(
    () => validateServeConfig(loadConfig({
      TOKEN_MONITOR_SECRET: STRONG_SECRET,
      HUB_ADMIN_TOKEN: "too-short",
    })),
    /HUB_ADMIN_TOKEN.*at least 32 bytes/i,
  );
  assert.throws(
    () => validateServeConfig(loadConfig({
      TOKEN_MONITOR_SECRET: STRONG_SECRET,
      HUB_ADMIN_TOKEN: STRONG_SECRET,
    })),
    /must differ/i,
  );
});

test("validateServeConfig rejects stale windows shorter than polling", () => {
  const config = loadConfig({
    TOKEN_MONITOR_SECRET: STRONG_SECRET,
    HUB_ADMIN_TOKEN: STRONG_ADMIN_TOKEN,
    POLL_INTERVAL_SECONDS: "60",
    STALE_AFTER_SECONDS: "30",
  });
  assert.throws(
    () => validateServeConfig(config),
    /must not be shorter than the poll interval/i,
  );
});

test("validateServeConfig accepts a strong secret and safe timing window", () => {
  const config = loadConfig({
    TOKEN_MONITOR_SECRET: STRONG_SECRET,
    HUB_ADMIN_TOKEN: STRONG_ADMIN_TOKEN,
    POLL_INTERVAL_SECONDS: "300",
    STALE_AFTER_SECONDS: "900",
  });
  assert.equal(validateServeConfig(config), config);
});
