import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENROUTER_CREDITS_URL,
  OPENROUTER_KEY_URL,
  collectOpenRouterQuota,
  createOpenRouterProvider,
} from "../src/providers/openrouter.js";

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

test("OpenRouter prefers the ordinary key endpoint and normalizes its spend limit", async () => {
  const calls = [];
  const snapshot = await collectOpenRouterQuota({
    apiKey: "ordinary-key",
    managementKey: "management-key",
    now: () => 500,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        data: { usage: 12.5, limit: 50, limit_remaining: 37.5 },
      });
    },
  });

  assert.equal(calls[0].url, OPENROUTER_KEY_URL);
  assert.equal(calls[0].options.headers.Authorization, "Bearer ordinary-key");
  assert.deepEqual(snapshot, {
    id: "openrouter",
    displayName: "OpenRouter",
    status: "ok",
    updatedAt: 500,
    accountLabel: "API key",
    metrics: [{
      metricType: "spend_limit",
      value: 12.5,
      limit: 50,
      remaining: 37.5,
      unit: "USD",
      currency: "USD",
      percentageSource: "derived",
      usedPercent: 25,
    }],
    watchPayload: null,
  });
});

test("OpenRouter reports absolute usage when an ordinary key has no spending limit", async () => {
  const snapshot = await collectOpenRouterQuota({
    apiKey: "ordinary-key",
    fetchImpl: async () => jsonResponse({
      data: { usage: 7.25, limit: null, limit_remaining: null },
    }),
  });

  assert.equal(snapshot.metrics[0].value, 7.25);
  assert.equal(snapshot.metrics[0].limit, null);
  assert.equal(snapshot.metrics[0].remaining, null);
  assert.equal(snapshot.metrics[0].percentageSource, "unavailable");
  assert.equal(snapshot.metrics[0].usedPercent, null);
});

test("OpenRouter supports the optional management credits endpoint", async () => {
  const calls = [];
  const snapshot = await collectOpenRouterQuota({
    managementKey: "management-key",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ data: { total_credits: 100, total_usage: 12.34 } });
    },
  });

  assert.equal(calls[0].url, OPENROUTER_CREDITS_URL);
  assert.equal(calls[0].options.headers.Authorization, "Bearer management-key");
  assert.deepEqual(snapshot.metrics[0], {
    metricType: "credits",
    value: 12.34,
    limit: 100,
    remaining: 87.66,
    unit: "USD",
    currency: "USD",
    percentageSource: "derived",
    usedPercent: 12.34,
  });
});

test("provider failures never include credentials or upstream response bodies", async () => {
  const secret = "never-print-this-secret";
  const upstreamBody = "body-must-not-be-reported";
  let error;
  try {
    await collectOpenRouterQuota({
      apiKey: secret,
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => upstreamBody,
        json: async () => ({ error: upstreamBody }),
      }),
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.doesNotMatch(error.message, new RegExp(secret));
  assert.doesNotMatch(error.message, new RegExp(upstreamBody));
  assert.match(error.message, /HTTP 401/);
});

test("provider requests enforce their timeout through AbortSignal", async () => {
  await assert.rejects(
    collectOpenRouterQuota({
      apiKey: "key",
      timeoutMs: 10,
      fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("contains-sensitive-upstream-details")), {
          once: true,
        });
      }),
    }),
    (error) => {
      assert.equal(error.code, "TIMEOUT");
      assert.equal(error.message, "OpenRouter quota request timed out");
      return true;
    },
  );
});

test("the provider descriptor retains defaults without exporting a watch alias", async () => {
  const openrouter = createOpenRouterProvider({
    managementKey: "management-key",
    fetchImpl: async () => jsonResponse({ data: { total_credits: 2, total_usage: 1 } }),
  });

  assert.deepEqual({ id: openrouter.id, displayName: openrouter.displayName }, {
    id: "openrouter",
    displayName: "OpenRouter",
  });
  assert.equal((await openrouter.collect()).watchPayload, null);
});
