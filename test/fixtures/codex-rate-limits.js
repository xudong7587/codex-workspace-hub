export const FIXED_NOW = Date.parse("2026-08-26T10:00:00.000Z");
export const SESSION_RESET_SECONDS = Date.parse("2026-08-26T13:00:00.000Z") / 1_000;
export const WEEKLY_RESET_SECONDS = Date.parse("2026-09-01T00:00:00.000Z") / 1_000;

export const ACCOUNT_RESPONSE = Object.freeze({
  account: Object.freeze({
    type: "chatgpt",
    planType: "plus",
  }),
});

export const CODEX_RATE_LIMIT_SNAPSHOT = Object.freeze({
  limitId: "codex",
  primary: Object.freeze({
    usedPercent: 18,
    resetsAt: SESSION_RESET_SECONDS,
  }),
  secondary: Object.freeze({
    usedPercent: 37,
    resetsAt: WEEKLY_RESET_SECONDS,
  }),
});

export const RATE_LIMITS_RESPONSE = Object.freeze({
  rateLimitsByLimitId: Object.freeze({
    codex: CODEX_RATE_LIMIT_SNAPSHOT,
  }),
});

export function freshStatsInput(overrides = {}) {
  return {
    account: ACCOUNT_RESPONSE,
    rateLimits: RATE_LIMITS_RESPONSE,
    updatedAt: FIXED_NOW - 30_000,
    now: FIXED_NOW,
    staleAfterMs: 300_000,
    ...overrides,
  };
}

export const EXPECTED_WINDOWS = Object.freeze([
  Object.freeze({
    kind: "session",
    usedPercent: 18,
    resetsAt: "2026-08-26T13:00:00.000Z",
  }),
  Object.freeze({
    kind: "weekly",
    usedPercent: 37,
    resetsAt: "2026-09-01T00:00:00.000Z",
  }),
]);
