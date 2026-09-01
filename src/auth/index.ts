/**
 * Auth module barrel file.
 * Re-exports all auth-related functions.
 */

// Azure CLI exports (for local development and integration tests)
export { getAzureCliToken, checkAzureCliAuth } from "./azureCli.js";
export type { AzureCliToken } from "./azureCli.js";

// Token manager (passthrough-only authentication)
export {
  getAccessToken,
  setSettings,
  initializeAuth,
  logout,
  setPassthroughToken,
  clearPassthroughToken,
  runWithToken,
} from "./tokenManager.js";

// Per-request service-principal credentials supplied as HTTP headers
export {
  readCredentialHeaders,
  getTokenForCredentials,
  clearTokenCache,
} from "./credentialHeaders.js";
export type { HeaderCredentials, HeaderBag } from "./credentialHeaders.js";
