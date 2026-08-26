#!/usr/bin/env node

import { get } from "node:http";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.js";

export function checkHealth(env = process.env) {
  const config = loadConfig(env);
  const configuredHost = String(env.HEALTHCHECK_HOST || config.host);
  const host = configuredHost === "0.0.0.0"
    ? "127.0.0.1"
    : configuredHost === "::"
      ? "::1"
      : configuredHost;
  const path = String(env.HEALTHCHECK_PATH || "/livez");
  const timeout = Number(env.HEALTHCHECK_TIMEOUT_MS || 3_000);

  return new Promise((resolve, reject) => {
    const request = get({ host, port: config.port, path, timeout }, (response) => {
      response.resume();
      response.once("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(`Healthcheck returned HTTP ${response.statusCode}`));
      });
    });
    request.once("timeout", () => request.destroy(new Error("Healthcheck timed out")));
    request.once("error", reject);
  });
}

async function main() {
  try {
    await checkHealth();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
