/**
 * HTTP transport entry point for cloud deployment.
 * Creates an Express app that handles MCP requests over HTTP.
 *
 * Used by:
 * - Standalone HTTP server (DigitalOcean App Platform, containers, local test)
 * - Azure Functions uses its own entry point in ../functions/index.ts
 *
 * Request flow:
 *   1. shared-secret gate  - rejects anonymous traffic before any work happens
 *   2. credential resolve  - service-principal headers, or a bearer token
 *   3. runWithToken        - binds the ARM token to this request's async context
 */

import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerToolsAndPrompts } from "../server.js";
import { loadSettings } from "../config/index.js";
import { setSettings, initializeAuth, runWithToken } from "../auth/index.js";
import { readCredentialHeaders, getTokenForCredentials } from "../auth/credentialHeaders.js";
import { checkSharedSecret, warnIfGateDisabled, SHARED_SECRET_HEADER } from "./sharedSecret.js";
import { setCacheTtl } from "../tools/index.js";
import { McpError } from "../utils/errors.js";
import { VERSION } from "../version.js";

let initialized = false;

/**
 * Initialize auth and settings (called once on cold start).
 */
async function ensureInitialized(): Promise<void> {
  if (initialized) return;

  const settings = await loadSettings();
  setSettings(settings);
  setCacheTtl(settings.cacheTtlSeconds);
  await initializeAuth();
  initialized = true;
}

/**
 * Create a new MCP server instance.
 * Each request gets its own server for stateless operation.
 */
function createMcpServer(): McpServer {
  const mcpServer = new McpServer(
    { name: "logicapps-mcp", version: VERSION },
    { capabilities: { tools: {}, prompts: {} } }
  );
  registerToolsAndPrompts(mcpServer);
  return mcpServer;
}

/**
 * Send a JSON-RPC error response.
 */
function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

/**
 * Resolves the ARM token for this request.
 *
 * Service-principal headers take precedence; a bearer token in the
 * Authorization header remains supported for callers who already hold one.
 */
async function resolveToken(req: Request): Promise<string> {
  const creds = readCredentialHeaders(req.headers);
  if (creds) {
    return getTokenForCredentials(creds);
  }

  const bearerToken = req.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
  if (bearerToken) {
    return bearerToken;
  }

  throw new McpError(
    "AuthenticationError",
    "Credentials required. Provide X-Azure-Tenant-Id, X-Azure-Client-Id and " +
      "X-Azure-Client-Secret headers, or an Authorization header carrying an " +
      "ARM-scoped bearer token."
  );
}

/**
 * Handle MCP POST requests.
 * Creates a new stateless server for each request.
 */
async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const gate = checkSharedSecret(req.headers);
  if (!gate.allowed) {
    console.error(`[security] rejected /mcp request (${gate.reason})`);
    sendJsonRpcError(
      res,
      401,
      -32001,
      `Unauthorized. This server requires a valid ${SHARED_SECRET_HEADER} header.`
    );
    return;
  }

  let token: string;
  try {
    await ensureInitialized();
    token = await resolveToken(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Authentication failed";
    console.error("Auth error handling MCP request:", message);
    sendJsonRpcError(res, 401, -32001, message);
    return;
  }

  try {
    await runWithToken(token, async () => {
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);

      res.on("close", () => {
        transport.close();
        mcpServer.close();
      });
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    sendJsonRpcError(res, 500, -32603, "Internal server error");
  }
}

/**
 * Handle unsupported methods (GET, DELETE).
 * Stateless mode doesn't support SSE streams or session management.
 */
function handleMethodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. This server only supports POST requests.",
    },
    id: null,
  });
}

/**
 * Create Express app for MCP HTTP transport.
 */
export function createMcpApp(): express.Application {
  const app = express();

  // Parse JSON bodies
  app.use(express.json());

  // Health check endpoint - intentionally ungated so platform probes work
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: VERSION });
  });

  // MCP endpoints
  app.post("/mcp", handleMcpPost);
  app.get("/mcp", handleMethodNotAllowed);
  app.delete("/mcp", handleMethodNotAllowed);

  return app;
}

/**
 * Start standalone HTTP server.
 */
export async function startHttpServer(port: number = 3000): Promise<void> {
  const app = createMcpApp();

  warnIfGateDisabled();

  app.listen(port, () => {
    console.log(`MCP HTTP Server listening on port ${port}`);
  });

  process.on("SIGINT", () => {
    console.log("Shutting down server...");
    process.exit(0);
  });
}
