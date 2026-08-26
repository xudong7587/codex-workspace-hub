function clone(value) {
  return structuredClone(value);
}

function safeProviderError(providerId, error) {
  if (providerId === "codex") {
    if (/not logged in/i.test(error?.message || "")) return "Codex 尚未登录";
    return "Codex 额度刷新失败";
  }
  if (providerId === "openrouter") return "OpenRouter 额度刷新失败";
  return "Provider 额度刷新失败";
}

function freshSnapshot(entry, staleAfterMs, now) {
  if (!entry?.snapshot || !Number.isFinite(entry.lastSuccessAt)) return null;
  if (Math.max(0, now - entry.lastSuccessAt) > staleAfterMs) return null;
  return entry.snapshot;
}

function publicProviderConfig(providerId, config = {}) {
  if (providerId === "openrouter") {
    return {
      mode: config.mode || "key",
      hasApiKey: Boolean(config.apiKey),
    };
  }
  return {};
}

export class ProviderManager {
  constructor(options = {}) {
    if (!options.settingsStore) throw new TypeError("ProviderManager requires settingsStore");
    const providers = options.providers || [];
    this.registry = new Map(providers.map((provider) => [provider.id, provider]));
    if (this.registry.size === 0) throw new TypeError("ProviderManager requires providers");
    this.settingsStore = options.settingsStore;
    this.logger = options.logger || null;
    this.now = options.now || Date.now;
    this.setTimeout = options.setTimeout || globalThis.setTimeout;
    this.clearTimeout = options.clearTimeout || globalThis.clearTimeout;
    this.manualRefreshCooldownMs = options.manualRefreshCooldownMs ?? 60_000;
    this.settings = null;
    this.initializePromise = null;
    this.settingsMutationPromise = null;
    this.entries = new Map();
    this.running = false;
    this.stopping = false;
    this.timer = null;
    this.pollPromise = null;
    this.activeControllers = new Map();
    this.providerRevisions = new Map();
    this.lastManualRefresh = new Map();
    for (const id of this.registry.keys()) {
      this.providerRevisions.set(id, 0);
      this.entries.set(id, {
        snapshot: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
        consecutiveFailures: 0,
        refreshing: false,
      });
    }
  }

  async initialize() {
    if (!this.settings) {
      if (!this.initializePromise) {
        this.initializePromise = this.settingsStore.load().then((settings) => {
          this.settings = settings;
          return settings;
        });
      }
      try {
        await this.initializePromise;
      } finally {
        this.initializePromise = null;
      }
    }
    return this.getSettings();
  }

  getSettings() {
    if (!this.settings) throw new Error("ProviderManager is not initialized");
    return clone(this.settings);
  }

  async start() {
    await this.initialize();
    if (this.running) return this.pollPromise;
    this.stopping = false;
    this.running = true;
    return this.pollNow();
  }

