import { join } from "node:path";

const DEFAULT_DATA_DIR = "/data";
const DEFAULTS = Object.freeze({
  host: "0.0.0.0",
  port: 17_321,
  pollIntervalMs: 300_000,
  staleAfterMs: 900_000,
  logLevel: "info",
  dataDir: DEFAULT_DATA_DIR,
  codexHome: join(DEFAULT_DATA_DIR, "providers", "codex"),
  codexBin: "codex",
  providerRequestTimeoutMs: 15_000,
  manualRefreshCooldownMs: 60_000,
  requestTimeoutMs: 15_000,
  startTimeoutMs: 15_000,
  stopTimeoutMs: 2_000,
  loginTimeoutMs: 15 * 60_000,
  maxBackoffMs: 60_000,
});

const LOG_LEVELS = new Set(["error", "warn", "info", "debug"]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_TIMER_DELAY_SECONDS = Math.floor(MAX_TIMER_DELAY_MS / 1_000);

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function parseInteger(value, fallback, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!hasValue(value)) return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function durationMs(env, secondsName, millisecondsName, fallback) {
  if (hasValue(env[secondsName])) {
    return parseInteger(env[secondsName], fallback / 1_000, secondsName, {
      max: MAX_TIMER_DELAY_SECONDS,
    }) * 1_000;
  }
  return parseInteger(env[millisecondsName], fallback, millisecondsName, {
    max: MAX_TIMER_DELAY_MS,
  });
}

export function loadConfig(env = process.env, overrides = {}) {
  const logLevel = String(env.LOG_LEVEL || DEFAULTS.logLevel).trim().toLowerCase();
  if (!LOG_LEVELS.has(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of: ${[...LOG_LEVELS].join(", ")}`);
  }

  const dataDir = String(
    hasValue(overrides.dataDir)
      ? overrides.dataDir
      : (hasValue(env.DATA_DIR) ? env.DATA_DIR : DEFAULTS.dataDir),
  );
  const codexHome = String(
    hasValue(overrides.codexHome)
      ? overrides.codexHome
      : (hasValue(env.CODEX_HOME)
        ? env.CODEX_HOME
        : join(dataDir, "providers", "codex")),
  );

  const config = {
    host: String(env.HOST || DEFAULTS.host).trim() || DEFAULTS.host,
    port: parseInteger(env.PORT, DEFAULTS.port, "PORT", { max: 65_535 }),
    tokenMonitorSecret: env.TOKEN_MONITOR_SECRET === undefined
      ? ""
      : String(env.TOKEN_MONITOR_SECRET),
    adminToken: env.HUB_ADMIN_TOKEN === undefined
      ? ""
      : String(env.HUB_ADMIN_TOKEN),
    pollIntervalMs: durationMs(
      env,
      "POLL_INTERVAL_SECONDS",
      "POLL_INTERVAL_MS",
      DEFAULTS.pollIntervalMs,
    ),
    staleAfterMs: durationMs(
      env,
      "STALE_AFTER_SECONDS",
      "MAX_STALE_MS",
      DEFAULTS.staleAfterMs,
    ),
    logLevel,
    dataDir,
    codexHome,
    codexBin: String(env.CODEX_BIN || DEFAULTS.codexBin),
    requestTimeoutMs: parseInteger(
      env.CODEX_REQUEST_TIMEOUT_MS,
      DEFAULTS.requestTimeoutMs,
      "CODEX_REQUEST_TIMEOUT_MS",
      { max: MAX_TIMER_DELAY_MS },
    ),
    startTimeoutMs: parseInteger(
      env.CODEX_START_TIMEOUT_MS,
      DEFAULTS.startTimeoutMs,
      "CODEX_START_TIMEOUT_MS",
      { max: MAX_TIMER_DELAY_MS },
    ),
    stopTimeoutMs: parseInteger(
      env.CODEX_STOP_TIMEOUT_MS,
      DEFAULTS.stopTimeoutMs,
      "CODEX_STOP_TIMEOUT_MS",
      { max: MAX_TIMER_DELAY_MS },
    ),
    loginTimeoutMs: parseInteger(
      env.CODEX_LOGIN_TIMEOUT_MS,
      DEFAULTS.loginTimeoutMs,
      "CODEX_LOGIN_TIMEOUT_MS",
      { max: MAX_TIMER_DELAY_MS },
    ),
    maxBackoffMs: parseInteger(
      env.MAX_BACKOFF_MS,
      DEFAULTS.maxBackoffMs,
      "MAX_BACKOFF_MS",
      { max: MAX_TIMER_DELAY_MS },
    ),
    providerRequestTimeoutMs: parseInteger(
      env.PROVIDER_REQUEST_TIMEOUT_MS,
      DEFAULTS.providerRequestTimeoutMs,
      "PROVIDER_REQUEST_TIMEOUT_MS",
      { max: MAX_TIMER_DELAY_MS },
    ),
    manualRefreshCooldownMs: parseInteger(
      env.MANUAL_REFRESH_COOLDOWN_MS,
      DEFAULTS.manualRefreshCooldownMs,
      "MANUAL_REFRESH_COOLDOWN_MS",
      { max: MAX_TIMER_DELAY_MS },
    ),
    ...overrides,
    dataDir,
    codexHome,
  };

  config.secret = config.tokenMonitorSecret;
  config.maxStaleMs = config.staleAfterMs;
  return Object.freeze(config);
}

export function validateServeConfig(config) {
  if (
    config.tokenMonitorSecret
    && Buffer.byteLength(config.tokenMonitorSecret, "utf8") < 32
  ) {
    throw new Error("TOKEN_MONITOR_SECRET must be at least 32 bytes");
  }
  const normalizedSecret = config.tokenMonitorSecret.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (config.tokenMonitorSecret && ["CHANGEME", "REPLACEME", "YOURSECRET"].some((placeholder) => (
    normalizedSecret.includes(placeholder)
  ))) {
    throw new Error("TOKEN_MONITOR_SECRET must not be an example placeholder");
  }
  if (config.adminToken && config.adminToken.length < 12) {
    throw new Error("HUB_ADMIN_TOKEN must be at least 12 characters when provided");
  }
  const normalizedAdminToken = config.adminToken.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (config.adminToken && ["CHANGEME", "REPLACEME", "YOURTOKEN"].some((placeholder) => (
    normalizedAdminToken.includes(placeholder)
  ))) {
    throw new Error("HUB_ADMIN_TOKEN must not be an example placeholder");
  }
  if (config.adminToken && config.adminToken === config.tokenMonitorSecret) {
    throw new Error("HUB_ADMIN_TOKEN must differ from TOKEN_MONITOR_SECRET");
  }
  if (config.pollIntervalMs < 60_000) {
    throw new Error("POLL_INTERVAL_SECONDS/POLL_INTERVAL_MS must be at least 60 seconds");
  }
  if (config.staleAfterMs < config.pollIntervalMs) {
    throw new Error("STALE_AFTER_SECONDS/MAX_STALE_MS must not be shorter than the poll interval");
  }
  return config;
}

export { DEFAULTS };
