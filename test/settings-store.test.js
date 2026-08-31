import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SettingsStore,
  defaultRuntimeSettings,
  normalizeRuntimeSettings,
} from "../src/settings-store.js";

const ADMIN_TOKEN_A = "admin-token-a-0123456789abcdef0123456789abcdef";
const ADMIN_TOKEN_B = "admin-token-b-fedcba9876543210fedcba9876543210";

function legacySettingsEnvelope(settings, encryptionSecret) {
  const key = createHash("sha256")
    .update("vwatch-quota-hub/settings/v1\0", "utf8")
    .update(encryptionSecret, "utf8")
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(settings), "utf8")),
    cipher.final(),
  ]);
  return {
    schemaVersion: 1,
    protected: {
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    },
  };
}

async function temporaryDataDir(t) {
  const directory = await mkdtemp(join(tmpdir(), "cw-settings-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("runtime settings default to a five-minute poll and fifteen-minute stale window", () => {
  const defaults = defaultRuntimeSettings();

  assert.equal(defaults.pollIntervalSeconds, 300);
  assert.equal(defaults.staleAfterSeconds, 900);
  assert.equal(defaults.refreshWindowStart, "00:00");
  assert.equal(defaults.refreshWindowEnd, "00:00");
  assert.deepEqual(normalizeRuntimeSettings({}), defaults);
});

test("runtime timing and provider settings are validated before persistence", () => {
  assert.throws(
    () => normalizeRuntimeSettings({ pollIntervalSeconds: 59 }),
    /pollIntervalSeconds must be an integer between 60 and 86400/i,
  );
  assert.throws(
    () => normalizeRuntimeSettings({
      pollIntervalSeconds: 600,
      staleAfterSeconds: 599,
    }),
    /staleAfterSeconds must be an integer between 600/i,
  );
  assert.throws(
    () => normalizeRuntimeSettings({ providers: { openrouter: { mode: "unknown" } } }),
    /mode must be key or credits/i,
  );
  assert.throws(
    () => normalizeRuntimeSettings({ refreshWindowStart: "24:00" }),
    /refreshWindowStart must use the HH:mm format/i,
  );

  const normalized = normalizeRuntimeSettings({
    pollIntervalSeconds: 600,
    staleAfterSeconds: 1_800,
    refreshWindowStart: "07:30",
    refreshWindowEnd: "23:15",
    providers: {
      codex: { enabled: false },
      openrouter: { enabled: true, apiKey: "  sk-or-test  ", mode: "credits" },
    },
  });
  assert.equal(normalized.pollIntervalSeconds, 600);
  assert.equal(normalized.staleAfterSeconds, 1_800);
  assert.equal(normalized.refreshWindowStart, "07:30");
  assert.equal(normalized.refreshWindowEnd, "23:15");
  assert.deepEqual(normalized.providers, {
    codex: { enabled: false },
    openrouter: { enabled: true, apiKey: "sk-or-test", mode: "credits" },
  });
});

test("settings file encrypts provider API keys instead of storing plaintext", async (t) => {
  const dataDir = await temporaryDataDir(t);
  const apiKey = "test-provider-secret-value";
  const store = new SettingsStore({ dataDir, adminToken: ADMIN_TOKEN_A });
  await store.load();
  await store.update({
    pollIntervalSeconds: 300,
    staleAfterSeconds: 900,
    providers: {
      codex: { enabled: true },
      openrouter: { enabled: true, apiKey, mode: "key" },
    },
  });

  const raw = await readFile(join(dataDir, "config.json"), "utf8");
  assert.equal(raw.includes(apiKey), false);
  assert.equal(raw.includes("openrouter"), false);
  const envelope = JSON.parse(raw);
  assert.equal(envelope.protected.algorithm, "aes-256-gcm");
  assert.equal(typeof envelope.protected.data, "string");

  const reopened = new SettingsStore({ dataDir, adminToken: ADMIN_TOKEN_A });
  assert.equal((await reopened.load()).providers.openrouter.apiKey, apiKey);
});

test("legacy settings are read once and re-encrypted with the CW identity", async (t) => {
  const dataDir = await temporaryDataDir(t);
  const settings = {
    ...defaultRuntimeSettings(),
    providers: {
      codex: { enabled: true },
      openrouter: { enabled: true, apiKey: "legacy-openrouter-key", mode: "key" },
    },
  };
  const legacyBody = `${JSON.stringify(legacySettingsEnvelope(settings, ADMIN_TOKEN_A))}\n`;
  await writeFile(join(dataDir, "config.json"), legacyBody, "utf8");

  const store = new SettingsStore({ dataDir, adminToken: ADMIN_TOKEN_A });
  assert.equal((await store.load()).providers.openrouter.apiKey, "legacy-openrouter-key");
  const migratedBody = await readFile(join(dataDir, "config.json"), "utf8");
  assert.notEqual(migratedBody, legacyBody);

  const reopened = new SettingsStore({ dataDir, adminToken: ADMIN_TOKEN_A });
  assert.equal((await reopened.load()).providers.openrouter.apiKey, "legacy-openrouter-key");
});

test("a different admin token cannot decrypt an existing settings file", async (t) => {
  const dataDir = await temporaryDataDir(t);
  const original = new SettingsStore({ dataDir, adminToken: ADMIN_TOKEN_A });
  await original.load();

  const wrongTokenStore = new SettingsStore({ dataDir, adminToken: ADMIN_TOKEN_B });
  await assert.rejects(
    wrongTokenStore.load(),
    /could not be decrypted|HUB_ADMIN_TOKEN/i,
  );
});

test("settings files larger than 1 MiB are rejected before parsing", async (t) => {
  const dataDir = await temporaryDataDir(t);
  await writeFile(join(dataDir, "config.json"), Buffer.alloc((1024 * 1024) + 1));
  const store = new SettingsStore({ dataDir, adminToken: ADMIN_TOKEN_A });

  await assert.rejects(store.load(), /1 MiB size limit/i);
});

test("a failed atomic replace removes its temporary settings file", async (t) => {
  const dataDir = await temporaryDataDir(t);
  const blockedTarget = join(dataDir, "config.json");
  await mkdir(blockedTarget);
  const store = new SettingsStore({
    dataDir,
    filePath: blockedTarget,
    adminToken: ADMIN_TOKEN_A,
  });

  await assert.rejects(store.save(defaultRuntimeSettings()));
  const names = await readdir(dataDir);
  assert.deepEqual(
    names.filter((name) => name.startsWith("config.json.tmp-")),
    [],
  );
});
