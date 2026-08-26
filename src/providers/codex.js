import { randomUUID } from "node:crypto";

import { buildStatsPayload } from "../quota-service.js";

function publicLoginState(state) {
  if (!state) return { status: "idle" };
  return {
    id: state.id,
    status: state.status,
    verificationUrl: state.verificationUrl ?? null,
    userCode: state.userCode ?? null,
    expiresAt: state.expiresAt ?? null,
    error: state.error ?? null,
  };
}

function requestedLoginId(value) {
  if (value === undefined || value === null || value === "") return randomUUID();
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value)) {
    throw new TypeError("Invalid Codex login session id");
  }
  return value;
}

function loginWaiter(client, timeoutMs) {
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
  const onExit = () => settle(rejectWait, new Error("Codex login process exited"));
  const promise = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  client.on("account/login/completed", onCompleted);
  client.once("exit", onExit);
  timer = setTimeout(() => {
    settle(rejectWait, new Error("Codex device-code login timed out"));
  }, timeoutMs);
  timer.unref?.();
  return {
    promise,
    setLoginId(loginId) {
      expectedLoginId = loginId;
      const early = buffered.find((params) => params?.loginId === loginId);
      buffered = [];
      if (early) settle(resolveWait, early);
    },
    cancel(settlePromise = false) {
      if (settled) return;
      if (settlePromise) {
        settle(resolveWait, { success: false, cancelled: true });
        return;
      }
      settled = true;
      buffered = [];
      cleanup();
    },
  };
}

