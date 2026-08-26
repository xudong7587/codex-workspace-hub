import {
  ProviderRequestError,
  fetchProviderJson,
  resolveUpdatedAt,
  toFiniteNumber,
  usedPercentFromRemaining,
} from "./shared.js";

export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

function metricFromApiKey(data) {
  const usage = toFiniteNumber(data.usage, "usage", { min: 0 });
  const limit = toFiniteNumber(data.limit, "limit", { min: 0 });
  let remaining = toFiniteNumber(data.limit_remaining, "limit remaining");

  if (remaining === null && limit !== null && usage !== null) {
    remaining = limit - usage;
  }
  let value = usage;
  if (value === null && limit !== null && remaining !== null) {
    value = limit - remaining;
  }
  if (value === null) {
    throw new ProviderRequestError(
      "OpenRouter returned an incomplete key quota response",
      "INVALID_RESPONSE",
    );
  }

  const usedPercent = usedPercentFromRemaining(limit, remaining);
  return Object.freeze({
    metricType: "spend_limit",
    value,
    limit,
    remaining,
    unit: "USD",
    currency: "USD",
    percentageSource: usedPercent === null ? "unavailable" : "derived",
    usedPercent,
  });
}

function metricFromCredits(data) {
  const limit = toFiniteNumber(data.total_credits, "total credits", { min: 0 });
  const value = toFiniteNumber(data.total_usage, "total usage", { min: 0 });
  if (limit === null || value === null) {
    throw new ProviderRequestError(
      "OpenRouter returned an incomplete credits response",
      "INVALID_RESPONSE",
    );
  }
  const remaining = limit - value;
  const usedPercent = usedPercentFromRemaining(limit, remaining);
  return Object.freeze({
    metricType: "credits",
    value,
    limit,
    remaining,
    unit: "USD",
    currency: "USD",
    percentageSource: usedPercent === null ? "unavailable" : "derived",
    usedPercent,
  });
}

export async function collectOpenRouterQuota({
  apiKey,
  managementKey,
  accountLabel,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  signal,
  now = Date.now,
} = {}) {
  const useApiKey = typeof apiKey === "string" && apiKey.trim() !== "";
  const credential = useApiKey ? apiKey : managementKey;
  const url = useApiKey ? OPENROUTER_KEY_URL : OPENROUTER_CREDITS_URL;
  const response = await fetchProviderJson({
    providerName: "OpenRouter",
    url,
    apiKey: credential,
    fetchImpl,
    timeoutMs,
    signal,
  });
  if (!response || typeof response !== "object" || !response.data || typeof response.data !== "object") {
    throw new ProviderRequestError(
      "OpenRouter returned an invalid quota response",
      "INVALID_RESPONSE",
    );
  }

  return Object.freeze({
    id: "openrouter",
    displayName: "OpenRouter",
    status: "ok",
    updatedAt: resolveUpdatedAt(now),
    accountLabel: String(accountLabel || (useApiKey ? "API key" : "Account credits")),
    metrics: Object.freeze([
      useApiKey ? metricFromApiKey(response.data) : metricFromCredits(response.data),
    ]),
    watchPayload: null,
  });
}

export function createOpenRouterProvider(defaultOptions = {}) {
  return Object.freeze({
    id: "openrouter",
    displayName: "OpenRouter",
    bridgeCompatible: false,
    isConfigured: (config = {}) => Boolean(config.apiKey),
    collect: (config = {}, context = {}) => collectOpenRouterQuota({
      ...defaultOptions,
      ...(config.mode === "credits"
        ? { managementKey: config.apiKey }
        : { apiKey: config.apiKey }),
      signal: context.signal,
    }),
  });
}
