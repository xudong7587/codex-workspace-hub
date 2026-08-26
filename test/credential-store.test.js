import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CredentialStore } from "../src/credential-store.js";

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "vwatch-credentials-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("credentials are generated on first start and the admin password is only stored as a hash", async () => {
  await withTemporaryDirectory(async (directory) => {
    const password = "correct horse battery staple";
    const store = new CredentialStore({ dataDir: directory });
    assert.deepEqual(await store.initialize(), { setupRequired: true });
    assert.match(store.getBridgeSecret(), /^[a-f0-9]{64}$/);
    assert.match(store.getEncryptionSecret(), /^[a-f0-9]{64}$/);

    await store.completeSetup(password);
    assert.equal(await store.authenticateAdmin(password), true);
    assert.equal(await store.authenticateAdmin("wrong password"), false);

    const raw = await readFile(join(directory, "credentials.json"), "utf8");
    assert.doesNotMatch(raw, new RegExp(password));
    assert.match(raw, /"salt":"/);
    assert.match(raw, /"hash":"/);
  });
});

test("credentials and bridge secret persist across restarts and can be rotated", async () => {
  await withTemporaryDirectory(async (directory) => {
    const first = new CredentialStore({ dataDir: directory });
    await first.initialize();
    await first.completeSetup("a sufficiently long password");
    const originalSecret = first.getBridgeSecret();

    const reloaded = new CredentialStore({ dataDir: directory });
    assert.deepEqual(await reloaded.initialize(), { setupRequired: false });
    assert.equal(reloaded.getBridgeSecret(), originalSecret);
    assert.equal(await reloaded.authenticateAdmin("a sufficiently long password"), true);

    const rotated = await reloaded.rotateBridgeSecret();
    assert.notEqual(rotated, originalSecret);
    const afterRotation = new CredentialStore({ dataDir: directory });
    await afterRotation.initialize();
    assert.equal(afterRotation.getBridgeSecret(), rotated);
  });
});

test("only one concurrent first-time setup can claim the service", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new CredentialStore({ dataDir: directory });
    await store.initialize();
    const outcomes = await Promise.allSettled([
      store.completeSetup("first secure password"),
      store.completeSetup("second secure password"),
    ]);
    assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
    assert.equal(
      await store.authenticateAdmin("first secure password")
        || await store.authenticateAdmin("second secure password"),
      true,
    );
  });
});
