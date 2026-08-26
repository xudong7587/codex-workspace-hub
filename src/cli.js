#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { CodexAppServerClient } from "./codex-app-server.js";
import { loadConfig, validateServeConfig } from "./config.js";
import { CredentialStore } from "./credential-store.js";
import {
  closeGatewayServer,
  createGatewayServer,
  startGatewayServer,
} from "./http-server.js";
import { createLogger } from "./logger.js";
import { ProviderManager } from "./provider-manager.js";
import { createCodexProvider } from "./providers/codex.js";
import { createOpenRouterProvider } from "./providers/openrouter.js";
import { SettingsStore, defaultRuntimeSettings } from "./settings-store.js";

function line(stream, value = "") {
  stream.write(`${value}\n`);
}

export function createCodexChildEnv(config, baseEnv = process.env, extraEnv = {}) {
  const source = { ...baseEnv, ...extraEnv };
  const allowed = new Set([
    "PATH", "HOME", "USER", "USERPROFILE", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ",
    "TMP", "TEMP", "TMPDIR", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]);
  const childEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key.toUpperCase()) && value !== undefined) childEnv[key] = value;
  }
  childEnv.CODEX_HOME = config.codexHome;
  return childEnv;
}

function createClient(config, logger, options = {}) {
  return new CodexAppServerClient({
    command: config.codexBin,
    env: createCodexChildEnv(config, process.env, options.env || {}),
    requestTimeoutMs: config.requestTimeoutMs,
    startTimeoutMs: config.startTimeoutMs,
    stopTimeoutMs: config.stopTimeoutMs,
    logger,
    ...options.clientOptions,
  });
}

