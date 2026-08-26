import { createHash, timingSafeEqual } from "node:crypto";

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}

export function constantTimeSecretEqual(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  return timingSafeEqual(digest(candidate), digest(expected));
}

function headerValue(request, name) {
  if (typeof request?.headers?.get === "function") {
    return request.headers.get(name);
  }
  const value = request?.headers?.[name.toLowerCase()] ?? request?.headers?.[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return value ?? null;
}

function bearerToken(value) {
  if (typeof value !== "string") return null;
  const match = /^Bearer[ \t]+([^\s].*)$/i.exec(value);
  return match ? match[1] : null;
}

export function authenticateRequest(request, configuredSecret) {
  const expected = typeof configuredSecret === "string"
    ? configuredSecret
    : configuredSecret?.tokenMonitorSecret ?? configuredSecret?.secret;
  if (typeof expected !== "string" || expected.length === 0) return false;

  const authorization = headerValue(request, "authorization");
  const customHeader = headerValue(request, "x-token-monitor-secret");
  const hasAuthorization = authorization !== null && authorization !== undefined;
  const hasCustomHeader = customHeader !== null && customHeader !== undefined;
  if (!hasAuthorization && !hasCustomHeader) return false;

  const bearer = hasAuthorization ? bearerToken(authorization) : null;
  if (hasAuthorization && bearer === null) return false;
  if (hasCustomHeader && typeof customHeader !== "string") return false;

  const bearerMatches = !hasAuthorization || constantTimeSecretEqual(bearer, expected);
  const customMatches = !hasCustomHeader || constantTimeSecretEqual(customHeader, expected);
  return bearerMatches && customMatches;
}

export function authenticateAdminRequest(request, configuredToken) {
  if (typeof configuredToken !== "string" || configuredToken.length === 0) return false;
  const authorization = headerValue(request, "authorization");
  const bearer = bearerToken(authorization);
  return bearer !== null && constantTimeSecretEqual(bearer, configuredToken);
}

export const isAuthorized = authenticateRequest;
