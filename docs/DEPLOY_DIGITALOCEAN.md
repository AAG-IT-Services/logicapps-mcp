# Deploying to DigitalOcean App Platform

This fork adds an HTTP deployment path that does not depend on Azure Functions.
Three changes make that possible:

1. The Express transport reads credentials from request headers. Upstream only
   did this in the Azure Functions entry point, so the standalone server started
   fine and then failed every tool call with "Bearer token required".
2. Callers may supply a service principal instead of an ARM bearer token. ARM
   tokens expire in about an hour, which is impractical for a hosted server.
3. A shared-secret header gates `/mcp` against anonymous traffic.

## Authentication

Two modes, checked in this order.

**Service principal (preferred).** Send all three headers:

| Header | Value |
| --- | --- |
| `X-Azure-Tenant-Id` | Directory (tenant) ID |
| `X-Azure-Client-Id` | Application (client) ID |
| `X-Azure-Client-Secret` | Client secret value |

The server exchanges them for an ARM token via `ClientSecretCredential` and
caches it until five minutes before expiry. Sending a partial set is an error
rather than a fallback, so a typo fails loudly.

**Bearer token.** `Authorization: Bearer <arm-token>` still works for callers
who already hold one, e.g. `az account get-access-token --resource
https://management.azure.com`.

No credentials are read from the environment. Each caller's RBAC decides what
they can reach, so one deployment can serve several people at different scopes.

### Suggested RBAC

Assign **Reader** on the resource group, not the subscription:

```bash
az role assignment create \
  --assignee <appId> \
  --role Reader \
  --scope "/subscriptions/<sub>/resourceGroups/<rg>"
```

Reader covers `list_workflows`, `get_workflow_definition`, run history and
action IO. It does not cover `listCallbackUrl`, so `get_trigger_callback_url`
will fail. The write tools (`create_workflow`, `delete_workflow`,
`disable_workflow`, `run_trigger`, `resubmit_run`) stay visible in the tool list
but fail at ARM with 403.

## Shared secret

Set `MCP_SHARED_SECRET` on the service and send it as `X-MCP-Secret` on every
`/mcp` request. Requests without it are rejected with 401 before any Azure work
happens.

```bash
openssl rand -base64 32
```

`/health` is deliberately ungated so platform probes keep working.

If `MCP_SHARED_SECRET` is unset the gate is disabled and the server logs a
`[security]` warning at startup. That keeps local development and the stdio path
unchanged, but never leave a public deployment in that state.

## Deploy

```bash
doctl apps create --spec .do/app.yaml
doctl apps list
doctl apps logs <app-id> --type run --follow
```

Use the Dockerfile rather than App Platform's Node buildpack. The buildpack runs
`npm start`, which is `node dist/index.js` with no `--http`, so the container
starts in stdio mode and never listens.

## Smoke test

```bash
curl https://<app>.ondigitalocean.app/health

curl -X POST https://<app>.ondigitalocean.app/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-MCP-Secret: $MCP_SHARED_SECRET" \
  -H "X-Azure-Tenant-Id: $AZ_TENANT_ID" \
  -H "X-Azure-Client-Id: $AZ_CLIENT_ID" \
  -H "X-Azure-Client-Secret: $AZ_CLIENT_SECRET" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

| Response | Meaning |
| --- | --- |
| 401, "requires a valid x-mcp-secret header" | Gate rejected the request — wrong or missing `X-MCP-Secret` |
| 401, "Credentials required" | Gate passed, but no Azure credential headers arrived |
| 401, "Failed to acquire an ARM token" | Entra rejected the service principal |
| 403 inside a tool result | Token is valid, RBAC does not allow that operation |
| 405 on `GET /mcp` | Expected — this server is POST-only |

## MCP client config

```json
{
  "mcpServers": {
    "logicapps": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://<app>.ondigitalocean.app/mcp",
        "--transport", "http-only",
        "--header", "X-MCP-Secret:${MCP_SHARED_SECRET}",
        "--header", "X-Azure-Tenant-Id:${AZ_TENANT_ID}",
        "--header", "X-Azure-Client-Id:${AZ_CLIENT_ID}",
        "--header", "X-Azure-Client-Secret:${AZ_CLIENT_SECRET}"
      ],
      "env": {
        "MCP_SHARED_SECRET": "...",
        "AZ_TENANT_ID": "...",
        "AZ_CLIENT_ID": "...",
        "AZ_CLIENT_SECRET": "..."
      }
    }
  }
}
```

Two syntax traps: no space after the colon in `--header` when interpolating a
variable, because `mcp-remote` splits on the first colon and a space ends up
inside the value; and pin `--transport http-only`, because the server answers
`GET /mcp` with 405 and a client that probes SSE first will fail its handshake.

## Operational notes

- Keep `LOGICAPPS_MCP_LOG_LEVEL` at `info`. At `debug`, request headers —
  including the caller's client secret — can reach the run logs in plaintext.
- Client secrets expire. The failure mode is every tool returning an auth error
  at once with nothing else obviously changed; set a reminder before expiry.
- The `knowledge/` directory must ship in the image. The knowledge tools read it
  from `/app/knowledge` at runtime, which is why `.dockerignore` excludes
  neither it nor `*.md`.
- Do not set `MCP_PORT` unless it matches `http_port`. `parseArgs()` lets
  `MCP_PORT` override `--port`, and a mismatch leaves the container listening on
  one port while the platform health-checks another.