function createLoginCompletionWaiter(client, timeoutMs) {
  let expectedLoginId = null;
  let buffered = [];
  let settled = false;
  let timer;
  let resolveWait;
  let rejectWait;

  const cleanup = () => {
    clearTimeout(timer);
    client.off("account/login/completed", onCompleted);
    client.off("exit", onExit);
  };
  const settle = (callback, value) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback(value);
  };
  const onCompleted = (params) => {
    if (expectedLoginId === null) {
      if (buffered.length < 16) buffered.push(params);
      return;
    }
    if (params?.loginId === expectedLoginId) settle(resolveWait, params);
  };
  const onExit = () => settle(rejectWait, new Error("Codex app-server exited during login"));
  const promise = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });

  client.on("account/login/completed", onCompleted);
  client.once("exit", onExit);
  timer = setTimeout(() => {
    settle(rejectWait, new Error(`Codex device-code login timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    promise,
    setLoginId(loginId) {
      expectedLoginId = loginId;
      const earlyMatch = buffered.find((params) => params?.loginId === expectedLoginId);
      buffered = [];
      if (earlyMatch) settle(resolveWait, earlyMatch);
    },
    cancel() {
      if (settled) return;
      settled = true;
      buffered = [];
      cleanup();
    },
  };
}

export function createRuntime(config, options = {}) {
  const logger = options.logger || createLogger(config.logLevel, options.stderr || process.stderr);
  const clientFactory = options.clientFactory || (() => createClient(config, logger, options));
  const settingsStore = options.settingsStore || new SettingsStore({
    dataDir: config.dataDir,
    encryptionSecret: options.credentialStore?.getEncryptionSecret() || config.adminToken,
    defaults: defaultRuntimeSettings(config),
  });
  const codexProvider = options.codexProvider || createCodexProvider({
    clientFactory,
    timeoutMs: config.loginTimeoutMs,
    logger,
  });
  const openRouterProvider = options.openRouterProvider || createOpenRouterProvider({
    timeoutMs: config.providerRequestTimeoutMs,
  });
  const providerManager = options.providerManager || options.quotaService || new ProviderManager({
    settingsStore,
    providers: [codexProvider, openRouterProvider],
    manualRefreshCooldownMs: config.manualRefreshCooldownMs,
    logger,
  });
  return {
    logger,
    clientFactory,
    settingsStore,
    providerManager,
    quotaService: providerManager,
  };
}

async function initializeCredentialStore(config, options = {}) {
  const credentialStore = options.credentialStore || new CredentialStore({
    dataDir: config.dataDir,
    initialAdminPassword: config.adminToken,
    initialBridgeSecret: config.tokenMonitorSecret,
  });
  await credentialStore.initialize?.();
  return credentialStore;
}

export async function runServe(config, options = {}) {
  validateServeConfig(config);
  const credentialStore = await initializeCredentialStore(config, options);
  const runtimeOptions = { ...options, credentialStore };
  const { logger, providerManager } = createRuntime(config, runtimeOptions);
  await providerManager.initialize?.();
  const server = options.server || createGatewayServer({
    config,
    providerManager,
    credentialStore,
    logger,
  });
  await startGatewayServer(server, config);
  const address = server.address();
  logger.info("VWatch Quota Hub listening", {
    host: typeof address === "object" && address ? address.address : config.host,
    port: typeof address === "object" && address ? address.port : config.port,
  });

  void providerManager.start().catch((error) => {
    logger.warn("Initial provider refresh task failed", {
      errorType: error?.name || "Error",
    });
  });

  let settled = false;
  const shutdown = new Promise((resolve, reject) => {
    const finish = (value, isError = false) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      server.off("error", onServerError);
      if (isError) reject(value);
      else resolve(value);
    };
    const onSigint = () => finish("SIGINT");
    const onSigterm = () => finish("SIGTERM");
    const onServerError = (error) => finish(error, true);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    server.once("error", onServerError);
  });

  try {
    const signal = await shutdown;
    logger.info("Shutting down VWatch Quota Hub", { signal });
  } finally {
    await closeGatewayServer(server).catch((error) => {
      logger.warn("HTTP server shutdown failed", { error: error.message });
    });
    await providerManager.stop().catch((error) => {
      logger.warn("Provider manager shutdown failed", { error: error.message });
    });
  }
  return 0;
}

export async function runLogin(config, options = {}) {
  const stdout = options.stdout || process.stdout;
  const logger = options.logger || createLogger(config.logLevel, options.stderr || process.stderr);
  const client = options.client || createClient(config, logger, options);
  let completionWaiter;
  try {
    await client.start();
    completionWaiter = createLoginCompletionWaiter(client, config.loginTimeoutMs);
    const login = await client.request("account/login/start", { type: "chatgptDeviceCode" });
    if (login?.type !== "chatgptDeviceCode" || !login.loginId) {
      throw new Error("Codex did not return a device-code login challenge");
    }
    completionWaiter.setLoginId(login.loginId);

    line(stdout, "Open this URL in a browser and enter the one-time code:");
    line(stdout, login.verificationUrl);
    line(stdout, login.userCode);
    line(stdout, "Waiting for Codex login to complete...");

    const completed = await completionWaiter.promise;
    if (!completed?.success) {
      throw new Error(completed?.error || "Codex device-code login failed");
    }
    line(stdout, "Codex login completed.");
    return 0;
  } finally {
    completionWaiter?.cancel();
    await client.stop().catch(() => {});
  }
}

export async function runStatus(config, options = {}) {
  const stdout = options.stdout || process.stdout;
  validateServeConfig(config);
  const credentialStore = await initializeCredentialStore(config, options);
  const { providerManager } = createRuntime(config, { ...options, credentialStore });
  try {
    await providerManager.initialize?.();
    await providerManager.pollNow();
    const stats = providerManager.getStats();
    const health = providerManager.getHealth();
    line(stdout, JSON.stringify({ health, stats }, null, 2));
    return stats ? 0 : 1;
  } finally {
    await providerManager.stop().catch(() => {});
  }
}

function printHelp(stream) {
  line(stream, "Usage: node src/cli.js <serve|login|status>");
  line(stream, "");
  line(stream, "  serve   Start VWatch Quota Hub");
  line(stream, "  login   Sign in to Codex using a device code");
  line(stream, "  status  Refresh and print the current Hub status");
}

export async function runCli(argv = process.argv.slice(2), env = process.env, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const command = argv[0] || "serve";
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp(stdout);
    return 0;
  }

  try {
    const config = loadConfig(env);
    const options = { ...io, stdout, stderr };
    if (command === "serve") return await runServe(config, options);
    if (command === "login") return await runLogin(config, options);
    if (command === "status") return await runStatus(config, options);
    printHelp(stderr);
    line(stderr, `Unknown command: ${command}`);
    return 2;
  } catch (error) {
    line(stderr, `Error: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
