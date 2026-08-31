import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_COUNTER = 10 ** 16;

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

function cleanKey(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^\d{4}-(?:\d{2})(?:-\d{2})?$/.test(text) ? text : fallback;
}

function normalizePeriod(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} usage is required`);
  }
  return {
    totalTokens: optionalCounter(value.totalTokens, `${name}.totalTokens`),
    inputTokens: optionalCounter(value.inputTokens, `${name}.inputTokens`),
    cacheReadTokens: optionalCounter(value.cacheReadTokens, `${name}.cacheReadTokens`),
    cacheWriteTokens: optionalCounter(value.cacheWriteTokens, `${name}.cacheWriteTokens`),
    outputTokens: optionalCounter(value.outputTokens, `${name}.outputTokens`),
    reasoningTokens: optionalCounter(value.reasoningTokens, `${name}.reasoningTokens`),
    messageCount: optionalCounter(value.messageCount, `${name}.messageCount`),
    costUsd: finiteNumber(value.costUsd ?? 0, `${name}.costUsd`, { max: 10 ** 9 }),
  };
}

export function normalizeUsageSnapshot(value, now = Date.now()) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const capturedAt = Date.parse(input.capturedAt || "");
  const importedAt = Date.parse(input.importedAt || "");
  const date = new Date(Number.isFinite(capturedAt) ? capturedAt : now);
  const dayFallback = date.toISOString().slice(0, 10);
  return {
    schemaVersion: SCHEMA_VERSION,
    source: input.source === "tokscale" ? "tokscale" : "token-monitor",
    capturedAt: date.toISOString(),
    importedAt: new Date(Number.isFinite(importedAt) ? importedAt : now).toISOString(),
    dayKey: cleanKey(input.dayKey, dayFallback),
    monthKey: cleanKey(input.monthKey, dayFallback.slice(0, 7)),
    usdCnyRate: finiteNumber(input.usdCnyRate ?? 7.2, "usdCnyRate", { min: 1, max: 20 }),
    periods: {
      day: normalizePeriod(input.periods?.day, "day"),
      month: normalizePeriod(input.periods?.month, "month"),
      total: normalizePeriod(input.periods?.total, "total"),
    },
  };
}

export class UsageStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || "/data";
    this.filePath = options.filePath || join(this.dataDir, "usage-history.json");
    this.value = null;
    this.writePromise = Promise.resolve();
  }

  async initialize() {
    try {
      const raw = await readFile(this.filePath);
      if (raw.byteLength > MAX_FILE_BYTES) throw new Error("Usage history file is too large");
      this.value = normalizeUsageSnapshot(JSON.parse(raw.toString("utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.value = null;
    }
    return this.get();
  }

  get() {
    return this.value ? structuredClone(this.value) : null;
  }

  async replace(value) {
    const normalized = normalizeUsageSnapshot(value);
    const body = `${JSON.stringify(normalized)}\n`;
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
    this.value = normalized;
    return this.get();
  }
}

export const USAGE_SCHEMA_VERSION = SCHEMA_VERSION;
