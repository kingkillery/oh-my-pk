# @pk-nerdsaver-ai/pi-chatgpt-connector

A remote MCP server that lets **ChatGPT** launch and drive autonomous **ompk** coding
tasks in an allowlisted set of workspaces — plus the reverse path: an ompk-side
`ask_chatgpt` custom tool that delegates bounded questions to ChatGPT.

Two directions, one package:

- **ChatGPT → ompk** (`ompk-chatgpt serve`): exposes nine MCP tools over a
  Streamable-HTTP transport. ChatGPT calls `launch_task` with an assignment;
  the connector runs it in an ompk agent session inside a configured,
  allowlisted workspace and reports progress, results, and git diffs.
- **ompk → ChatGPT** (`ask_chatgpt` tool): a coding-agent `CustomTool` that asks
  ChatGPT a self-contained question over the OpenAI Responses API and returns
  its answer as tool output.

## Requirements

- Bun ≥ 1.3 (built and tested with `bun test`).
- An ompk installation the connector can drive through `createAgentSession`
  (the coding-agent package is a workspace dependency).
- For ChatGPT connectivity: either a **Secure MCP Tunnel** (recommended for
  personal use) or a public HTTPS endpoint plus an OAuth 2.1 identity provider.

## Install

The package is a Bun workspace member of the `oh-my-pk` monorepo; `bun install`
at the repo root registers it. The CLI binary is `ompk-chatgpt`.

## Configuration

`ompk-chatgpt init` writes `~/.ompk/chatgpt-connector.json`:

```jsonc
{
  "server":  { "host": "127.0.0.1", "port": 8787 },
  "auth":    { "mode": "bearer", "tokens": ["<generated>"] },
  "workspaces": [
    { "id": "api", "path": "C:/dev/api", "allowWrite": true },
    { "id": "docs", "path": "C:/dev/docs", "allowWrite": false }
  ],
  "defaults": { "waitSeconds": 20 },
  "chatgpt":  { "model": "gpt-5.1" }
}
```

Key fields:

| Field | Meaning |
| --- | --- |
| `server.host` / `server.port` | Bind address. Keep loopback-only unless fronted by TLS + auth. |
| `server.publicUrl` | Externally reachable base URL. Drives the OAuth `resource` claim and `WWW-Authenticate` challenge. |
| `server.allowInsecure` | Relaxes the HTTPS requirement on `publicUrl`/`auth.oauth.resource` (dev only). |
| `auth.mode` | `bearer` (static token; for MCP Inspector / private clients), `none` (only behind a tunnel), `oauth` (OAuth 2.1 JWT resource server). |
| `auth.tokens` | Static bearer tokens, ≥ 16 chars each. |
| `auth.allowQueryToken` | Also accept `?token=` (default off; header preferred). |
| `workspaces[]` | Allowlisted directories tasks may run in. `allowWrite: false` mounts a read-only tool profile. `id` defaults to the dir basename and must be unique. |
| `limits` | `maxTasks`, `maxConcurrentTasks`, `taskTimeoutMs`, `idleTtlMs`, `maxEventsPerTask`, `maxResultChars`, `maxDiffChars`, `abortGraceMs`. |
| `defaults.workspace` / `.waitSeconds` / `.model` | Fallbacks when a tool call omits them. |
| `chatgpt.*` | Settings for the reverse `ask_chatgpt` tool (`baseUrl`, `model`, `apiKey`, `timeoutMs`, `reasoningEffort`). |

Environment overrides: `OMPK_CHATGPT_CONFIG`, `_HOST`, `_PORT`, `_PUBLIC_URL`,
`_ALLOW_INSECURE`, `_TOKEN`, `_AUTH`, `_ALLOW_QUERY_TOKEN`, `_WORKSPACES`,
`_WORKSPACE`, `_WAIT_SECONDS`, `_MODEL`, plus `OMPK_CHATGPT_OAUTH_*` for the
OAuth block, and `OMPK_CHATGPT_API_MODEL`, `_API_BASE_URL`, `_API_KEY` /
`OPENAI_API_KEY` for the reverse-path client.

## Running

```bash
ompk-chatgpt                 # same as `serve`
ompk-chatgpt serve --port 8787
ompk-chatgpt doctor          # validates config, workspaces, auth before serving
ompk-chatgpt token           # prints a new strong bearer token
ompk-chatgpt init            # writes the config template (never overwrites)
```

`GET /` and `GET /healthz` are open status endpoints; everything under `/mcp`
requires whichever `auth.mode` you configured.

### Checking with MCP Inspector

```bash
npx @modelcontextprotocol/inspector   # or bunx
# Transport: Streamable HTTP · URL: http://127.0.0.1:8787/mcp
# Auth: Bearer <token from ompk-chatgpt token>
```

`initialize`, `notifications/initialized`, `tools/list`, and `tools/call` should
all negotiate cleanly — the covered surface is exercised by `test/mcp.test.ts`
and `test/http.test.ts` against a real `Bun.serve` listener.

## Connecting ChatGPT

ChatGPT's connector UI **cannot present a custom API key** (per
developers.openai.com plugin docs: no client-credentials, service accounts,
JWT-bearer assertions, or custom keys). The supported paths are:

### Path A — Secure MCP Tunnel (recommended for personal use)

