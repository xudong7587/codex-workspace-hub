import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateRequest,
  constantTimeSecretEqual,
} from "../src/auth.js";

const SECRET = "watch-gateway-test-secret";

function request(headers = {}) {
  return { headers };
}

test("constantTimeSecretEqual only accepts equal strings", () => {
  assert.equal(constantTimeSecretEqual(SECRET, SECRET), true);
  assert.equal(constantTimeSecretEqual(`${SECRET}-wrong`, SECRET), false);
  assert.equal(constantTimeSecretEqual(null, SECRET), false);
});

test("authenticateRequest accepts the APK dual-header request", () => {
  assert.equal(
    authenticateRequest(
      request({
        authorization: `Bearer ${SECRET}`,
        "x-token-monitor-secret": SECRET,
      }),
      SECRET,
    ),
    true,
  );
});

test("authenticateRequest accepts either legacy authentication header", () => {
  assert.equal(
    authenticateRequest(request({ authorization: `Bearer ${SECRET}` }), SECRET),
    true,
  );
  assert.equal(
    authenticateRequest(request({ "x-token-monitor-secret": SECRET }), SECRET),
    true,
  );
});

test("authenticateRequest rejects missing, malformed, and incorrect credentials", () => {
  assert.equal(authenticateRequest(request(), SECRET), false);
  assert.equal(
    authenticateRequest(request({ authorization: SECRET }), SECRET),
    false,
  );
  assert.equal(
    authenticateRequest(
      request({ authorization: "Bearer wrong-secret" }),
      SECRET,
    ),
    false,
  );
  assert.equal(
    authenticateRequest(
      request({ "x-token-monitor-secret": "wrong-secret" }),
      SECRET,
    ),
    false,
  );
});

test("authenticateRequest rejects disagreeing dual headers", () => {
  assert.equal(
    authenticateRequest(
      request({
        authorization: `Bearer ${SECRET}`,
        "x-token-monitor-secret": "a-different-secret",
      }),
      SECRET,
    ),
    false,
  );
});
