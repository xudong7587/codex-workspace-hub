import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CODEX_OAUTH_CLIENT_ID,
  CodexDirectClient,
  mapCodexUsageResponse,
} from "../src/codex-direct-client.js";

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("mapCodexUsageResponse converts the official usage endpoint shape", () => {
  const mapped = mapCodexUsageResponse({
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 24,
        limit_window_seconds: 18_000,
        reset_at: 1_800_000_000,
      },
      secondary_window: {
        used_percent: 61,
        limit_window_seconds: 604_800,
        reset_after_seconds: 60,
      },
    },
    rate_limit_reached_type: null,
  }, 1_700_000_000_000);

  const codex = mapped.rateLimitsByLimitId.codex;
  assert.equal(codex.planType, "plus");
  assert.deepEqual(codex.primary, {
    usedPercent: 24,
    windowDurationMins: 300,
    resetsAt: 1_800_000_000,
  });
  assert.deepEqual(codex.secondary, {
    usedPercent: 61,
    windowDurationMins: 10_080,
    resetsAt: 1_700_000_060,
  });
});

test("CodexDirectClient completes device login and reads quota without a Codex binary", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "vwatch-codex-direct-"));
  const now = 1_800_000_000_000;
  const idToken = jwt({
    exp: 1_900_000_000,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-123",
      chatgpt_plan_type: "plus",
    },
  });
  const accessToken = jwt({ exp: 1_900_000_000 });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/accounts/deviceauth/usercode")) {
      assert.deepEqual(JSON.parse(init.body), { client_id: CODEX_OAUTH_CLIENT_ID });
      return jsonResponse({
        device_auth_id: "device-auth-1",
        user_code: "ABCD-1234",
        interval: "1",
      });
    }
    if (String(url).endsWith("/api/accounts/deviceauth/token")) {
      return jsonResponse({
        authorization_code: "authorization-code",
        code_challenge: "challenge",
        code_verifier: "verifier",
      });
    }
    if (String(url).endsWith("/oauth/token")) {
      assert.match(init.body, /grant_type=authorization_code/);
      assert.match(init.body, /code_verifier=verifier/);
      return jsonResponse({
        id_token: idToken,
        access_token: accessToken,
        refresh_token: "refresh-token",
      });
    }
    if (String(url).endsWith("/backend-api/wham/usage")) {
      assert.equal(init.headers.Authorization, `Bearer ${accessToken}`);
      assert.equal(init.headers["ChatGPT-Account-Id"], "account-123");
      return jsonResponse({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_800_000_100 },
          secondary_window: { used_percent: 34, limit_window_seconds: 604_800, reset_at: 1_800_000_200 },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new CodexDirectClient({ codexHome, fetchImpl, now: () => now });
  await client.start();
  const completedPromise = once(client, "account/login/completed");
  const challenge = await client.request("account/login/start", { type: "chatgptDeviceCode" });
  assert.equal(challenge.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(challenge.userCode, "ABCD-1234");
  const [completed] = await completedPromise;
  assert.equal(completed.loginId, challenge.loginId);
  assert.equal(completed.success, true);

  const account = await client.request("account/read", { refreshToken: false });
  assert.deepEqual(account, {
    account: { type: "chatgpt", planType: "plus", accountId: "account-123" },
  });
  const limits = await client.request("account/rateLimits/read");
  assert.equal(limits.rateLimitsByLimitId.codex.primary.usedPercent, 12);
  assert.equal(limits.rateLimitsByLimitId.codex.secondary.usedPercent, 34);

  const stored = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
  assert.equal(stored.tokens.account_id, "account-123");
  assert.equal(stored.tokens.refresh_token, "refresh-token");
  assert.equal(calls.length, 4);
  await client.stop();
});

test("CodexDirectClient refreshes an expiring access token before quota polling", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "vwatch-codex-refresh-"));
  const now = 1_800_000_000_000;
  const idToken = jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "account-refresh" },
  });
  await writeFile(join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: idToken,
      access_token: jwt({ exp: 1_799_999_999 }),
      refresh_token: "old-refresh",
      account_id: "account-refresh",
    },
  }));

  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/oauth/token")) {
      assert.deepEqual(JSON.parse(init.body), {
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: "old-refresh",
      });
      return jsonResponse({ access_token: "fresh-access", refresh_token: "fresh-refresh" });
    }
    if (String(url).endsWith("/backend-api/wham/usage")) {
      assert.equal(init.headers.Authorization, "Bearer fresh-access");
      return jsonResponse({
        rate_limit: {
          primary_window: { used_percent: 7, limit_window_seconds: 18_000, reset_at: 1_800_000_100 },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new CodexDirectClient({ codexHome, fetchImpl, now: () => now });
  await client.start();
  const limits = await client.request("account/rateLimits/read");
  assert.equal(limits.rateLimitsByLimitId.codex.primary.usedPercent, 7);
  const stored = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
  assert.equal(stored.tokens.access_token, "fresh-access");
  assert.equal(stored.tokens.refresh_token, "fresh-refresh");
  await client.stop();
});

test("CodexDirectClient refreshes account claims once after a usage 403", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "vwatch-codex-claims-refresh-"));
  const now = 1_800_000_000_000;
  await writeFile(join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-renewed" },
      }),
      access_token: jwt({ exp: 1_900_000_000 }),
      refresh_token: "renewed-refresh-token",
      account_id: "account-renewed",
    },
  }));

  let usageCalls = 0;
  let refreshCalls = 0;
  const client = new CodexDirectClient({
    codexHome,
    now: () => now,
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith("/oauth/token")) {
        refreshCalls += 1;
        assert.deepEqual(JSON.parse(init.body), {
          client_id: CODEX_OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: "renewed-refresh-token",
        });
        return jsonResponse({ access_token: "renewed-access-token" });
      }
      if (String(url).endsWith("/backend-api/wham/usage")) {
        usageCalls += 1;
        if (usageCalls === 1) return jsonResponse({ error: "forbidden" }, 403);
        assert.equal(init.headers.Authorization, "Bearer renewed-access-token");
        return jsonResponse({
          rate_limit: {
            primary_window: {
              used_percent: 18,
              limit_window_seconds: 18_000,
              reset_at: 1_800_000_100,
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  await client.start();
  const limits = await client.request("account/rateLimits/read");
  assert.equal(limits.rateLimitsByLimitId.codex.primary.usedPercent, 18);
  assert.equal(refreshCalls, 1);
  assert.equal(usageCalls, 2);
  await client.stop();
});

test("CodexDirectClient retries transient and incomplete usage responses", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "vwatch-codex-retry-"));
  const now = 1_800_000_000_000;
  await writeFile(join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-retry" },
      }),
      access_token: jwt({ exp: 1_900_000_000 }),
      refresh_token: "refresh-retry",
      account_id: "account-retry",
    },
  }));

  let usageCalls = 0;
  const delays = [];
  const fetchImpl = async (url) => {
    assert.match(String(url), /\/backend-api\/wham\/usage$/);
    usageCalls += 1;
    if (usageCalls === 1) {
      return jsonResponse({ error: "temporarily unavailable" }, 503);
    }
    if (usageCalls === 2) return jsonResponse({ rate_limit: {} });
    return jsonResponse({
      rate_limit: {
        primary_window: {
          used_percent: 9,
          limit_window_seconds: 18_000,
          reset_at: 1_800_000_100,
        },
      },
    });
  };
  const client = new CodexDirectClient({
    codexHome,
    fetchImpl,
    now: () => now,
    usageRetryBaseMs: 10,
    usageRetryMaxMs: 20,
    sleep: async (delayMs) => delays.push(delayMs),
  });
  await client.start();
  const limits = await client.request("account/rateLimits/read");
  assert.equal(limits.rateLimitsByLimitId.codex.primary.usedPercent, 9);
  assert.equal(usageCalls, 3);
  assert.deepEqual(delays, [10, 20]);
  await client.stop();
});

