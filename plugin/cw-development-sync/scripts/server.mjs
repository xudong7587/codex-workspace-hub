import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";

const execFile = promisify(execFileCallback);
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_PLAINTEXT_BYTES = 192 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const CONFIG_PATH = join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || ".", "AppData", "Local"), "CWDevelopmentSync", "config.json");
const BLOCKED_NAMES = new Set([".git", "node_modules", "vendor", ".gradle", ".idea", ".vscode", ".cache", "dist", "build", "out", "target", "bin", "obj", ".next", ".nuxt", "coverage", ".codex-sync-recovery", ".cw-recovery", ".cw-conflicts"]);
const BLOCKED_FILES = /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml)|.*\.(?:pfx|p12|pem|key|keystore|jks))$/i;

function textResult(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError };
}

function normalizePath(value) {
  const path = String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe relative path: ${value}`);
  return path;
}

function exclusionReason(path) {
  const normalized = normalizePath(path);
  const parts = normalized.toLowerCase().split("/");
  if (parts.some((part) => BLOCKED_NAMES.has(part))) return "dependency, cache, build, editor, or recovery directory";
  if (BLOCKED_FILES.test(normalized)) return "credential or secret file";
  if (normalized === ".cw-sync-state.json") return "local CW state";
  return null;
}

function safeLocalPath(root, path) {
  const normalized = normalizePath(path);
  const target = resolve(root, ...normalized.split("/"));
  const prefix = `${resolve(root)}${sep}`.toLowerCase();
  if (!target.toLowerCase().startsWith(prefix)) throw new Error(`path escapes project root: ${path}`);
  return target;
}

async function command(command, args, options = {}) {
  return execFile(command, args, { cwd: options.cwd, encoding: options.encoding ?? "utf8", maxBuffer: options.maxBuffer || 64 * 1024 * 1024, windowsHide: true, env: options.env || process.env });
}

async function git(root, args, options = {}) {
  return command("git", ["-C", root, ...args], options);
}

async function projectInfo(projectPath) {
  const requested = resolve(projectPath || process.cwd());
  const { stdout } = await git(requested, ["rev-parse", "--show-toplevel"]);
  const root = resolve(String(stdout).trim());
  let remote = "";
  let branch = "";
  let head = "";
  try { remote = (await git(root, ["remote", "get-url", "origin"])).stdout.trim(); } catch {}
  try { branch = (await git(root, ["branch", "--show-current"])).stdout.trim(); } catch {}
  try { head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim(); } catch {}
  const identity = remote ? remote.trim().toLowerCase().replace(/\.git$/, "") : basename(root).toLowerCase();
  const workspaceId = `git-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
  return { root, name: basename(root), remote: remote || null, branch: branch || null, head: head || null, suggestedWorkspaceId: workspaceId };
}

async function candidatePaths(root, mode) {
  let raw;
  const deleted = new Set();
  if (mode === "baseline") {
    raw = (await git(root, ["ls-files", "-co", "--exclude-standard", "-z"], { encoding: "buffer" })).stdout.toString("utf8");
    return { paths: raw.split("\0").filter(Boolean), deleted };
  }
  raw = (await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "buffer" })).stdout.toString("utf8");
  const tokens = raw.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const statusCode = token.slice(0, 2);
    const path = token.slice(3);
    paths.push(path);
    if (statusCode.includes("D")) deleted.add(normalizePath(path));
    if (statusCode.includes("R") || statusCode.includes("C")) {
      const originalPath = tokens[index + 1];
      index += 1;
      if (statusCode.includes("R") && originalPath) {
        paths.push(originalPath);
        deleted.add(normalizePath(originalPath));
      }
    }
  }
  return { paths, deleted };
}