Loopback-bind the server (`server.host: "127.0.0.1"`, `auth.mode: "none"` or a
bearer token your tunnel injects) and register the tunnel's stable `…/mcp` URL
with ChatGPT as a custom MCP server. The tunnel provides the TLS + reachability;
nothing on the public internet ever sees an unauthenticated endpoint.

### Path B — Public HTTPS + OAuth 2.1

For a shared server: put the connector behind TLS, set `server.publicUrl` to its
canonical `https://…` origin, and use `auth.mode: "oauth"` with an external
authorization server (Auth0, Keycloak, …):

```jsonc
"auth": {
  "mode": "oauth",
  "oauth": {
    "resource": "https://connector.example.com/mcp",
    "issuer": ["https://idp.example.com"],
    "audience": ["https://connector.example.com/mcp"],
    "authorizationServers": ["https://idp.example.com"],
    "jwksUri": "https://idp.example.com/.well-known/jwks.json",
    "scopes": ["mcp"]
  }
}
```

The connector then acts as an OAuth 2.1 **protected resource** per RFC 9728:
it serves `/.well-known/oauth-protected-resource`, includes a
`WWW-Authenticate: Bearer resource_metadata="…"` header in its 401s, and verifies
RS256/ES256 access tokens against the IdP's JWKS (with cache + `kid`-rotation
refresh). ChatGPT completes the interactive authorization-code + PKCE flow
with the IdP; ChatGPT itself never sees a static key. mTLS is supported as a
deployment-level control but does not replace user auth.

## Tool reference (ChatGPT → ompk)

| Tool | Writes? | Purpose |
| --- | --- | --- |
| `list_workspaces` | – | Show allowlisted workspaces (id, label, write flag). Call first when you need an id. |
| `launch_task` | **yes** | Start an autonomous ompk task. Returns a `task_id`; long work continues in the background. |
| `get_task` | – | Current state + recent timeline without waiting. |
| `wait_task` | – | Block until the task settles or `timeout_seconds` elapses (max 300). |
| `get_task_result` | – | Final answer text (or progress if still running). |
| `get_task_diff` | – | Git status/diff captured for the workspace after the task. |
| `follow_up_task` | **yes** | Continue a *settled* task's session with another instruction. Fails `task_busy` while running. |
| `cancel_task` | **yes** | Interrupt a queued/running task. |
| `list_tasks` | – | In-memory task history, newest first. |

All tools carry MCP annotations (`readOnlyHint`/`destructiveHint`/`openWorldHint`)
and `outputSchema`s for ChatGPT's confirmation UX and structured result parsing.

### The `ask_chatgpt` tool (ompk → ChatGPT)

`src/chatgpt/tool.ts` exports a coding-agent `CustomToolFactory`. Parameters:

```jsonc
{
  "question": "string (required) — self-contained; ChatGPT cannot see your files",
  "context": "optional extra text pasted into the question",
  "model": "optional override (default: configured model)",
  "reasoningEffort": "low | medium | high"
}
```

The tool is `approval: "exec"`-tiered: it sends arbitrary text to an external
API, so an operator can gate it. It needs `chatgpt.apiKey` or `OPENAI_API_KEY`
in the connector config / environment.

## Security model

- **Workspace allowlist**: tasks can only run in `workspaces[]` dirs; ids are
  opaque and resolved to realpaths at config time. A workspace with
  `allowWrite: false` gets a read-only tool profile — the agent cannot edit,
  delete, or run mutating shell commands there.
- **`autoApprove: true`** in the session runner: the agent acts without
  interactive confirmation. Combined with a write-capable workspace, a
  compromised credential is a file-system compromise — keep the loopback
  default, or front the server with OAuth/TLS. Prefer `allowWrite: false`
  workspaces for read-mostly tasks.
- **No host paths in model output**: `sessionFile` and workspace paths are
  stripped from `tools/call` structured content and text; the model sees ids,
  labels, and relative diff paths only.
- **Bearer tokens** are compared with a constant-time primitive; `redactToken`
  keeps only first/last 4 chars in logs.
- **No persistence**: tasks live in process memory — a restart loses history
  and running tasks. The package is single-process by design.

## Limitations

- Stateless Streamable HTTP: no `Mcp-Session-Id`, no SSE stream, one JSON-RPC
  request → one JSON response per POST. GET `/mcp` is 405 by design.
- Task list is in-memory and capped by `limits.maxTasks` (oldest settled
  records are evicted).
- Runners that ignore their abort signal are force-finalized after
  `limits.abortGraceMs` (default 15 s) so a stuck session can't pin a
  concurrency slot forever.
- The `ask_chatgpt` tool's context is whatever the calling agent pastes into
  `question`/`context`; it has no filesystem or session access.

## Development

```bash
bun install                  # from repo root — registers the workspace
bunx biome check --write .   # format + lint
bun run check                # biome + check:types
bun run check:types          # tsgo --noEmit
bun test                     # 89 tests across protocol, auth, config, manager, http, chatgpt
bun test/smoke.mjs           # manual end-to-end run over real HTTP (not part of `bun test`)
```

`test/smoke.mjs` boots a real connector server with an injected runner stub,
drives a task through the MCP protocol over HTTP, and asserts the model-facing
output stays path-free. Run it after changes to the transport or auth layer.
