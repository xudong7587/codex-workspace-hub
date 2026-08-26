import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
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
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 64 * 1_024;
const MIN_ADMIN_PASSWORD_LENGTH = 12;
const MAX_ADMIN_PASSWORD_BYTES = 1_024;
const SCRYPT_OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 32 * 1_024 * 1_024 });

function strongRandomSecret() {
  return randomBytes(32).toString("hex");
}

function validateAdminPassword(value) {
  if (typeof value !== "string") throw new Error("管理密码无效");
  if (value.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(`管理密码至少需要 ${MIN_ADMIN_PASSWORD_LENGTH} 个字符`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_ADMIN_PASSWORD_BYTES) throw new Error("管理密码过长");
  return value;
}

function validateSecret(value, name) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must be at least 32 bytes`);
  }
  return value;
}

async function passwordRecord(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(validateAdminPassword(password), salt, 32, SCRYPT_OPTIONS);
  return { salt: salt.toString("base64"), hash: hash.toString("base64") };
}

async function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash || typeof password !== "string") return false;
  try {
    const expected = Buffer.from(record.hash, "base64");
    const actual = await scrypt(password, Buffer.from(record.salt, "base64"), expected.length, SCRYPT_OPTIONS);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function validateState(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("Unsupported credentials file format");
  }
  validateSecret(value.encryptionSecret, "Internal encryption secret");
  validateSecret(value.bridgeSecret, "Bridge secret");
  if (value.admin !== null && (
    typeof value.admin !== "object"
    || typeof value.admin.salt !== "string"
    || typeof value.admin.hash !== "string"
  )) {
    throw new Error("Invalid admin credential record");
  }
  return value;
}

async function syncParentDirectory(filePath) {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await open(dirname(filePath), "r");
    await handle.sync();
  } catch {
    // Best effort on filesystems that do not support directory fsync.
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export class CredentialStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || "/data";
    this.filePath = options.filePath || join(this.dataDir, "credentials.json");
    this.initialAdminPassword = options.initialAdminPassword || "";
    this.initialBridgeSecret = options.initialBridgeSecret || "";
    this.state = null;
    this.writePromise = Promise.resolve();
    this.setupPromise = Promise.resolve();
  }

  async initialize() {
    if (this.state) return this.getStatus();
    try {
      const metadata = await stat(this.filePath);
      if (metadata.size > MAX_FILE_BYTES) throw new Error("Credentials file is too large");
      const raw = await readFile(this.filePath);
      if (raw.byteLength > MAX_FILE_BYTES) throw new Error("Credentials file is too large");
      this.state = validateState(JSON.parse(raw.toString("utf8")));
      return this.getStatus();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const admin = this.initialAdminPassword
      ? await passwordRecord(this.initialAdminPassword)
      : null;
    this.state = {
      schemaVersion: SCHEMA_VERSION,
      encryptionSecret: strongRandomSecret(),
      bridgeSecret: this.initialBridgeSecret
        ? validateSecret(this.initialBridgeSecret, "TOKEN_MONITOR_SECRET")
        : strongRandomSecret(),
      admin,
    };
    await this.save();
    return this.getStatus();
  }

  getStatus() {
    if (!this.state) throw new Error("CredentialStore must be initialized before use");
    return { setupRequired: this.state.admin === null };
  }

  getEncryptionSecret() {
    if (!this.state) throw new Error("CredentialStore must be initialized before use");
    return this.state.encryptionSecret;
  }

  getBridgeSecret() {
    if (!this.state) throw new Error("CredentialStore must be initialized before use");
    return this.state.bridgeSecret;
  }

  async completeSetup(adminPassword) {
    let result;
    this.setupPromise = this.setupPromise.catch(() => {}).then(async () => {
      if (!this.state) throw new Error("CredentialStore must be initialized before use");
      if (this.state.admin !== null) {
        const error = new Error("初始化已经完成");
        error.code = "SETUP_COMPLETE";
        throw error;
      }
      this.state.admin = await passwordRecord(adminPassword);
      await this.save();
      result = this.getStatus();
    });
    await this.setupPromise;
    return result;
  }

  async authenticateAdmin(adminPassword) {
    if (!this.state?.admin) return false;
    return verifyPassword(adminPassword, this.state.admin);
  }

  async rotateBridgeSecret() {
    if (!this.state) throw new Error("CredentialStore must be initialized before use");
    this.state.bridgeSecret = strongRandomSecret();
    await this.save();
    return this.state.bridgeSecret;
  }

  async save() {
    const body = `${JSON.stringify(validateState(this.state))}\n`;
    this.writePromise = this.writePromise.catch(() => {}).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
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

export { MIN_ADMIN_PASSWORD_LENGTH };