async function inspectCandidates(projectPath, mode = "incremental") {
  if (!new Set(["incremental", "baseline"]).has(mode)) throw new Error("mode must be incremental or baseline");
  const info = await projectInfo(projectPath);
  const discovered = await candidatePaths(info.root, mode);
  const candidates = [];
  const excluded = [];
  let totalBytes = 0;
  for (const raw of [...new Set(discovered.paths)]) {
    const path = normalizePath(raw);
    const reason = exclusionReason(path);
    if (reason) { excluded.push({ path, reason }); continue; }
    if (discovered.deleted.has(path)) { candidates.push({ path, status: "deleted", bytes: 0 }); continue; }
    let metadata;
    try { metadata = await stat(safeLocalPath(info.root, path)); } catch { excluded.push({ path, reason: "unreadable or missing" }); continue; }
    if (!metadata.isFile()) { excluded.push({ path, reason: "not a regular file" }); continue; }
    if (metadata.size > MAX_FILE_BYTES) { excluded.push({ path, reason: `file exceeds ${MAX_FILE_BYTES} bytes` }); continue; }
    totalBytes += metadata.size;
    candidates.push({ path, status: mode === "baseline" ? "baseline" : "changed", bytes: metadata.size });
  }
  return { ...info, mode, candidates, excluded, totalBytes };
}

