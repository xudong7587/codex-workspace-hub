import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = 2;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COUNTER = 10 ** 16;
const PERIOD_NAMES = Object.freeze(["day", "week", "month", "total"]);

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
    source: input.source === "tokscale" ? "tokscale" : "vwatch-collector",
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
    source: "vwatch-collector",
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

export class UsageStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || "/data";
    this.filePath = options.filePath || join(this.dataDir, "usage-history.json");
    this.devices = {};
    this.writePromise = Promise.resolve();
  }

  async initialize() {
    try {
      const raw = await readFile(this.filePath);
      if (raw.byteLength > MAX_FILE_BYTES) throw new Error("Usage history file is too large");
      const parsed = JSON.parse(raw.toString("utf8"));
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

  async persist() {
    const aggregate = aggregateDevices(this.devices);
    const body = `${JSON.stringify({ ...aggregate, schemaVersion: SCHEMA_VERSION, snapshots: this.devices })}\n`;
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
