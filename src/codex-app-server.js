import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

import { APP_VERSION } from "./version.js";

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: "codex-workspace-hub",
  title: "Codex Workspace Hub",
  version: APP_VERSION,
});

export class CodexAppServerError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "CodexAppServerError";
    if (options.code !== undefined) this.code = options.code;
    if (options.data !== undefined) this.data = options.data;
  }
}

function timeoutError(label, timeoutMs) {
  const error = new CodexAppServerError(`${label} timed out after ${timeoutMs}ms`);
  error.code = "ETIMEDOUT";
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function hasExited(child) {
  return child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined;
}

export class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.command || options.codexBin || "codex";
    this.args = options.args || ["app-server"];
    this.cwd = options.cwd;
    this.env = options.env || process.env;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.startTimeoutMs = options.startTimeoutMs ?? 15_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 2_000;
    this.clientInfo = { ...DEFAULT_CLIENT_INFO, ...options.clientInfo };
    this.logger = options.logger || null;
    this.spawn = options.spawn || nodeSpawn;

    this.child = null;
    this.readline = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.state = "idle";
    this.initializeResult = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.exitObserved = false;
  }

  get ready() {
    return this.state === "ready";
  }

  async start() {
    if (this.ready) return this.initializeResult;
    if (this.startPromise) return this.startPromise;
    if (this.state === "stopping") {
      throw new CodexAppServerError("Codex app-server is stopping");
    }

    this.state = "starting";
    this.startPromise = this.#startProcess();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #startProcess() {
    try {
      const child = this.spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.exitObserved = false;
      this.#attachProcess(child);
      await this.#waitForSpawn(child);

      const result = await this.request(
        "initialize",
        {
          clientInfo: this.clientInfo,
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
          },
        },
        { timeoutMs: this.startTimeoutMs },
      );
      this.sendNotification("initialized");
      this.initializeResult = result;
      this.state = "ready";
      this.logger?.info?.("Codex app-server initialized", {
        platformFamily: result?.platformFamily,
        platformOs: result?.platformOs,
      });
      this.emit("ready", result);
      return result;
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  #attachProcess(child) {
    this.readline = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.readline.on("line", (line) => this.handleLine(line));
    child.stderr?.on("data", (chunk) => {
      // Stderr can include upstream diagnostics. Do not log it by default because
      // authentication-related errors may contain sensitive context.
      this.emit("stderr", chunk.toString("utf8"));
    });
    child.stdin?.on("error", (error) => this.#handleProcessError(child, error));
    child.once("error", (error) => this.#handleProcessError(child, error));
    child.once("exit", (code, signal) => this.#handleExit(child, code, signal));
  }

  #waitForSpawn(child) {
    if (child.pid) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off("spawn", onSpawn);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(new CodexAppServerError(`Failed to start Codex app-server: ${error.message}`, { cause: error }));
      };
      const onExit = (code, signal) => {
        cleanup();
        reject(new CodexAppServerError(`Codex app-server exited before initialization (${code ?? signal ?? "unknown"})`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(timeoutError("Codex app-server start", this.startTimeoutMs));
      }, this.startTimeoutMs);
      timer.unref?.();
      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("exit", onExit);
    });
  }

  request(method, params, options = {}) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return Promise.reject(new CodexAppServerError("Codex app-server is not running"));
    }
    if (this.state === "stopping" || this.state === "stopped") {
      return Promise.reject(new CodexAppServerError("Codex app-server is stopping"));
    }

    const id = this.nextRequestId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const message = { method, id };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(timeoutError(`Codex app-server request ${method}`, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(String(id), { method, resolve, reject, timer });

      try {
        this.#write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  sendNotification(method, params) {
    const message = { method };
    if (params !== undefined) message.params = params;
    this.#write(message);
  }

  notify(method, params) {
    return this.sendNotification(method, params);
  }

  #write(message) {
    if (!this.child?.stdin || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new CodexAppServerError("Codex app-server stdin is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    const trimmed = String(line).trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (cause) {
      const error = new CodexAppServerError("Codex app-server emitted invalid JSON", { cause });
      this.logger?.warn?.(error.message);
      this.emit("protocolError", error);
      return;
    }

    if (message && Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
      this.#handleResponse(message);
      return;
    }
    if (message && typeof message.method === "string" && Object.hasOwn(message, "id")) {
      this.#handleServerRequest(message);
      return;
    }
    if (message && typeof message.method === "string") {
      this.emit("notification", message);
      this.emit(message.method, message.params);
      return;
    }

    const error = new CodexAppServerError("Codex app-server emitted an unknown message shape");
    this.emit("protocolError", error);
  }

  #handleResponse(message) {
    const entry = this.pending.get(String(message.id));
    if (!entry) {
      this.emit("orphanResponse", message);
      return;
    }
    this.pending.delete(String(message.id));
    clearTimeout(entry.timer);
    if (message.error !== undefined && message.error !== null) {
      entry.reject(new CodexAppServerError(
        message.error.message || `Codex app-server request ${entry.method} failed`,
        { code: message.error.code, data: message.error.data },
      ));
      return;
    }
    entry.resolve(message.result);
  }

  #handleServerRequest(message) {
    let settled = false;
    const respond = (result, error) => {
      if (settled) return;
      settled = true;
      if (error) {
        this.#write({ id: message.id, error });
      } else {
        this.#write({ id: message.id, result: result ?? null });
      }
    };

    if (this.listenerCount("serverRequest") === 0) {
      respond(null, { code: -32_601, message: `Unsupported server request: ${message.method}` });
      return;
    }
    this.emit("serverRequest", message, respond);
  }

  waitForNotification(method, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const predicate = options.predicate || (() => true);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off(method, onNotification);
        this.off("exit", onExit);
      };
      const onNotification = (params) => {
        if (!predicate(params)) return;
        cleanup();
        resolve(params);
      };
      const onExit = () => {
        cleanup();
        reject(new CodexAppServerError(`Codex app-server exited while waiting for ${method}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(timeoutError(`Codex app-server notification ${method}`, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      this.on(method, onNotification);
      this.once("exit", onExit);
    });
  }

  #handleProcessError(child, error) {
    if (child !== this.child) return;
    if (this.state === "stopping" || this.state === "stopped") return;
    const wrapped = new CodexAppServerError(`Codex app-server process error: ${error.message}`, { cause: error });
    this.#rejectPending(wrapped);
    this.emit("processError", wrapped);
  }

  #handleExit(child, code, signal) {
    if (child !== this.child) return;
    if (this.exitObserved) return;
    this.exitObserved = true;
    const wasStopping = this.state === "stopping" || this.state === "stopped";
    this.state = "stopped";
    this.readline?.close();
    this.readline = null;
    this.child = null;
    const error = new CodexAppServerError(`Codex app-server exited (${code ?? signal ?? "unknown"})`);
    this.#rejectPending(error);
    this.emit("exit", { code, signal, expected: wasStopping });
  }

  #rejectPending(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    if (!this.child) {
      this.state = "stopped";
      return;
    }
    this.stopPromise = this.#stopProcess();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async #stopProcess() {
    this.state = "stopping";
    const child = this.child;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    this.#rejectPending(new CodexAppServerError("Codex app-server client stopped"));
    if (!child.stdin?.destroyed) child.stdin.end();

    if (!hasExited(child)) {
      await Promise.race([exited, delay(this.stopTimeoutMs)]);
    }
    if (!hasExited(child)) {
      child.kill("SIGTERM");
      await Promise.race([exited, delay(this.stopTimeoutMs)]);
    }
    if (!hasExited(child)) {
      child.kill("SIGKILL");
      await Promise.race([exited, delay(Math.min(250, this.stopTimeoutMs))]);
    }
    this.readline?.close();
    this.readline = null;
    this.child = null;
    this.state = "stopped";
  }
}

export { DEFAULT_CLIENT_INFO };
