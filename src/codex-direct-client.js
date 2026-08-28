import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { APP_VERSION } from "./version.js";

const DEFAULT_AUTH_BASE_URL = "https://auth.openai.com";
const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;
const DEFAULT_USAGE_MAX_ATTEMPTS = 3;
const DEFAULT_USAGE_RETRY_BASE_MS = 600;
const DEFAULT_USAGE_RETRY_MAX_MS = 5_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const encoded = token.split(".")[1];
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function authClaims(token) {
  const claims = decodeJwtPayload(token) || {};
  const nested = claims["https://api.openai.com/auth"];
  return nested && typeof nested === "object" ? { ...claims, ...nested } : claims;
}

function accountId(auth) {
  const tokens = auth?.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  return tokens.account_id
    || authClaims(tokens.id_token).chatgpt_account_id
    || authClaims(tokens.access_token).chatgpt_account_id
    || null;
}

function planType(auth) {
  const tokens = auth?.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const claims = authClaims(tokens.id_token);
  return claims.chatgpt_plan_type || claims.plan_type || null;
}

function tokenNeedsRefresh(token, now = Date.now()) {
  const expiration = Number(decodeJwtPayload(token)?.exp);
  if (!Number.isFinite(expiration)) return false;
  return expiration * 1_000 <= now + ACCESS_TOKEN_REFRESH_WINDOW_MS;
}

function abortError(message = "Codex request was cancelled") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "CANCELLED";
  return error;
}

function requestError(message, status, options = {}) {
  const error = new Error(message);
  if (status !== undefined) error.status = status;
  if (options.code) error.code = options.code;
  if (options.retryable !== undefined) error.retryable = Boolean(options.retryable);
  if (Number.isFinite(options.retryAfterMs)) error.retryAfterMs = options.retryAfterMs;
  return error;
}

function retryAfterMs(response, now = Date.now()) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function usageHttpError(response, now) {
  const status = response.status;
  let code = "CODEX_REQUEST_FAILED";
  if (status === 401 || status === 403) code = "CODEX_AUTH_EXPIRED";
  else if (status === 429) code = "CODEX_RATE_LIMITED";
  else if (status >= 500) code = "CODEX_UPSTREAM_UNAVAILABLE";
  else if (RETRYABLE_HTTP_STATUSES.has(status)) code = "CODEX_TRANSIENT_RESPONSE";
  return requestError(`Codex usage request failed (${status})`, status, {
    code,
    retryable: RETRYABLE_HTTP_STATUSES.has(status),
    retryAfterMs: retryAfterMs(response, now),
  });
}

function incompleteUsageError() {
  return requestError("Codex returned an incomplete rate-limit snapshot", undefined, {
    code: "CODEX_INVALID_RESPONSE",
    retryable: true,
  });
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function resetTimestamp(window, now = Date.now()) {
  const explicit = finiteNumber(window?.reset_at);
  if (explicit !== null) return explicit;
  const after = finiteNumber(window?.reset_after_seconds);
  return after === null ? null : Math.floor(now / 1_000) + after;
}

function mapWindow(window, now) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = finiteNumber(window.used_percent);
  if (usedPercent === null) return null;
  const seconds = finiteNumber(window.limit_window_seconds);
  const mapped = { usedPercent: Math.min(100, Math.max(0, usedPercent)) };
  if (seconds !== null) mapped.windowDurationMins = seconds / 60;
  const resetsAt = resetTimestamp(window, now);
  if (resetsAt !== null) mapped.resetsAt = resetsAt;
  return mapped;
}

export function mapCodexUsageResponse(payload, now = Date.now()) {
  const limit = payload?.rate_limit;
  if (!limit || typeof limit !== "object") {
    throw new Error("Codex returned an incomplete rate-limit snapshot");
  }
  const primary = mapWindow(limit.primary_window, now);
  const secondary = mapWindow(limit.secondary_window, now);
  if (!primary && !secondary) {
    throw new Error("Codex returned an incomplete rate-limit snapshot");
  }
  return {
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary,
        secondary,
        rateLimitReachedType: payload.rate_limit_reached_type ?? null,
        planType: payload.plan_type ?? null,
      },
    },
  };
}