test("CodexDirectClient does not retry a permanent authorization failure", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "vwatch-codex-auth-failure-"));
  await writeFile(join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-auth" },
      }),
      access_token: jwt({ exp: 1_900_000_000 }),
      account_id: "account-auth",
    },
  }));
  let calls = 0;
  const client = new CodexDirectClient({
    codexHome,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: "forbidden" }, 403);
    },
    now: () => 1_800_000_000_000,
    sleep: async () => assert.fail("authorization failures must not be retried"),
  });
  await client.start();
  await assert.rejects(
    client.request("account/rateLimits/read"),
    (error) => error.code === "CODEX_AUTH_EXPIRED" && error.status === 403,
  );
  assert.equal(calls, 1);
  await client.stop();
});

test("stopping CodexDirectClient cancels an in-progress retry backoff", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "vwatch-codex-stop-retry-"));
  await writeFile(join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-stop" },
      }),
      access_token: jwt({ exp: 1_900_000_000 }),
      account_id: "account-stop",
    },
  }));
  let announceAttempt;
  const attempted = new Promise((resolve) => {
    announceAttempt = resolve;
  });
  const client = new CodexDirectClient({
    codexHome,
    fetchImpl: async () => {
      announceAttempt();
      return jsonResponse({ error: "temporarily unavailable" }, 503);
    },
    now: () => 1_800_000_000_000,
    usageRetryBaseMs: 10_000,
    usageRetryMaxMs: 10_000,
  });
  await client.start();
  const request = client.request("account/rateLimits/read");
  await attempted;
  await client.stop();
  await assert.rejects(request, (error) => error.code === "CANCELLED");
});
