import { EventEmitter } from "node:events";

function finitePercent(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, number));
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resetIso(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  // Codex app-server reports Unix seconds. Accept milliseconds as a defensive
  // compatibility measure for fixtures and future protocol revisions.
  const milliseconds = number < 10_000_000_000 ? number * 1_000 : number;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function titleCase(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const known = {
    api_key: "API Key",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
    free: "Free",
    go: "Go",
    unknown: "Codex",
  };
  const normalized = value.trim().toLowerCase();
  if (known[normalized]) return known[normalized];
  return normalized
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function accountLabel(accountResponse, snapshot) {
  const account = accountResponse?.account ?? accountResponse ?? null;
  if (account?.type === "apiKey") return "API Key";
  if (account?.type === "amazonBedrock") return "Amazon Bedrock";
  return titleCase(account?.planType ?? snapshot?.planType) || "Codex";
}

export function selectCodexRateLimit(response) {
  if (!response || typeof response !== "object") return null;
  if (response.primary || response.secondary) return response;
  const byId = response.rateLimitsByLimitId;
  if (byId && typeof byId === "object") {
    if (byId.codex && typeof byId.codex === "object") return byId.codex;
    const match = Object.entries(byId).find(([key, value]) => (
      key.toLowerCase() === "codex" || value?.limitId?.toLowerCase?.() === "codex"
    ));
    if (match) return match[1];
  }
  const fallback = response.rateLimits;
  return fallback && typeof fallback === "object" ? fallback : null;
}

function windowPayload(kind, window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = finitePercent(window.usedPercent);
  if (usedPercent === null) return null;
  const result = { kind, usedPercent };
  const resetsAt = resetIso(window.resetsAt);
  if (resetsAt) result.resetsAt = resetsAt;
  return result;
}

function classifyWindows(snapshot) {
  const candidates = [
    { slot: "primary", window: snapshot?.primary },
    { slot: "secondary", window: snapshot?.secondary },
  ].filter(({ window }) => finitePercent(window?.usedPercent) !== null);
  if (candidates.length === 0) return [];
  if (candidates.length === 1) {
    const [{ slot, window }] = candidates;
    const duration = Number(window.windowDurationMins);
    const kind = Number.isFinite(duration)
      ? duration >= 1_440 ? "weekly" : "session"
      : slot === "secondary" ? "weekly" : "session";
    return [windowPayload(kind, window)];
  }

  const withDurations = candidates.map((candidate) => ({
    ...candidate,
    duration: Number(candidate.window.windowDurationMins),
  }));
  const canClassifyByDuration = withDurations.every(({ duration }) => Number.isFinite(duration))
    && withDurations[0].duration !== withDurations[1].duration;
  const ordered = canClassifyByDuration
    ? withDurations.sort((left, right) => left.duration - right.duration)
    : withDurations;
  return [
    windowPayload("session", ordered[0].window),
    windowPayload("weekly", ordered[ordered.length - 1].window),
  ];
}

/**
 * Convert an official app-server rate-limit snapshot to the minimal structure
 * consumed by TokenMonitorCodexAdapter in the Android bridge.
 *
 * Returns null when the snapshot is stale or incomplete. Callers must not
 * serve a stale payload as current quota data.
 */
export function buildStatsPayload(input, options = {}) {
  const wrapped = input && typeof input === "object" && (
    Object.hasOwn(input, "rateLimitsResponse")
    || Object.hasOwn(input, "account")
    || Object.hasOwn(input, "updatedAt")
  );
  const source = wrapped ? { ...options, ...input } : { ...options, rateLimits: input };
  const now = timestampMs(source.now ?? options.now) ?? Date.now();
  const updatedAt = timestampMs(source.updatedAt ?? options.updatedAt);
  const staleAfterMs = Number(source.staleAfterMs ?? options.staleAfterMs ?? 900_000);
  if (updatedAt === null || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) return null;
  if (Math.max(0, now - updatedAt) > staleAfterMs) return null;

  const response = source.rateLimitsResponse ?? source.rateLimits;
  const snapshot = selectCodexRateLimit(response);
  if (!snapshot) return null;
  const windows = classifyWindows(snapshot).filter(Boolean);
  if (windows.length === 0) return null;
  const rateLimited = (
    snapshot.rateLimitReachedType !== null
    && snapshot.rateLimitReachedType !== undefined
  ) || windows.every((window) => window.usedPercent >= 100);

  return {
    limits: {
      providers: [
        {
          provider: "codex",
          status: rateLimited ? "rateLimited" : "ok",
          stale: false,
          updatedAt,
          accountLabel: accountLabel(source.account, snapshot),
          windows,
        },
      ],
    },
  };
}

export const mapRateLimitsToStats = buildStatsPayload;

function errorMessage(error) {
  if (error?.message === "Codex is not logged in") return error.message;
  if (error?.message === "Codex returned an incomplete rate-limit snapshot") return error.message;
  if (error?.code === "ETIMEDOUT") return "Codex app-server request timed out";
  if (error?.name === "CodexAppServerError") {
    const code = error.code === undefined ? "" : ` (${String(error.code).slice(0, 32)})`;
    return `Codex app-server request failed${code}`;
  }
  return "Codex quota refresh failed";
}

export class QuotaService extends EventEmitter {
  constructor(clientOrOptions, maybeOptions = {}) {
    super();
    const options = clientOrOptions?.request
      ? { ...maybeOptions, client: clientOrOptions }
      : { ...(clientOrOptions || {}) };
    if (!options.client) throw new TypeError("QuotaService requires a Codex app-server client");

    this.client = options.client;
    this.pollIntervalMs = options.pollIntervalMs ?? 300_000;
    this.staleAfterMs = options.staleAfterMs ?? options.maxStaleMs ?? 900_000;
    this.maxBackoffMs = Math.max(
      this.pollIntervalMs,
      options.maxBackoffMs ?? 60_000,
    );
    this.initialBackoffMs = Math.max(1, options.initialBackoffMs ?? 1_000);
    this.logger = options.logger || null;
    this.now = options.now || Date.now;
    this.setTimeout = options.setTimeout || globalThis.setTimeout;
    this.clearTimeout = options.clearTimeout || globalThis.clearTimeout;

    this.running = false;
    this.pollPromise = null;
    this.timer = null;
    this.cache = null;
    this.lastAttemptAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.boundRefreshNotification = () => this.#schedule(0);
  }

  async start() {
    if (this.running) return this.pollPromise;
    this.running = true;
    this.client.on?.("account/rateLimits/updated", this.boundRefreshNotification);
    this.client.on?.("account/updated", this.boundRefreshNotification);
    return this.pollNow();
  }

  async pollNow() {
    if (this.pollPromise) return this.pollPromise;
    this.#cancelTimer();
    this.pollPromise = this.#poll();
    try {
      return await this.pollPromise;
    } finally {
      this.pollPromise = null;
      if (this.running) this.#schedule(this.#nextDelay());
    }
  }

  async #poll() {
    this.lastAttemptAt = this.now();
    try {
      if (!this.client.ready) await this.client.start();
      const [account, rateLimits] = await Promise.all([
        this.client.request("account/read", { refreshToken: false }),
        this.client.request("account/rateLimits/read"),
      ]);
      if (!account?.account) throw new Error("Codex is not logged in");

      const updatedAt = this.now();
      const payload = buildStatsPayload({
        account,
        rateLimits,
        updatedAt,
        now: updatedAt,
        staleAfterMs: this.staleAfterMs,
      });
      if (!payload) throw new Error("Codex returned an incomplete rate-limit snapshot");

      this.cache = { account, rateLimits, updatedAt };
      this.lastSuccessAt = updatedAt;
      this.lastError = null;
      this.consecutiveFailures = 0;
      this.emit("updated", payload);
      return payload;
    } catch (error) {
      this.lastError = errorMessage(error);
      this.consecutiveFailures += 1;
      this.logger?.warn?.("Codex quota refresh failed", {
        error: this.lastError,
        consecutiveFailures: this.consecutiveFailures,
      });
      await this.client.stop?.().catch(() => {});
      this.emit("refreshError", error);
      return null;
    }
  }

  #nextDelay() {
    if (this.consecutiveFailures === 0) return this.pollIntervalMs;
    const exponent = Math.min(this.consecutiveFailures - 1, 20);
    return Math.min(this.initialBackoffMs * (2 ** exponent), this.maxBackoffMs);
  }

  #schedule(delayMs) {
    if (!this.running) return;
    this.#cancelTimer();
    this.timer = this.setTimeout(() => {
      this.timer = null;
      void this.pollNow();
    }, delayMs);
    this.timer?.unref?.();
  }

  #cancelTimer() {
    if (this.timer !== null) {
      this.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getStats(now = this.now()) {
    if (!this.cache) return null;
    return buildStatsPayload({
      ...this.cache,
      now,
      staleAfterMs: this.staleAfterMs,
    });
  }

  getHealth(now = this.now()) {
    const stats = this.getStats(now);
    return {
      status: stats ? "ok" : "degraded",
      ready: Boolean(stats),
      fresh: Boolean(stats),
      running: this.running,
      codexConnected: Boolean(this.client.ready),
      updatedAt: this.lastSuccessAt,
      lastAttemptAt: this.lastAttemptAt,
      consecutiveFailures: this.consecutiveFailures,
      error: this.lastError,
    };
  }

  async stop() {
    this.running = false;
    this.#cancelTimer();
    this.client.off?.("account/rateLimits/updated", this.boundRefreshNotification);
    this.client.off?.("account/updated", this.boundRefreshNotification);
    await this.client.stop?.();
    if (this.pollPromise) await this.pollPromise.catch(() => {});
  }
}