async function syncParentDirectory(filePath) {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await open(dirname(filePath), "r");
    await handle.sync();
  } catch {
    // The auth file itself is already synced and renamed. Directory fsync is
    // best-effort because some NAS filesystems do not support it.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class CodexDirectClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexHome = options.codexHome || process.env.CODEX_HOME || join(process.env.HOME || "/data", ".codex");
    this.authPath = options.authPath || join(this.codexHome, "auth.json");
    this.authBaseUrl = String(options.authBaseUrl || DEFAULT_AUTH_BASE_URL).replace(/\/$/, "");
    this.chatgptBaseUrl = String(options.chatgptBaseUrl || DEFAULT_CHATGPT_BASE_URL).replace(/\/$/, "");
    this.clientId = options.clientId || DEFAULT_CLIENT_ID;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.loginTimeoutMs = options.loginTimeoutMs ?? 15 * 60_000;
    const usageMaxAttempts = Number(options.usageMaxAttempts ?? DEFAULT_USAGE_MAX_ATTEMPTS);
    const usageRetryBaseMs = Number(options.usageRetryBaseMs ?? DEFAULT_USAGE_RETRY_BASE_MS);
    const usageRetryMaxMs = Number(options.usageRetryMaxMs ?? DEFAULT_USAGE_RETRY_MAX_MS);
    this.usageMaxAttempts = Number.isFinite(usageMaxAttempts)
      ? Math.max(1, Math.floor(usageMaxAttempts))
      : DEFAULT_USAGE_MAX_ATTEMPTS;
    this.usageRetryBaseMs = Number.isFinite(usageRetryBaseMs)
      ? Math.max(0, usageRetryBaseMs)
      : DEFAULT_USAGE_RETRY_BASE_MS;
    this.usageRetryMaxMs = Math.max(
      this.usageRetryBaseMs,
      Number.isFinite(usageRetryMaxMs) ? usageRetryMaxMs : DEFAULT_USAGE_RETRY_MAX_MS,
    );
    this.now = options.now || Date.now;
    this.sleep = options.sleep || sleep;
    this.logger = options.logger || null;
    this.ready = false;
    this.login = null;
    this.refreshPromise = null;
    this.stopController = null;
  }

  async start() {
    await mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    this.stopController = new AbortController();
    this.ready = true;
  }

  async stop() {
    this.ready = false;
    this.stopController?.abort();
    const login = this.login;
    login?.controller.abort();
    await login?.promise?.catch(() => {});
  }

  async request(method, params = {}) {
    if (!this.ready) throw new Error("Codex client is not running");
    if (method === "account/read") return this.#readAccount(params);
    if (method === "account/rateLimits/read") return this.#readRateLimits();
    if (method === "account/login/start") return this.#startDeviceLogin(params);
    if (method === "account/login/cancel") {
      this.login?.controller.abort();
      return {};
    }
    throw new Error(`Unsupported Codex method: ${method}`);
  }

  async #readAccount(params) {
    let auth = await this.#readAuth();
    if (auth && params?.refreshToken) auth = await this.#ensureFreshAuth(auth);
    if (!auth?.tokens?.access_token) return { account: null };
    return {
      account: {
        type: "chatgpt",
        planType: planType(auth),
        accountId: accountId(auth),
      },
    };
  }

  async #readRateLimits() {
    let lastError;
    for (let attempt = 1; attempt <= this.usageMaxAttempts; attempt += 1) {
      try {
        return await this.#readRateLimitsOnce();
      } catch (error) {
        lastError = error;
        if (error?.code === "CANCELLED" || error?.name === "AbortError") throw error;
        if (!error?.retryable || attempt >= this.usageMaxAttempts) throw error;
        const exponentialDelay = this.usageRetryBaseMs * (2 ** (attempt - 1));
        const requestedDelay = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0;
        const delayMs = Math.min(
          this.usageRetryMaxMs,
          Math.max(exponentialDelay, requestedDelay),
        );
        this.logger?.warn?.("Codex usage request will be retried", {
          attempt,
          maxAttempts: this.usageMaxAttempts,
          delayMs,
          errorCode: error?.code || "UNKNOWN",
          httpStatus: error?.status ?? null,
        });
        await this.sleep(delayMs, this.stopController?.signal);
      }
    }
    throw lastError;
  }

  async #readRateLimitsOnce() {
    let auth = await this.#readAuth();
    if (!auth?.tokens?.access_token) throw new Error("Codex is not logged in");
    auth = await this.#ensureFreshAuth(auth);
    let response = await this.#fetchUsage(auth);
    if ([401, 403].includes(response.status) && auth?.tokens?.refresh_token) {
      auth = await this.#refreshAuth(auth);
      response = await this.#fetchUsage(auth);
    }
    if (!response.ok) throw usageHttpError(response, this.now());
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw incompleteUsageError();
    }
    try {
      return mapCodexUsageResponse(payload, this.now());
    } catch {
      throw incompleteUsageError();
    }
  }

  async #fetchUsage(auth) {
    const id = accountId(auth);
    if (!id) throw new Error("Codex account id is missing; sign in again");
    return this.#fetch(`${this.chatgptBaseUrl}/wham/usage`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${auth.tokens.access_token}`,
        "ChatGPT-Account-Id": id,
        "OAI-Product-Sku": "codex",
        originator: "vwatch_quota_hub",
        "User-Agent": `vwatch-quota-hub/${APP_VERSION}`,
      },
    });
  }

  async #ensureFreshAuth(auth) {
    if (!tokenNeedsRefresh(auth?.tokens?.access_token, this.now())) return auth;
    if (!auth?.tokens?.refresh_token) return auth;
    return this.#refreshAuth(auth);
  }

  async #refreshAuth(auth) {
    if (this.refreshPromise) return this.refreshPromise;
    const operation = (async () => {
      const response = await this.#fetch(`${this.authBaseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: this.clientId,
          grant_type: "refresh_token",
          refresh_token: auth.tokens.refresh_token,
        }),
      });
      if (!response.ok) {
        let code = "CODEX_REQUEST_FAILED";
        if ([400, 401, 403].includes(response.status)) code = "CODEX_AUTH_REFRESH_FAILED";
        else if (response.status === 429) code = "CODEX_RATE_LIMITED";
        else if (response.status >= 500) code = "CODEX_UPSTREAM_UNAVAILABLE";
        else if (RETRYABLE_HTTP_STATUSES.has(response.status)) code = "CODEX_TRANSIENT_RESPONSE";
        throw requestError(`Codex token refresh failed (${response.status})`, response.status, {
          code,
          retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
          retryAfterMs: retryAfterMs(response, this.now()),
        });
      }
      const refreshed = await this.#json(response, "Codex token refresh response was not valid JSON");
      const next = structuredClone(auth);
      next.auth_mode = next.auth_mode || "chatgpt";
      next.tokens = {
        ...next.tokens,
        ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
        ...(refreshed.access_token ? { access_token: refreshed.access_token } : {}),
        ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
      };
      next.tokens.account_id = accountId(next);
      next.last_refresh = new Date(this.now()).toISOString();
      await this.#writeAuth(next);
      return next;
    })();
    this.refreshPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.refreshPromise === operation) this.refreshPromise = null;
    }
  }

  async #startDeviceLogin(params) {
    if (params?.type !== "chatgptDeviceCode") {
      throw new Error("Only ChatGPT device-code login is supported");
    }
    if (this.login) throw new Error("A Codex login is already in progress");
    const response = await this.#fetch(`${this.authBaseUrl}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.clientId }),
    });
    if (!response.ok) {
      throw requestError(`Codex device-code request failed (${response.status})`, response.status);
    }
    const challenge = await this.#json(response, "Codex device-code response was not valid JSON");
    const deviceAuthId = challenge.device_auth_id;
    const userCode = challenge.user_code || challenge.usercode;
    if (typeof deviceAuthId !== "string" || typeof userCode !== "string") {
      throw new Error("Codex returned an incomplete device-code challenge");
    }
    const loginId = randomUUID();
    const controller = new AbortController();
    const intervalSeconds = Math.max(1, finiteNumber(challenge.interval) ?? 5);
    const login = { loginId, controller };
    this.login = login;
    login.promise = this.#completeDeviceLogin({
      login,
      deviceAuthId,
      userCode,
      intervalSeconds,
    });
    void login.promise;
    return {
      type: "chatgptDeviceCode",
      loginId,
      verificationUrl: `${this.authBaseUrl}/codex/device`,
      userCode,
    };
  }

  async #completeDeviceLogin({ login, deviceAuthId, userCode, intervalSeconds }) {
    let success = false;
    let errorMessage = null;
    try {
      const deadline = this.now() + this.loginTimeoutMs;
      let codeResponse = null;
      while (this.now() < deadline) {
        if (login.controller.signal.aborted) throw abortError();
        const response = await this.#fetch(`${this.authBaseUrl}/api/accounts/deviceauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        }, login.controller.signal);
        if (response.ok) {
          codeResponse = await this.#json(response, "Codex device authorization response was not valid JSON");
          break;
        }
        if (response.status !== 403 && response.status !== 404) {
          throw requestError(`Codex device authorization failed (${response.status})`, response.status);
        }
        await this.sleep(intervalSeconds * 1_000, login.controller.signal);
      }
      if (!codeResponse) throw new Error("Codex device-code login timed out");
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code: codeResponse.authorization_code,
        redirect_uri: `${this.authBaseUrl}/deviceauth/callback`,
        client_id: this.clientId,
        code_verifier: codeResponse.code_verifier,
      });
      const tokenResponse = await this.#fetch(`${this.authBaseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }, login.controller.signal);
      if (!tokenResponse.ok) {
        throw requestError(`Codex token exchange failed (${tokenResponse.status})`, tokenResponse.status);
      }
      const tokens = await this.#json(tokenResponse, "Codex token exchange response was not valid JSON");
      if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) {
        throw new Error("Codex token exchange returned incomplete credentials");
      }
      const auth = {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: tokens.id_token,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          account_id: null,
        },
        last_refresh: new Date(this.now()).toISOString(),
      };
      auth.tokens.account_id = accountId(auth);
      if (!auth.tokens.account_id) throw new Error("Codex login token did not include an account id");
      await this.#writeAuth(auth);
      success = true;
    } catch (error) {
      if (error?.code !== "CANCELLED") {
        errorMessage = "Codex 登录失败，请稍后重试";
        this.logger?.warn?.("Codex direct login failed", { errorType: error?.name || "Error" });
      }
    } finally {
      if (this.login === login) this.login = null;
      this.emit("account/login/completed", {
        loginId: login.loginId,
        success,
        error: errorMessage,
      });
      if (success) this.emit("account/updated", { authMode: "chatgpt" });
    }
  }

  async #readAuth() {
    try {
      const raw = await readFile(this.authPath);
      if (raw.byteLength > MAX_AUTH_FILE_BYTES) throw new Error("Codex auth file is too large");
      const auth = JSON.parse(raw.toString("utf8"));
      return auth && typeof auth === "object" ? auth : null;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async #writeAuth(auth) {
    await mkdir(dirname(this.authPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.authPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    let temporaryCreated = false;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      try {
        await handle.writeFile(`${JSON.stringify(auth, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.authPath);
      temporaryCreated = false;
      await syncParentDirectory(this.authPath);
    } finally {
      if (temporaryCreated) await unlink(temporaryPath).catch(() => {});
    }
  }

  async #fetch(url, init = {}, outerSignal = null) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const stopSignal = this.stopController?.signal;
    outerSignal?.addEventListener("abort", onAbort, { once: true });
    stopSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref?.();
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (outerSignal?.aborted || stopSignal?.aborted) throw abortError();
      if (controller.signal.aborted) {
        const timeout = new Error("Codex request timed out");
        timeout.code = "ETIMEDOUT";
        timeout.retryable = true;
        throw timeout;
      }
      const networkError = new Error("Codex network request failed");
      networkError.code = "NETWORK_ERROR";
      networkError.retryable = true;
      throw networkError;
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onAbort);
      stopSignal?.removeEventListener("abort", onAbort);
    }
  }

  async #json(response, message) {
    try {
      return await response.json();
    } catch {
      throw new Error(message);
    }
  }
}

export const CODEX_OAUTH_CLIENT_ID = DEFAULT_CLIENT_ID;
