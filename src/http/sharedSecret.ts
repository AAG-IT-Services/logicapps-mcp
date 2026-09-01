/**
 * Shared-secret gate for the HTTP transport.
 *
 * App Platform (and any other public host) gives the server an internet-facing
 * URL with no gateway auth in front of it. Without a gate, anyone who finds the
 * URL can POST to /mcp: they cannot reach Azure without valid credentials, but
 * every request still wakes the process, allocates an MCP server and transport,
 * and consumes the instance.
 *
 * The gate is deliberately dumb - one shared secret, checked before any Azure
 * work happens. It is a bouncer, not an authorization model; the real access
 * control is the caller's service principal and its RBAC scope.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const SHARED_SECRET_HEADER = "x-mcp-secret";
export const SHARED_SECRET_ENV = "MCP_SHARED_SECRET";

export type GateResult =
  | { allowed: true; reason: "disabled" | "matched" }
  | { allowed: false; reason: "missing" | "mismatch" };

/**
 * Constant-time comparison of two secrets.
 *
 * Both sides are hashed first so the buffers are always the same length -
 * timingSafeEqual throws on length mismatch, and comparing raw values would
 * leak the secret's length through that throw.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Reads the configured secret. Returns null when the gate is disabled.
 *
 * `env` is injectable for tests; it defaults to the process environment.
 */
export function getConfiguredSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[SHARED_SECRET_ENV]?.trim();
  return value ? value : null;
}

/**
 * Decides whether a request may proceed.
 *
 * When no secret is configured the gate is disabled and everything passes, so
 * local development and the stdio path are unaffected.
 */
export function checkSharedSecret(
  headers: Record<string, string | string[] | undefined>,
  env: NodeJS.ProcessEnv = process.env
): GateResult {
  const expected = getConfiguredSecret(env);

  if (!expected) {
    return { allowed: true, reason: "disabled" };
  }

  const raw = headers[SHARED_SECRET_HEADER];
  const provided = (Array.isArray(raw) ? raw[0] : raw)?.trim();

  if (!provided) {
    return { allowed: false, reason: "missing" };
  }

  return secretsMatch(provided, expected)
    ? { allowed: true, reason: "matched" }
    : { allowed: false, reason: "mismatch" };
}

/**
 * Logs once at startup so an unprotected deployment is obvious in the run logs
 * rather than a silent default.
 */
export function warnIfGateDisabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!getConfiguredSecret(env)) {
    console.error(
      `[security] ${SHARED_SECRET_ENV} is not set - /mcp is open to anonymous requests. ` +
        `Set it and send the value as the ${SHARED_SECRET_HEADER} header.`
    );
  }
}
