const DEFAULT_TIMEOUT_MS = 10_000;

export class ProviderRequestError extends Error {
  constructor(message, code, options = undefined) {
    super(message, options);
    this.name = "ProviderRequestError";
    this.code = code;
  }
}

export function requireApiKey(value, providerName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProviderRequestError(`${providerName} API key is required`, "MISSING_CREDENTIAL");
  }
  return value.trim();
}

export function toFiniteNumber(value, fieldName, { min = -Infinity } = {}) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ProviderRequestError(
      `Provider returned an invalid ${fieldName}`,
      "INVALID_RESPONSE",
    );
  }

  const normalized = typeof value === "string" ? value.trim() : value;
  if (normalized === "") return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new ProviderRequestError(
      `Provider returned an invalid ${fieldName}`,
      "INVALID_RESPONSE",
    );
  }
  return parsed;
}

export function usedPercentFromRemaining(limit, remaining) {
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return null;
  const percentage = ((limit - remaining) / limit) * 100;
  const clamped = Math.min(100, Math.max(0, percentage));
  return Number(clamped.toFixed(2));
}

export function resolveUpdatedAt(now) {
  const value = typeof now === "function" ? now() : Date.now();
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("now must return a non-negative timestamp");
  }
  return Math.trunc(value);
}

function validateTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new TypeError("timeoutMs must be an integer between 1 and 300000");
  }
  return timeoutMs;
}

function createRequestSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  const onExternalAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) {
    onExternalAbort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    dispose() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/**
 * Fetch JSON from a fixed provider endpoint without ever incorporating the
 * credential, response body, or upstream exception text into an error.
 */
export async function fetchProviderJson({
  providerName,
  url,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal: externalSignal,
}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const credential = requireApiKey(apiKey, providerName);
  validateTimeout(timeoutMs);
  const requestSignal = createRequestSignal(externalSignal, timeoutMs);

  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential}`,
        },
        signal: requestSignal.signal,
      });
    } catch {
      if (requestSignal.didTimeOut()) {
        throw new ProviderRequestError(
          `${providerName} quota request timed out`,
          "TIMEOUT",
        );
      }
      if (externalSignal?.aborted) {
        throw new ProviderRequestError(
          `${providerName} quota request was cancelled`,
          "CANCELLED",
        );
      }
      throw new ProviderRequestError(
        `${providerName} quota request failed`,
        "NETWORK_ERROR",
      );
    }

    if (!response || response.ok !== true) {
      const status = Number.isInteger(response?.status) ? response.status : "unknown";
      throw new ProviderRequestError(
        `${providerName} quota request failed (HTTP ${status})`,
        "HTTP_ERROR",
      );
    }

    try {
      return await response.json();
    } catch {
      throw new ProviderRequestError(
        `${providerName} returned invalid JSON`,
        "INVALID_RESPONSE",
      );
    }
  } finally {
    requestSignal.dispose();
  }
}

export { DEFAULT_TIMEOUT_MS };
