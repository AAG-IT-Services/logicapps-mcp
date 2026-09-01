/**
 * Token manager for passthrough authentication.
 *
 * The ARM token is held in AsyncLocalStorage so that concurrent MCP requests
 * cannot read each other's credentials. The previous implementation kept a
 * single module-scoped variable, which meant two overlapping requests on one
 * Node process could interleave and send request A's ARM call with request B's
 * token.
 *
 * setPassthroughToken/clearPassthroughToken are kept as a process-wide fallback
 * so the Azure Functions entry point and the integration test harness continue
 * to work unchanged. The async-local value always wins when both are present.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { LogicAppsMcpSettings } from "../config/settings.js";
import { McpError } from "../utils/errors.js";

interface TokenContext {
  token: string;
}

const tokenStore = new AsyncLocalStorage<TokenContext>();

let cachedSettings: LogicAppsMcpSettings | null = null;
let fallbackToken: string | null = null;

export function setSettings(settings: LogicAppsMcpSettings): void {
  cachedSettings = settings;
}

/**
 * Runs `fn` with `token` bound to the current async context.
 *
 * Preferred over setPassthroughToken anywhere requests can overlap, which is
 * every HTTP transport.
 */
export function runWithToken<T>(token: string, fn: () => Promise<T>): Promise<T> {
  return tokenStore.run({ token }, fn);
}

/**
 * Sets a process-wide passthrough token.
 *
 * Only safe where requests cannot overlap (stdio, or the single-invocation
 * Azure Functions model). Prefer runWithToken.
 */
export function setPassthroughToken(token: string): void {
  fallbackToken = token;
}

/**
 * Clears the process-wide passthrough token.
 */
export function clearPassthroughToken(): void {
  fallbackToken = null;
}

/**
 * Initializes settings (no auth check needed - passthrough only).
 */
export async function initializeAuth(): Promise<void> {
  if (!cachedSettings) {
    throw new McpError("AuthenticationError", "Settings not initialized");
  }
  console.error("MCP server ready (passthrough auth mode)");
}

/**
 * Gets a valid access token for the Azure ARM API.
 */
export async function getAccessToken(): Promise<string> {
  const token = tokenStore.getStore()?.token ?? fallbackToken;

  if (!token) {
    throw new McpError(
      "AuthenticationError",
      "Credentials required. Provide X-Azure-Tenant-Id, X-Azure-Client-Id and " +
        "X-Azure-Client-Secret headers, or an Authorization header carrying an " +
        "ARM-scoped bearer token."
    );
  }

  return token;
}

/**
 * No-op for passthrough mode.
 */
export async function logout(): Promise<void> {
  clearPassthroughToken();
}
