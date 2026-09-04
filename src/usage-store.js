import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = 2;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COUNTER = 10 ** 16;
const PERIOD_NAMES = Object.freeze(["day", "week", "month", "total"]);
const COLLECTOR_ONLINE_MS = 15 * 60_000;

function finiteNumber(value, name, { min = 0, max = MAX_COUNTER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${name} must be a finite number between ${min} and ${max}`);
  }
  return number;
}

function optionalCounter(value, name) {
  if (value === null || value === undefined || value === "") return 0;
  return Math.round(finiteNumber(value, name));
}

function cleanKey(value, fallback, pattern) {
  const text = typeof value === "string" ? value.trim() : "";
  return pattern.test(text) ? text : fallback;
}

function normalizePeriod(value, name) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    totalTokens: optionalCounter(input.totalTokens, `${name}.totalTokens`),
    inputTokens: optionalCounter(input.inputTokens, `${name}.inputTokens`),
    cacheReadTokens: optionalCounter(input.cacheReadTokens, `${name}.cacheReadTokens`),
    cacheWriteTokens: optionalCounter(input.cacheWriteTokens, `${name}.cacheWriteTokens`),
    outputTokens: optionalCounter(input.outputTokens, `${name}.outputTokens`),
    reasoningTokens: optionalCounter(input.reasoningTokens, `${name}.reasoningTokens`),
    messageCount: optionalCounter(input.messageCount, `${name}.messageCount`),
    costUsd: finiteNumber(input.costUsd ?? 0, `${name}.costUsd`, { max: 10 ** 9 }),
  };
}

function emptyPeriod() {
  return normalizePeriod({}, "empty");
}

function addPeriod(target, value) {
  for (const key of Object.keys(target)) target[key] += value[key] || 0;
}

export function normalizeUsageSnapshot(value, now = Date.now()) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const capturedAt = Date.parse(input.capturedAt || "");
  const date = new Date(Number.isFinite(capturedAt) ? capturedAt : now);
  const dayFallback = date.toISOString().slice(0, 10);
  const monthFallback = dayFallback.slice(0, 7);
  const periods = {};
  for (const name of PERIOD_NAMES) {
    const fallback = name === "week" ? input.periods?.day : null;
    periods[name] = normalizePeriod(input.periods?.[name] || fallback, name);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    source: new Set(["tokscale", "codex-plugin", "cw-usage-reporter", "codex-workspace-collector"]).has(input.source)
      ? input.source
      : "codex-workspace-collector",
    capturedAt: date.toISOString(),
    importedAt: new Date(now).toISOString(),
    dayKey: cleanKey(input.dayKey, dayFallback, /^\d{4}-\d{2}-\d{2}$/),
    weekKey: cleanKey(input.weekKey, input.dayKey || dayFallback, /^\d{4}-W\d{2}$/),
    monthKey: cleanKey(input.monthKey, monthFallback, /^\d{4}-\d{2}$/),
    usdCnyRate: finiteNumber(input.usdCnyRate ?? 7.2, "usdCnyRate", { min: 1, max: 20 }),
    periods,
    models: input.models && typeof input.models === "object" && !Array.isArray(input.models)
      ? structuredClone(input.models)
      : {},
  };
}

function normalizeDeviceId(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(text)) throw new Error("deviceId is invalid");
  return text;
}

function aggregateDevices(devices) {
  const values = Object.entries(devices || {}).map(([deviceId, snapshot]) => ({
    deviceId,
    ...normalizeUsageSnapshot(snapshot),
  }));
  if (values.length === 0) return null;
  const latest = values.reduce((winner, item) => (
    Date.parse(item.capturedAt) > Date.parse(winner.capturedAt) ? item : winner
  ));
  const periods = Object.fromEntries(PERIOD_NAMES.map((name) => [name, emptyPeriod()]));
  const models = {};
  for (const item of values) {
    if (item.dayKey === latest.dayKey) addPeriod(periods.day, item.periods.day);
    if (item.weekKey === latest.weekKey) addPeriod(periods.week, item.periods.week);
    if (item.monthKey === latest.monthKey) addPeriod(periods.month, item.periods.month);
    addPeriod(periods.total, item.periods.total);
    for (const [model, modelUsage] of Object.entries(item.models || {})) {
      const current = models[model] || emptyPeriod();
      addPeriod(current, normalizePeriod(modelUsage, `models.${model}`));
      models[model] = current;
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    source: values.every((item) => item.source === values[0].source) ? values[0].source : "mixed",
    capturedAt: latest.capturedAt,
    importedAt: new Date().toISOString(),
    dayKey: latest.dayKey,
    weekKey: latest.weekKey,
    monthKey: latest.monthKey,
    usdCnyRate: latest.usdCnyRate,
    periods,
    models,
    deviceCount: values.length,
    devices: values.map((item) => ({
      id: item.deviceId,
      capturedAt: item.capturedAt,
      totalTokens: item.periods.total.totalTokens,
      costUsd: item.periods.total.costUsd,
    })),
  };
}

function codexQuotaWindow(stats) {
  const providers = Array.isArray(stats?.limits?.providers) ? stats.limits.providers : [];
  const codex = providers.find((provider) => provider?.provider === "codex");
  const windows = Array.isArray(codex?.windows) ? codex.windows : [];
  const window = windows.find((item) => item?.kind === "weekly")
    || windows.find((item) => item?.kind === "session");
  const usedPercent = Number(window?.usedPercent);
  if (!Number.isFinite(usedPercent)) return null;
  return {
    kind: window.kind || "unknown",
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    resetsAt: typeof window.resetsAt === "string" ? window.resetsAt : null,
  };
}

function periodRatio(period, fallback) {
  const tokens = Number(period?.totalTokens) || 0;
  const cost = Number(period?.costUsd) || 0;
  return tokens > 0 && cost > 0 ? cost / tokens : fallback;
}

function boundedRate(value, fallback) {
  return Number.isFinite(value) && value >= 1_000 && value <= 10 ** 10 ? value : fallback;
}

function currentKeys(now) {
  const date = new Date(now);
  const day = date.toISOString().slice(0, 10);
  const weekDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = weekDate.getUTCDay() || 7;
  weekDate.setUTCDate(weekDate.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(weekDate.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((weekDate - yearStart) / 86_400_000) + 1) / 7);
  return { day, week: `${weekDate.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, month: day.slice(0, 7) };
}

function addProjectedUsage(period, tokenDelta, costDelta) {
  if (!period || tokenDelta <= 0) return;
  period.totalTokens = Math.round((Number(period.totalTokens) || 0) + tokenDelta);
  period.costUsd = Math.max(0, Number(period.costUsd) || 0) + costDelta;
  period.estimated = true;
}

export function projectUsageSnapshot(exactUsage, quotaStats, previousState, now = Date.now()) {
  if (!exactUsage?.periods?.total) return { usage: exactUsage || null, state: previousState || null };
  const usage = structuredClone(exactUsage);
  const capturedAt = Date.parse(usage.capturedAt || "");
  const collectorOnline = Number.isFinite(capturedAt) && Math.max(0, now - capturedAt) <= COLLECTOR_ONLINE_MS;
  const quota = codexQuotaWindow(quotaStats);
  let state = previousState && typeof previousState === "object" ? structuredClone(previousState) : null;
  const exactChanged = state?.baselineCapturedAt !== usage.capturedAt;

  if (collectorOnline || exactChanged || !state) {
    let tokensPerPercent = boundedRate(state?.tokensPerPercent, null);
    if (state && exactChanged && quota && state.lastQuota?.resetsAt === quota.resetsAt) {
      const quotaDelta = quota.usedPercent - Number(state.lastQuota.usedPercent || 0);
      const tokenDelta = Number(usage.periods.total.totalTokens || 0) - Number(state.baselineTotalTokens || 0);
      if (quotaDelta > 0.01 && tokenDelta > 0) {
        const sample = boundedRate(tokenDelta / quotaDelta, null);
        if (sample) tokensPerPercent = tokensPerPercent ? (tokensPerPercent * 0.65) + (sample * 0.35) : sample;
      }
    }
    if (!tokensPerPercent && quota?.usedPercent > 0) {
      tokensPerPercent = boundedRate(Number(usage.periods.week?.totalTokens || 0) / quota.usedPercent, null);
    }
    state = {
      baselineCapturedAt: usage.capturedAt,
      baselineTotalTokens: Number(usage.periods.total.totalTokens) || 0,
      tokensPerPercent,
      costUsdPerToken: periodRatio(usage.periods.week, periodRatio(usage.periods.total, 4 / 1_000_000)),
      lastQuota: quota,
      accumulatedQuotaPercent: 0,
    };
  }

  usage.collectorOnline = collectorOnline;
  usage.collectorLastSeenAt = usage.capturedAt;
  if (collectorOnline) {
    usage.mode = "collector";
    usage.estimated = false;
    return { usage, state };
  }

  if (!quota || !state?.tokensPerPercent) {
    usage.mode = "collector_baseline";
    usage.estimated = false;
    return { usage, state };
  }

  const last = state.lastQuota;
  if (last) {
    const increment = last.resetsAt === quota.resetsAt
      ? Math.max(0, quota.usedPercent - Number(last.usedPercent || 0))
      : Math.max(0, quota.usedPercent);
    state.accumulatedQuotaPercent = Math.max(0, Number(state.accumulatedQuotaPercent) || 0) + increment;
  }
  state.lastQuota = quota;
  const tokenDelta = state.accumulatedQuotaPercent * state.tokensPerPercent;
  const costDelta = tokenDelta * (Number(state.costUsdPerToken) || (4 / 1_000_000));
  const keys = currentKeys(now);
  addProjectedUsage(usage.periods.total, tokenDelta, costDelta);
  if (usage.dayKey === keys.day) addProjectedUsage(usage.periods.day, tokenDelta, costDelta);
  if (usage.weekKey === keys.week) addProjectedUsage(usage.periods.week, tokenDelta, costDelta);
  if (usage.monthKey === keys.month) addProjectedUsage(usage.periods.month, tokenDelta, costDelta);
  usage.source = "hybrid";
  usage.mode = "hybrid_estimate";
  usage.estimated = true;
  usage.estimatedSince = usage.capturedAt;
  usage.estimateBasis = {
    provider: "codex",
    quotaWindow: quota.kind,
    quotaPercentDelta: state.accumulatedQuotaPercent,
    tokensPerPercent: state.tokensPerPercent,
  };
  return { usage, state };
}

export class UsageStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || "/data";
    this.filePath = options.filePath || join(this.dataDir, "usage-history.json");
    this.devices = {};
    this.projection = null;
    this.writePromise = Promise.resolve();
  }

  async initialize() {
    try {
      const raw = await readFile(this.filePath);
      if (raw.byteLength > MAX_FILE_BYTES) throw new Error("Usage history file is too large");
      const parsed = JSON.parse(raw.toString("utf8"));
      this.projection = parsed?.projection && typeof parsed.projection === "object"
        ? structuredClone(parsed.projection)
        : null;
      const snapshots = parsed?.snapshots || (parsed?.devices && !Array.isArray(parsed.devices) ? parsed.devices : null);
      if (parsed?.schemaVersion === SCHEMA_VERSION && snapshots) {
        for (const [id, value] of Object.entries(snapshots)) {
          this.devices[normalizeDeviceId(id)] = normalizeUsageSnapshot(value);
        }
      } else if (parsed?.periods) {
        this.devices.manual = normalizeUsageSnapshot(parsed);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this.get();
  }

  get() {
    return aggregateDevices(this.devices);
  }

  async getProjected(quotaStats, now = Date.now()) {
    const previous = JSON.stringify(this.projection);
    const projected = projectUsageSnapshot(this.get(), quotaStats, this.projection, now);
    this.projection = projected.state;
    if (JSON.stringify(this.projection) !== previous) await this.persist();
    return projected.usage;
  }

  async replace(value) {
    return this.ingest("manual", value);
  }

  async ingest(deviceId, value) {
    const id = normalizeDeviceId(deviceId);
    if (id !== "manual") delete this.devices.manual;
    this.devices[id] = normalizeUsageSnapshot(value);
    await this.persist();
    return this.get();
  }

  async forgetDevice(deviceId) {
    const id = normalizeDeviceId(deviceId);
    const removed = Object.prototype.hasOwnProperty.call(this.devices, id);
    if (removed) {
      delete this.devices[id];
      await this.persist();
    }
    return { deviceId: id, removed, usage: this.get() };
  }

  async persist() {
    const aggregate = aggregateDevices(this.devices);
    const body = `${JSON.stringify({ ...aggregate, schemaVersion: SCHEMA_VERSION, snapshots: this.devices, projection: this.projection })}\n`;
    if (Buffer.byteLength(body) > MAX_FILE_BYTES) throw new Error("Usage history file is too large");
    this.writePromise = this.writePromise.catch(() => {}).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
      let created = false;
      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        created = true;
        try {
          await handle.writeFile(body, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporaryPath, this.filePath);
        created = false;
      } finally {
        if (created) await unlink(temporaryPath).catch(() => {});
      }
    });
    await this.writePromise;
  }
}

export const USAGE_SCHEMA_VERSION = SCHEMA_VERSION;
export const USAGE_PERIOD_NAMES = PERIOD_NAMES;
export const USAGE_COLLECTOR_ONLINE_MS = COLLECTOR_ONLINE_MS;