async function loadConfig() {
  let config;
  try { config = JSON.parse((await readFile(CONFIG_PATH, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!/^https:\/\//i.test(config.hubUrl || "") || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(config.deviceId || "") || !config.protectedSecret) throw new Error("CW configuration is invalid; run scripts/configure.ps1 again");
  return config;
}

async function revealSecret(config) {
  const script = "Add-Type -AssemblyName System.Security;$cfg=Get-Content -LiteralPath $env:CW_SYNC_CONFIG_PATH -Raw|ConvertFrom-Json;$enc=[Convert]::FromBase64String($cfg.protectedSecret);$entropy=[Text.Encoding]::UTF8.GetBytes('CWDevelopmentSync.Config.v1');$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($enc,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);try{[Text.Encoding]::UTF8.GetString($plain)}finally{[Array]::Clear($plain,0,$plain.Length);[Array]::Clear($entropy,0,$entropy.Length)}";
  const { stdout } = await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, CW_SYNC_CONFIG_PATH: CONFIG_PATH } });
  const secret = stdout.trim();
  if (!secret) throw new Error("CW connection Key could not be decrypted for this Windows user");
  return secret;
}

async function hubRequest(config, path, options = {}) {
  const secret = await revealSecret(config);
  const response = await fetch(`${config.hubUrl}${path}`, { ...options, headers: { Authorization: `Bearer ${secret}`, ...(options.headers || {}) } });
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json()).message || ""; } catch {}
    const error = new Error(`CW request failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

function encryptionKeys(secret) {
  return {
    encryption: createHash("sha256").update("enc\0").update(secret).digest(),
    mac: createHash("sha256").update("mac\0").update(secret).digest(),
  };
}

function encryptBundle(bundle, secret) {
  const keys = encryptionKeys(secret);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", keys.encryption, iv);
  const encrypted = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(bundle), "utf8"))), cipher.final()]);
  const body = Buffer.concat([Buffer.from([1]), iv, encrypted]);
  return Buffer.concat([body, createHmac("sha256", keys.mac).update(body).digest()]);
}

function decryptBundle(encrypted, secret) {
  if (encrypted.length < 50 || encrypted[0] !== 1) throw new Error("unsupported encrypted snapshot format");
  const keys = encryptionKeys(secret);
  const body = encrypted.subarray(0, -32);
  const expected = createHmac("sha256", keys.mac).update(body).digest();
  const actual = encrypted.subarray(-32);
  if (!timingSafeEqual(expected, actual)) throw new Error("snapshot authentication failed");
  const decipher = createDecipheriv("aes-256-cbc", keys.encryption, body.subarray(1, 17));
  return JSON.parse(gunzipSync(Buffer.concat([decipher.update(body.subarray(17)), decipher.final()])).toString("utf8"));
}

async function hashLocal(path) {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function gitBase(root, path) {
  try {
    const { stdout } = await git(root, ["show", `HEAD:${path}`], { encoding: "buffer" });
    return createHash("sha256").update(stdout).digest("hex");
  } catch { return null; }
}

async function buildBundle(prepared, selectedPaths, workspaceId, summary, parentSnapshotId) {
  const allowed = new Map(prepared.candidates.map((item) => [item.path, item]));
  const selected = [...new Set(selectedPaths.map(normalizePath))];
  if (!selected.length) throw new Error("paths must select at least one reviewed candidate");
  const entries = [];
  let totalBytes = 0;
  for (const path of selected) {
    const candidate = allowed.get(path);
    if (!candidate) throw new Error(`path was not a reviewed candidate: ${path}`);
    if (exclusionReason(path)) throw new Error(`blocked path: ${path}`);
    const baseHash = await gitBase(prepared.root, path);
    if (candidate.status === "deleted") { entries.push({ path, deleted: true, baseHash, hash: null, bytes: 0 }); continue; }
    const data = await readFile(safeLocalPath(prepared.root, path));
    totalBytes += data.length;
    if (totalBytes > MAX_PLAINTEXT_BYTES) throw new Error("selected snapshot exceeds plaintext safety limit");
    entries.push({ path, deleted: false, baseHash, hash: createHash("sha256").update(data).digest("hex"), bytes: data.length, data: data.toString("base64") });
  }
  return { schemaVersion: 1, workspaceId, parentSnapshotId, projectName: prepared.name, gitBranch: prepared.branch, gitHead: prepared.head, summary: String(summary || "").slice(0, 512), createdAt: new Date().toISOString(), entries };
}

async function remoteList(config, workspaceId, limit = 50) {
  const response = await hubRequest(config, "/api/cw/v1/snapshots/list", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, limit }) });
  return response.json();
}

async function downloadBundle(config, workspaceId, snapshot) {
  const chunks = [];
  let offset = 0;
  while (offset < snapshot.encryptedBytes) {
    const response = await hubRequest(config, `/api/cw/v1/snapshots/blob?workspaceId=${encodeURIComponent(workspaceId)}&object=${snapshot.object}&offset=${offset}&limit=${DEFAULT_CHUNK_BYTES}`);
    const chunk = Buffer.from(await response.arrayBuffer());
    if (!chunk.length) throw new Error("CW returned an empty snapshot chunk");
    chunks.push(chunk);
    offset += chunk.length;
  }
  const encrypted = Buffer.concat(chunks);
  if (createHash("sha256").update(encrypted).digest("hex") !== snapshot.object) throw new Error("downloaded snapshot hash mismatch");
  return decryptBundle(encrypted, await revealSecret(config));
}

async function snapshotAndBundle(projectPath, workspaceId, snapshotId) {
  const config = await loadConfig();
  if (!config) throw new Error("CW is not configured; run scripts/configure.ps1");
  const info = await projectInfo(projectPath);
  const listing = await remoteList(config, workspaceId, 200);
  const snapshot = snapshotId ? listing.snapshots.find((item) => item.snapshotId === snapshotId) : listing.snapshots[0];
  if (!snapshot) throw new Error("snapshot was not found");
  return { config, info, snapshot, bundle: await downloadBundle(config, workspaceId, snapshot) };
}

async function previewBundle(root, bundle) {
  const actions = [];
  for (const entry of bundle.entries || []) {
    if (exclusionReason(entry.path)) { actions.push({ path: entry.path, action: "blocked" }); continue; }
    const currentHash = await hashLocal(safeLocalPath(root, entry.path));
    if (entry.deleted) {
      actions.push({ path: entry.path, action: currentHash === null ? "noop" : currentHash === entry.baseHash ? "recover-delete" : "conflict", currentHash, baseHash: entry.baseHash });
    } else if (currentHash === entry.hash) {
      actions.push({ path: entry.path, action: "noop", currentHash });
    } else if (currentHash === null) {
      actions.push({ path: entry.path, action: entry.baseHash ? "conflict" : "create", currentHash, baseHash: entry.baseHash, incomingHash: entry.hash });
    } else {
      actions.push({ path: entry.path, action: currentHash === entry.baseHash ? "update" : "conflict", currentHash, baseHash: entry.baseHash, incomingHash: entry.hash });
    }
  }
  return actions;
}

async function atomicFile(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.cw-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const previous = `${path}.cw-old-${process.pid}-${randomBytes(4).toString("hex")}`;
  let movedPrevious = false;
  try {
    await writeFile(temporary, data, { flag: "wx" });
    try { await rename(path, previous); movedPrevious = true; } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await rename(temporary, path);
    if (movedPrevious) await unlink(previous).catch(() => {});
  } catch (error) {
    if (movedPrevious) await rename(previous, path).catch(() => {});
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

const tools = [
  { name: "cw_status", description: "Check local CW configuration and authenticated snapshot protocol availability.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "cw_prepare_snapshot", description: "Inspect Git and return safe candidate paths without uploading anything.", inputSchema: { type: "object", required: ["projectPath"], properties: { projectPath: { type: "string" }, mode: { type: "string", enum: ["incremental", "baseline"] } }, additionalProperties: false } },
  { name: "cw_publish_snapshot", description: "Encrypt and publish exactly the reviewed paths. This mutates remote CW storage.", inputSchema: { type: "object", required: ["projectPath", "workspaceId", "paths", "summary"], properties: { projectPath: { type: "string" }, workspaceId: { type: "string" }, mode: { type: "string", enum: ["incremental", "baseline"] }, paths: { type: "array", minItems: 1, items: { type: "string" } }, summary: { type: "string", minLength: 1, maxLength: 512 } }, additionalProperties: false } },
  { name: "cw_list_snapshots", description: "List encrypted development snapshot metadata for a CW workspace.", inputSchema: { type: "object", required: ["workspaceId"], properties: { workspaceId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, additionalProperties: false } },
  { name: "cw_preview_snapshot", description: "Download/decrypt a snapshot and compare it with a local Git project without changing files.", inputSchema: { type: "object", required: ["projectPath", "workspaceId"], properties: { projectPath: { type: "string" }, workspaceId: { type: "string" }, snapshotId: { type: "string" } }, additionalProperties: false } },
  { name: "cw_apply_snapshot", description: "Apply a previewed snapshot atomically; preserve deletions and conflicting incoming files in recovery directories.", inputSchema: { type: "object", required: ["projectPath", "workspaceId", "snapshotId"], properties: { projectPath: { type: "string" }, workspaceId: { type: "string" }, snapshotId: { type: "string" } }, additionalProperties: false } },
];

async function callTool(name, args = {}) {
  if (name === "cw_status") {
    const config = await loadConfig();
    if (!config) return { configured: false, configPath: CONFIG_PATH, next: "Run scripts/configure.ps1 locally" };
    try { return { configured: true, hubUrl: config.hubUrl, deviceId: config.deviceId, protocol: await (await hubRequest(config, "/api/cw/v1/snapshots/status")).json() }; }
    catch (error) { return { configured: true, hubUrl: config.hubUrl, deviceId: config.deviceId, connected: false, error: error.message }; }
  }
  if (name === "cw_prepare_snapshot") return inspectCandidates(args.projectPath, args.mode || "incremental");
  if (name === "cw_list_snapshots") {
    const config = await loadConfig();
    if (!config) throw new Error("CW is not configured; run scripts/configure.ps1");
    return remoteList(config, args.workspaceId, args.limit);
  }
  if (name === "cw_publish_snapshot") {
    const config = await loadConfig();
    if (!config) throw new Error("CW is not configured; run scripts/configure.ps1");
    const prepared = await inspectCandidates(args.projectPath, args.mode || "incremental");
    const listing = await remoteList(config, args.workspaceId, 1);
    const bundle = await buildBundle(prepared, args.paths, args.workspaceId, args.summary, listing.headSnapshotId);
    const encrypted = encryptBundle(bundle, await revealSecret(config));
    const object = createHash("sha256").update(encrypted).digest("hex");
    let offset = 0;
    while (offset < encrypted.length) {
      const chunk = encrypted.subarray(offset, Math.min(encrypted.length, offset + (listing.maxBlobChunkBytes || DEFAULT_CHUNK_BYTES)));
      const response = await hubRequest(config, `/api/cw/v1/snapshots/blob?workspaceId=${encodeURIComponent(args.workspaceId)}&object=${object}&offset=${offset}&total=${encrypted.length}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: chunk });
      offset = (await response.json()).receivedBytes;
    }
    const response = await hubRequest(config, "/api/cw/v1/snapshots/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: args.workspaceId, workspaceName: prepared.name, deviceId: config.deviceId, parentSnapshotId: listing.headSnapshotId, object, encryptedBytes: encrypted.length, kind: args.mode || "incremental", summary: args.summary, gitBranch: prepared.branch, gitHead: prepared.head, fileCount: bundle.entries.length, deletedCount: bundle.entries.filter((entry) => entry.deleted).length }) });
    return response.json();
  }
  if (name === "cw_preview_snapshot") {
    const value = await snapshotAndBundle(args.projectPath, args.workspaceId, args.snapshotId);
    const actions = await previewBundle(value.info.root, value.bundle);
    return { workspaceId: args.workspaceId, snapshot: value.snapshot, summary: value.bundle.summary, actions, counts: Object.fromEntries([...new Set(actions.map((item) => item.action))].map((action) => [action, actions.filter((item) => item.action === action).length])) };
  }
  if (name === "cw_apply_snapshot") {
    const value = await snapshotAndBundle(args.projectPath, args.workspaceId, args.snapshotId);
    const actions = await previewBundle(value.info.root, value.bundle);
    const results = [];
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      const entry = value.bundle.entries[index];
      const target = safeLocalPath(value.info.root, entry.path);
      if (action.action === "noop") { results.push(action); continue; }
      if (action.action === "recover-delete") {
        const recovery = safeLocalPath(value.info.root, `.cw-recovery/${value.snapshot.snapshotId}/${entry.path}`);
        await mkdir(dirname(recovery), { recursive: true });
        await rename(target, recovery);
        results.push({ ...action, recoveryPath: relative(value.info.root, recovery).replaceAll("\\", "/") });
        continue;
      }
      const data = entry.deleted ? null : Buffer.from(entry.data, "base64");
      if (action.action === "conflict" || action.action === "blocked") {
        if (data) {
          const conflict = safeLocalPath(value.info.root, `.cw-conflicts/${value.snapshot.snapshotId}/${entry.path}`);
          await atomicFile(conflict, data);
          results.push({ ...action, conflictPath: relative(value.info.root, conflict).replaceAll("\\", "/") });
        } else results.push(action);
        continue;
      }
      if (!data || createHash("sha256").update(data).digest("hex") !== entry.hash) throw new Error(`snapshot entry hash mismatch: ${entry.path}`);
      await atomicFile(target, data);
      results.push(action);
    }
    return { workspaceId: args.workspaceId, snapshotId: value.snapshot.snapshotId, results, counts: Object.fromEntries([...new Set(results.map((item) => item.action))].map((action) => [action, results.filter((item) => item.action === action).length])) };
  }
  throw new Error(`unknown tool: ${name}`);
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    void (async () => {
      let request;
      try { request = JSON.parse(line); } catch { return; }
      if (request.method === "initialize") {
        send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cw-development-sync", version: "0.1.0" } } });
      } else if (request.method === "tools/list") {
        send({ jsonrpc: "2.0", id: request.id, result: { tools } });
      } else if (request.method === "tools/call") {
        try { send({ jsonrpc: "2.0", id: request.id, result: textResult(await callTool(request.params?.name, request.params?.arguments || {})) }); }
        catch (error) { send({ jsonrpc: "2.0", id: request.id, result: textResult({ error: error.message }, true) }); }
      } else if (request.id !== undefined && !String(request.method || "").startsWith("notifications/")) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
      }
    })();
  }
});
