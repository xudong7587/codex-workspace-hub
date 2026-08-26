import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = 1;
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;
const MIN_POLL_SECONDS = 60;
const MAX_POLL_SECONDS = 86_400;
const MAX_STALE_SECONDS = 7 * 86_400;

function clone(value) {
  return structuredClone(value);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerInRange(value, fallback, min, max, name) {
  const number = finiteNumber(value);
  if (number === null) return fallback;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function cleanSecret(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function defaultRuntimeSettings(config = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    pollIntervalSeconds: Math.round((config.pollIntervalMs ?? 300_000) / 1_000),
    staleAfterSeconds: Math.round((config.staleAfterMs ?? 900_000) / 1_000),
    providers: {
      codex: {
        enabled: true,
      },
      openrouter: {
        enabled: false,
        apiKey: "",
        mode: "key",
      },
    },
  };
}

export function normalizeRuntimeSettings(value, defaults = defaultRuntimeSettings()) {
  const input = value && typeof value === "object" ? value : {};
  const pollIntervalSeconds = integerInRange(
    input.pollIntervalSeconds,
    defaults.pollIntervalSeconds,
    MIN_POLL_SECONDS,
    MAX_POLL_SECONDS,
    "pollIntervalSeconds",
  );
  const staleAfterSeconds = integerInRange(
    input.staleAfterSeconds,
    defaults.staleAfterSeconds,
    pollIntervalSeconds,
    MAX_STALE_SECONDS,
    "staleAfterSeconds",
  );
  const providers = input.providers && typeof input.providers === "object"
    ? input.providers
    : {};
  const openrouter = providers.openrouter && typeof providers.openrouter === "object"
    ? providers.openrouter
    : {};
  const codex = providers.codex && typeof providers.codex === "object"
    ? providers.codex
    : {};
  const openRouterMode = String(
    openrouter.mode ?? defaults.providers.openrouter.mode,
  ).trim().toLowerCase();
  if (!new Set(["key", "credits"]).has(openRouterMode)) {
    throw new Error("OpenRouter mode must be key or credits");
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    pollIntervalSeconds,
    staleAfterSeconds,
    providers: {
      codex: {
        enabled: codex.enabled === undefined
          ? defaults.providers.codex.enabled
          : Boolean(codex.enabled),
      },
      openrouter: {
        enabled: openrouter.enabled === undefined
          ? defaults.providers.openrouter.enabled
          : Boolean(openrouter.enabled),
        apiKey: cleanSecret(openrouter.apiKey ?? defaults.providers.openrouter.apiKey),
        mode: openRouterMode,
      },
    },
  };
}

function encryptionKey(encryptionSecret) {
  if (typeof encryptionSecret !== "string" || Buffer.byteLength(encryptionSecret, "utf8") < 32) {
    throw new Error("A strong settings encryption secret is required");
  }
  return createHash("sha256")
    .update("vwatch-quota-hub/settings/v1\0", "utf8")
    .update(encryptionSecret, "utf8")
    .digest();
}

function encryptSettings(settings, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(settings), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    schemaVersion: SCHEMA_VERSION,
    protected: {
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    },
  };
}

function decryptSettings(envelope, key) {
  if (
    envelope?.schemaVersion !== SCHEMA_VERSION
    || envelope?.protected?.algorithm !== "aes-256-gcm"
  ) {
    throw new Error("Unsupported settings file format");
  }
  try {
    const iv = Buffer.from(envelope.protected.iv, "base64");
    const tag = Buffer.from(envelope.protected.tag, "base64");
    const encrypted = Buffer.from(envelope.protected.data, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("Settings could not be decrypted with the configured encryption secret");
  }
}

function settingsFileTooLarge() {
  return new Error("Settings file exceeds the 1 MiB size limit");
}

async function syncParentDirectory(filePath) {
  if (process.platform === "win32") return;

  let handle;
  try {
    handle = await open(dirname(filePath), "r");
    await handle.sync();
  } catch {
    // Directory fsync is not supported by every filesystem. The file itself
    // has already been synced and renamed, so this durability step is best-effort.
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export class SettingsStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || "/data";
    this.filePath = options.filePath || join(this.dataDir, "config.json");
    this.defaults = normalizeRuntimeSettings(
      options.defaults || defaultRuntimeSettings(options.config),
    );
    this.key = encryptionKey(options.encryptionSecret || options.adminToken);
    this.value = null;
    this.writePromise = Promise.resolve();
  }

  async load() {
    try {
      const metadata = await stat(this.filePath);
      if (metadata.size > MAX_SETTINGS_FILE_BYTES) throw settingsFileTooLarge();
      const raw = await readFile(this.filePath);
      if (raw.byteLength > MAX_SETTINGS_FILE_BYTES) throw settingsFileTooLarge();
      this.value = normalizeRuntimeSettings(
        decryptSettings(JSON.parse(raw.toString("utf8")), this.key),
        this.defaults,
      );
      return this.get();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.value = clone(this.defaults);
      await this.save(this.value);
      return this.get();
    }
  }

  get() {
    if (!this.value) throw new Error("SettingsStore must be loaded before use");
    return clone(this.value);
  }

  async update(nextValue) {
    const normalized = normalizeRuntimeSettings(nextValue, this.defaults);
    await this.save(normalized);
    this.value = normalized;
    return this.get();
  }

  async save(value) {
    const normalized = normalizeRuntimeSettings(value, this.defaults);
    const envelope = encryptSettings(normalized, this.key);
    const body = `${JSON.stringify(envelope)}\n`;
    this.writePromise = this.writePromise.catch(() => {}).then(async () => {
      const parentDirectory = dirname(this.filePath);
      await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
      let temporaryCreated = false;
      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        temporaryCreated = true;
        try {
          await handle.writeFile(body, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporaryPath, this.filePath);
        temporaryCreated = false;
        await syncParentDirectory(this.filePath);
      } finally {
        if (temporaryCreated) await unlink(temporaryPath).catch(() => {});
      }
    });
    await this.writePromise;
  }
}

export const SETTINGS_SCHEMA_VERSION = SCHEMA_VERSION;