  async pollNow(providerId = null, options = {}) {
    await this.initialize();
    if (providerId && !this.registry.has(providerId)) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    if (options.manual) {
      const key = providerId || "*";
      const previous = this.lastManualRefresh.get(key) || 0;
      const remainingMs = this.manualRefreshCooldownMs - (this.now() - previous);
      if (remainingMs > 0) {
        const error = new Error("Manual refresh is temporarily rate limited");
        error.code = "REFRESH_COOLDOWN";
        error.retryAfterSeconds = Math.ceil(remainingMs / 1_000);
        throw error;
      }
      this.lastManualRefresh.set(key, this.now());
    }
    this.#cancelTimer();
    const previous = this.pollPromise;
    const operation = (async () => {
      if (previous) await previous.catch(() => {});
      if (this.stopping) return {};
      return this.#poll(providerId);
    })();
    this.pollPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.pollPromise === operation) {
        this.pollPromise = null;
        if (this.running) this.#schedule(this.settings.pollIntervalSeconds * 1_000);
      }
    }
  }

  async #poll(providerId) {
    const ids = providerId ? [providerId] : [...this.registry.keys()];
    const results = {};
    for (const id of ids) {
      if (this.stopping) break;
      const provider = this.registry.get(id);
      const config = this.settings.providers[id] || { enabled: false };
      const entry = this.entries.get(id);
      if (!config.enabled) {
        results[id] = null;
        continue;
      }
      if (provider.isConfigured && !provider.isConfigured(config)) {
        entry.lastError = "尚未配置连接凭据";
        results[id] = null;
        continue;
      }
      entry.refreshing = true;
      entry.lastAttemptAt = this.now();
      const revision = this.providerRevisions.get(id);
      const controller = new AbortController();
      this.activeControllers.set(id, controller);
      try {
        const snapshot = await provider.collect(config, { signal: controller.signal });
        if (!snapshot || snapshot.id !== id || !Number.isFinite(snapshot.updatedAt)) {
          throw new Error("Provider returned an invalid snapshot");
        }
        if (revision !== this.providerRevisions.get(id)) {
          results[id] = null;
          continue;
        }
        entry.snapshot = clone(snapshot);
        entry.lastSuccessAt = snapshot.updatedAt;
        entry.lastError = null;
        entry.consecutiveFailures = 0;
        results[id] = clone(snapshot);
      } catch (error) {
        if (
          revision !== this.providerRevisions.get(id)
          || controller.signal.aborted
          || error?.code === "PROVIDER_BUSY"
          || error?.code === "CANCELLED"
        ) {
          results[id] = null;
          continue;
        }
        entry.lastError = safeProviderError(id, error);
        entry.consecutiveFailures += 1;
        results[id] = null;
        this.logger?.warn?.("Provider refresh failed", {
          provider: id,
          errorType: error?.name || "Error",
          consecutiveFailures: entry.consecutiveFailures,
        });
      } finally {
        if (this.activeControllers.get(id) === controller) {
          this.activeControllers.delete(id);
        }
        entry.refreshing = false;
      }
    }
    return results;
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
    if (!this.settings) return null;
    const staleAfterMs = this.settings.staleAfterSeconds * 1_000;
    const providers = [];
    for (const [id, provider] of this.registry) {
      const config = this.settings.providers[id];
      if (!config?.enabled || !provider.bridgeCompatible) continue;
      const snapshot = freshSnapshot(this.entries.get(id), staleAfterMs, now);
      if (snapshot?.bridgePayload) providers.push(clone(snapshot.bridgePayload));
    }
    return providers.length > 0 ? { limits: { providers } } : null;
  }

  getHealth(now = this.now()) {
    const stats = this.getStats(now);
    const enabled = this.settings
      ? [...this.registry.keys()].filter((id) => this.settings.providers[id]?.enabled)
      : [];
    const failures = [...this.entries.values()].reduce(
      (sum, entry) => sum + entry.consecutiveFailures,
      0,
    );
    const latestSuccess = Math.max(
      0,
      ...[...this.entries.values()].map((entry) => entry.lastSuccessAt || 0),
    );
    const latestAttempt = Math.max(
      0,
      ...[...this.entries.values()].map((entry) => entry.lastAttemptAt || 0),
    );
    return {
      status: stats ? "ok" : "degraded",
      ready: Boolean(stats),
      fresh: Boolean(stats),
      running: this.running,
      enabledProviders: enabled.length,
      updatedAt: latestSuccess || null,
      lastAttemptAt: latestAttempt || null,
      consecutiveFailures: failures,
    };
  }

  getAdminState(now = this.now()) {
    if (!this.settings) throw new Error("ProviderManager is not initialized");
    const staleAfterMs = this.settings.staleAfterSeconds * 1_000;
    const providers = [];
    for (const [id, provider] of this.registry) {
      const config = this.settings.providers[id] || { enabled: false };
      const entry = this.entries.get(id);
      const snapshot = freshSnapshot(entry, staleAfterMs, now);
      const configured = provider.isConfigured ? provider.isConfigured(config) : true;
      let status = "idle";
      if (!config.enabled) status = "disabled";
      else if (!configured) status = "unconfigured";
      else if (entry.refreshing) status = "refreshing";
      else if (snapshot) status = snapshot.status || "ok";
      else if (entry.lastError) status = "error";
      else if (entry.snapshot) status = "stale";
      providers.push({
        id,
        displayName: provider.displayName,
        enabled: Boolean(config.enabled),
        configured,
        bridgeCompatible: Boolean(provider.bridgeCompatible),
        status,
        updatedAt: snapshot?.updatedAt ?? entry.lastSuccessAt,
        lastAttemptAt: entry.lastAttemptAt,
        error: entry.lastError,
        accountLabel: snapshot?.accountLabel ?? null,
        metrics: snapshot?.metrics ? clone(snapshot.metrics) : [],
        config: publicProviderConfig(id, config),
      });
    }
    return {
      productName: "VWatch Quota Hub",
      settings: {
        pollIntervalSeconds: this.settings.pollIntervalSeconds,
        staleAfterSeconds: this.settings.staleAfterSeconds,
      },
      bridge: {
        ready: Boolean(this.getStats(now)),
        endpoint: "/api/stats",
        secretConfigured: true,
        compatibleProviders: providers.filter(
          (provider) => provider.enabled && provider.bridgeCompatible,
        ).length,
      },
      runtime: {
        rssBytes: process.memoryUsage().rss,
      },
      providers,
    };
  }

  async updateSettings(patch = {}) {
    await this.#mutateSettings((current) => ({
      ...current,
      pollIntervalSeconds: patch.pollIntervalSeconds ?? current.pollIntervalSeconds,
      staleAfterSeconds: patch.staleAfterSeconds ?? current.staleAfterSeconds,
    }));
    if (this.running) this.#schedule(this.settings.pollIntervalSeconds * 1_000);
    return this.getAdminState();
  }

  async updateProvider(providerId, patch = {}) {
    await this.initialize();
    if (!this.registry.has(providerId)) throw new Error(`Unknown provider: ${providerId}`);
    let changed = false;
    await this.#mutateSettings((settings) => {
      const current = settings.providers[providerId] || { enabled: false };
      const nextProvider = { ...current };
      if (patch.enabled !== undefined) nextProvider.enabled = Boolean(patch.enabled);
      if (providerId === "openrouter") {
        if (typeof patch.apiKey === "string" && patch.apiKey.trim()) {
          nextProvider.apiKey = patch.apiKey.trim();
        }
        if (patch.clearApiKey === true) nextProvider.apiKey = "";
        if (patch.mode !== undefined) nextProvider.mode = String(patch.mode);
      }
      changed = JSON.stringify(current) !== JSON.stringify(nextProvider);
      return {
        ...settings,
        providers: {
          ...settings.providers,
          [providerId]: nextProvider,
        },
      };
    });
    if (changed) {
      this.invalidateProvider(providerId);
      const provider = this.registry.get(providerId);
      const config = this.settings.providers[providerId];
      if (this.running && config?.enabled && (!provider.isConfigured || provider.isConfigured(config))) {
        void this.pollNow(providerId).catch(() => {});
      }
    }
    return this.getAdminState();
  }

  invalidateProvider(providerId) {
    if (!this.registry.has(providerId)) throw new Error(`Unknown provider: ${providerId}`);
    this.providerRevisions.set(providerId, this.providerRevisions.get(providerId) + 1);
    this.activeControllers.get(providerId)?.abort();
    const entry = this.entries.get(providerId);
    entry.snapshot = null;
    entry.lastSuccessAt = null;
    entry.lastError = null;
    entry.consecutiveFailures = 0;
  }

  async #mutateSettings(mutator) {
    await this.initialize();
    const previous = this.settingsMutationPromise;
    const operation = (async () => {
      if (previous) await previous.catch(() => {});
      const next = mutator(clone(this.settings));
      const saved = await this.settingsStore.update(next);
      this.settings = saved;
      return saved;
    })();
    this.settingsMutationPromise = operation;
    return operation;
  }

  getProvider(providerId) {
    return this.registry.get(providerId) || null;
  }

  async stop() {
    this.running = false;
    this.stopping = true;
    this.#cancelTimer();
    for (const controller of this.activeControllers.values()) controller.abort();
    for (const provider of this.registry.values()) {
      await provider.loginManager?.cancel?.().catch(() => {});
      await provider.stop?.().catch(() => {});
    }
    if (this.pollPromise) await this.pollPromise.catch(() => {});
  }
}