export async function collectCodexQuota(options = {}) {
  if (typeof options.clientFactory !== "function") {
    throw new TypeError("collectCodexQuota requires clientFactory");
  }
  const now = options.now || Date.now;
  const signal = options.signal;
  if (signal?.aborted) {
    const error = new Error("Codex quota refresh was cancelled");
    error.code = "CANCELLED";
    throw error;
  }
  const client = options.clientFactory();
  const onAbort = () => {
    void client.stop().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await client.start();
    const [account, rateLimits] = await Promise.all([
      client.request("account/read", { refreshToken: false }),
      client.request("account/rateLimits/read"),
    ]);
    if (!account?.account) throw new Error("Codex is not logged in");
    const updatedAt = now();
    const bridge = buildStatsPayload({
      account,
      rateLimits,
      updatedAt,
      now: updatedAt,
      staleAfterMs: Number.MAX_SAFE_INTEGER,
    })?.limits?.providers?.[0];
    if (!bridge) throw new Error("Codex returned an incomplete quota snapshot");
    return {
      id: "codex",
      displayName: "Codex",
      status: bridge.status,
      updatedAt,
      accountLabel: bridge.accountLabel,
      bridgeCompatible: true,
      bridgePayload: bridge,
      metrics: bridge.windows.map((window) => ({
        metricType: "subscription_quota",
        label: window.kind === "session" ? "短窗口" : "周额度",
        window: window.kind,
        value: window.usedPercent,
        limit: 100,
        remaining: Math.max(0, 100 - window.usedPercent),
        unit: "percent",
        percentageSource: "native",
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt ?? null,
      })),
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await client.stop().catch(() => {});
  }
}

export class CodexLoginManager {
  constructor(options = {}) {
    if (typeof options.clientFactory !== "function") {
      throw new TypeError("CodexLoginManager requires clientFactory");
    }
    this.clientFactory = options.clientFactory;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    this.logger = options.logger || null;
    this.beforeBegin = options.beforeBegin || (async () => {});
    this.session = null;
    this.beginPromise = null;
    this.cancelEpoch = 0;
  }

  getState() {
    return publicLoginState(this.session);
  }

  async begin(options = {}) {
    if (this.beginPromise) return this.beginPromise;
    if (["starting", "waiting", "finishing"].includes(this.session?.status)) {
      return this.getState();
    }
    const operation = this.#begin(options);
    this.beginPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.beginPromise === operation) this.beginPromise = null;
    }
  }

  async #begin(options) {
    const beginEpoch = this.cancelEpoch;
    await this.#cancelSession();
    if (beginEpoch !== this.cancelEpoch) return this.getState();
    const state = {
      id: requestedLoginId(options.sessionId),
      status: "starting",
      verificationUrl: null,
      userCode: null,
      expiresAt: Date.now() + this.timeoutMs,
      error: null,
      client: null,
      waiter: null,
    };
    this.session = state;
    try {
      await this.beforeBegin();
      if (state.status === "cancelled" || this.session !== state) return publicLoginState(state);
      const client = this.clientFactory();
      state.client = client;
      await client.start();
      if (state.status === "cancelled" || this.session !== state) {
        await client.stop().catch(() => {});
        delete state.client;
        delete state.waiter;
        return publicLoginState(state);
      }
      state.waiter = loginWaiter(client, this.timeoutMs);
      const login = await client.request("account/login/start", { type: "chatgptDeviceCode" });
      if (state.status === "cancelled" || this.session !== state) {
        state.waiter.cancel(true);
        await client.stop().catch(() => {});
        delete state.client;
        delete state.waiter;
        return publicLoginState(state);
      }
      if (login?.type !== "chatgptDeviceCode" || !login.loginId) {
        throw new Error("Codex did not return a device-code login challenge");
      }
      state.waiter.setLoginId(login.loginId);
      state.verificationUrl = login.verificationUrl;
      state.userCode = login.userCode;
      state.status = "waiting";
      state.finishPromise = this.#finish(state);
      void state.finishPromise;
      return this.getState();
    } catch (error) {
      if (state.status !== "cancelled") {
        state.status = "error";
        state.error = "无法启动 Codex 登录，请检查网络和 Codex 配置";
      }
      state.waiter?.cancel(false);
      await state.client?.stop?.().catch(() => {});
      delete state.client;
      delete state.waiter;
      if (state.status !== "cancelled") {
        this.logger?.warn?.("Codex login start failed", { errorType: error?.name || "Error" });
      }
      return this.getState();
    }
  }

  async #finish(state) {
    let finalStatus = "error";
    let finalError = "Codex 登录未完成";
    try {
      const completed = await state.waiter.promise;
      if (state.status !== "cancelled") state.status = "finishing";
      if (completed?.success) {
        finalStatus = "complete";
        finalError = null;
      } else if (completed?.cancelled) {
        finalStatus = "cancelled";
        finalError = null;
      }
    } catch (error) {
      if (state.status !== "cancelled") state.status = "finishing";
      finalStatus = "error";
      finalError = "Codex 登录已超时或连接中断";
      this.logger?.warn?.("Codex login failed", { errorType: error?.name || "Error" });
    } finally {
      state.waiter?.cancel(false);
      await state.client.stop().catch(() => {});
      delete state.client;
      delete state.waiter;
    }
    if (state.status === "cancelled") {
      finalStatus = "cancelled";
      finalError = null;
    }
    state.status = finalStatus;
    state.error = finalError;
    delete state.finishPromise;
  }

  async cancel() {
    this.cancelEpoch += 1;
    const operation = this.beginPromise;
    await this.#cancelSession();
    if (operation) await operation.catch(() => {});
  }

  async #cancelSession() {
    const state = this.session;
    if (!state) return;
    if (state.status === "starting" || state.status === "waiting") {
      state.status = "cancelled";
      state.error = null;
    }
    state.waiter?.cancel(true);
    await state.client?.stop?.().catch(() => {});
    await state.finishPromise?.catch(() => {});
  }
}

export function createCodexProvider(options = {}) {
  let collectPromise = null;
  const loginManager = options.loginManager || new CodexLoginManager({
    ...options,
    beforeBegin: async () => {
      if (collectPromise) await collectPromise.catch(() => {});
      await options.beforeBegin?.();
    },
  });
  return {
    id: "codex",
    displayName: "Codex",
    bridgeCompatible: true,
    isConfigured: () => true,
    collect: async (_config, context = {}) => {
      const loginStatus = loginManager.getState().status;
      if (["starting", "waiting", "finishing"].includes(loginStatus)) {
        const error = new Error("Codex login is in progress");
        error.code = "PROVIDER_BUSY";
        throw error;
      }
      const operation = collectCodexQuota({ ...options, signal: context.signal });
      collectPromise = operation;
      try {
        return await operation;
      } finally {
        if (collectPromise === operation) collectPromise = null;
      }
    },
    loginManager,
  };
}
