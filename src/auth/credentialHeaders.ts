/**
 * Per-request Entra credentials supplied as HTTP headers.
 *
 * Upstream expects the caller to pass an ARM-scoped bearer token in the
 * Authorization header. Those tokens expire in roughly an hour, which makes a
 * hosted deployment impractical - the operator would have to paste a fresh
 * token into their MCP client config several times a day.
 *
 * This module lets the caller supply a service principal instead, and the
 * server exchanges it for an ARM token on their behalf. Credentials are never
 * read from the process environment, so one deployment can serve several
 * callers, each with their own principal and their own RBAC scope.
 */

import { ClientSecretCredential } from "@azure/identity";
import { McpError } from "../utils/errors.js";

const ARM_SCOPE = "https://management.azure.com/.default";

/** Refresh this long before actual expiry, so in-flight calls do not race it. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export interface HeaderCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

interface CachedToken {
  token: string;
  expiresOnMs: number;
}

const tokenCache = new Map<string, CachedToken>();

export type HeaderBag = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Extracts service-principal credentials from request headers.
 *
 * Returns null when none of the three headers are present, so the caller can
 * fall back to an Authorization bearer token. Throws when the set is partial,
 * because that is a misconfiguration rather than a choice of auth mode.
 */
export function readCredentialHeaders(headers: HeaderBag): HeaderCredentials | null {
  const tenantId = firstValue(headers["x-azure-tenant-id"]);
  const clientId = firstValue(headers["x-azure-client-id"]);
  const clientSecret = firstValue(headers["x-azure-client-secret"]);

  if (!tenantId && !clientId && !clientSecret) {
    return null;
  }

  if (!tenantId || !clientId || !clientSecret) {
    const missing = [
      tenantId ? null : "X-Azure-Tenant-Id",
      clientId ? null : "X-Azure-Client-Id",
      clientSecret ? null : "X-Azure-Client-Secret",
    ].filter(Boolean);

    throw new McpError(
      "AuthenticationError",
      `Incomplete credential headers. Missing: ${missing.join(", ")}.`
    );
  }

  return { tenantId, clientId, clientSecret };
}

/**
 * Exchanges service-principal credentials for an ARM access token.
 *
 * Tokens are cached per credential set until shortly before expiry, so a burst
 * of tool calls costs one round trip to Entra rather than one per call.
 */
export async function getTokenForCredentials(creds: HeaderCredentials): Promise<string> {
  const cacheKey = `${creds.tenantId}|${creds.clientId}|${creds.clientSecret}`;
  const cached = tokenCache.get(cacheKey);

  if (cached && cached.expiresOnMs - EXPIRY_SKEW_MS > Date.now()) {
    return cached.token;
  }

  let accessToken;
  try {
    const credential = new ClientSecretCredential(
      creds.tenantId,
      creds.clientId,
      creds.clientSecret
    );
    accessToken = await credential.getToken(ARM_SCOPE);
  } catch (error) {
    throw new McpError(
      "AuthenticationError",
      `Failed to acquire an ARM token for client ${creds.clientId}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!accessToken?.token) {
    throw new McpError(
      "AuthenticationError",
      `Entra returned no token for client ${creds.clientId}.`
    );
  }

  tokenCache.set(cacheKey, {
    token: accessToken.token,
    expiresOnMs: accessToken.expiresOnTimestamp,
  });

  return accessToken.token;
}

/**
 * Drops every cached ARM token. Exposed for tests and for a future
 * credential-rotation hook.
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}
