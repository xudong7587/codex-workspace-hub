import assert from "node:assert/strict";
import test from "node:test";

import { createLogger } from "../src/logger.js";

test("logger keeps a bounded redacted diagnostic history", () => {
  const sink = { write() {} };
  const logger = createLogger("debug", sink, { historyLimit: 2 });
  logger.info("one", { authorization: "Bearer secret", workspaceId: "project-a" });
  logger.warn("two", { nested: { apiKey: "secret" } });
  logger.error("three", { deviceId: "office-pc" });
  const recent = logger.recent(20);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].nested.apiKey, "[REDACTED]");
  assert.equal(recent[1].deviceId, "office-pc");
});
