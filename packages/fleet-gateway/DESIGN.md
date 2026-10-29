# ompk-fleet-gateway design

Status: proposed for v0.1. Ports the [t3-fleet-gateway](https://github.com/boundsj/t3-fleet-gateway) pattern to ompk: one MCP connection lets a hosted agent hand coding work to ompk on any enrolled machine and follow it to completion.

## Outcome

A cloud agent (ChatGPT, Grok Bot, any MCP client) says *what* to do in *which workspace*, or on *which machine* when no workspace is named. The gateway decides *where* and *how*: which host, which allowlisted workspace id, the connector task, and watching it. The operator never manages per-machine MCP connections or polls tasks by hand.

The per-host **ChatGPT connector** (`@pk-nerdsaver-ai/pi-chatgpt-connector`) is the execution surface — the analog of the T3 Code server. Its nine tools are the host protocol:

| Connector tool | Fleet use |
| --- | --- |
| `list_workspaces` | `fleet_status`/`fleet_workspaces`, `work_start` resolution, doctor |
| `launch_task` (with `title` carrying `[job:<id>]`) | `work_start` dispatch and reconciliation marker |
| `get_task` | `work_status`, watcher state, reconciliation probe |
| `list_tasks` | `work_list` merge source, launch-loss marker search |
| `wait_task` | not used by the gateway; kept for direct clients |
| `get_task_result`, `get_task_diff` | `work_result`, `work_diff` |
| `follow_up_task` | `work_continue` |
| `cancel_task` | `work_cancel` |

Two credential audiences never mix. Agent tokens are only valid at the gateway. Host bearer tokens never leave the gateway process (they sit in config or are minted by `tokenCommand` at startup; never logged, never returned in tool output).

### In scope for v0.1

- One gateway process on an always-on machine, reachable over HTTPS through a tunnel the operator provides (or loopback for local clients).
- Agent-facing MCP server (stateless Streamable HTTP, JSON responses — the same transport shape as the connector, already proven against ChatGPT).
- Gateway-side OAuth 2.1 authorization server: dynamic registration, PKCE S256, approval-code page (Read/Operate × All machines/Selected machines), access + rotating refresh tokens. Plus `clients token` CLI minting for header-only clients.
- Downstream MCP client to enrolled connectors, per-host bearer auth.
- Durable job ledger in SQLite (`bun:sqlite`, WAL), the tools below, a watcher/dispatcher loop, and an operator CLI.
- Multi-host config and routing by workspace alias.

### Out of scope for v0.1 (declared missing, not faked)

- `work_respond` / `needs_input`: connector tasks are autonomous — the session prompt forbids questions and write ceilings use tool profiles, not approval prompts. A job can never wait on an answer, so no answer tool exists.
- `fleet_models` / `modelSelection`: the connector exposes no model catalog; `model` is an opaque passthrough selector. The gateway validates nothing about it.
- Standing jobs, thread adoption, thread settlement, webhooks, the dashboard, workspace probes, attachments. Each maps to a T3 feature that needs either a T3-native concept ompk does not have or a larger seam; the tool table below marks them rather than shipping stubs.
- Host-initiated enrollment (hosts dialing out). Hosts are dialed in, which means a host behind NAT needs its connector reachable via a tunnel or the gateway co-located.

## Architecture

```
Agent (ChatGPT, any MCP client)
   │  HTTPS, OAuth 2.1 or bearer (gateway-issued; audience = this gateway)
   ▼
ompk-fleet-gateway  ── SQLite (clients, tokens, hosts, jobs, events, request ids)
   │  MCP JSON-RPC client per host, bearer token for that host's connector
   ▼
ompk-chatgpt connector(s)  ──► ompk tasks in allowlisted workspaces
```

### Runtime

- Bun-first like the connector (Bun ≥1.3): TypeScript run directly, `bun:sqlite` for the ledger, `Bun.serve` or `node:http` for transport. No Express/Hono, no MCP SDK dependency — the connector's own hand-rolled JSON-RPC core already interops with ChatGPT, and v1 of the gateway stays server-side only.
- Runtime deps: none beyond the workspace (reuse the connector's MCP server-core approach; no `zod` — tool schemas stay hand-written JSON Schema, matching the connector).
- Tests: `bun test`, fake `HostClient` + fake ledger, contract/boundary tests only.

### Process layout

`ompk-fleet-gateway serve` runs the HTTP server, watcher, and dispatcher. The CLI shares the SQLite file, so `pair`, `clients token`, `enroll` and `jobs release` act without a restart.

## Configuration

`$OMPK_FG_CONFIG` or `~/.ompk/fleet-gateway.json`; data dir `$OMPK_FG_DATA_DIR` or `~/.ompk/fleet-gateway/`, created `0700`, db `0600`, refused when world-readable on POSIX.

```jsonc
{
  "publicUrl": "https://gateway.example.com",        // origin agents use
  "listen": { "host": "127.0.0.1", "port": 3880 },   // loopback only
  "hosts": [
    {
      "id": "main",
      "label": "Always-on workstation",
      "connectorUrl": "http://127.0.0.1:8787",       // http only on loopback
      "tokenCommand": ["ompk-chatgpt", "token"],      // argv minted at enroll,
      "token": null,                                  // or a stored bearer token
      "maxConcurrentJobs": 2,
      "defaultWorkspace": "oh-my-pk"                  // fallback when a job names no workspace
    }
  ],
  "workspaces": [                                     // what agents see
    { "alias": "oh-my-pk", "description": "The ompk monorepo", "host": "main", "workspace": "oh-my-pk", "model": null, "allowStart": true, "default": true }
  ],
  "tokens": { "accessTtlSeconds": 43200, "refreshIdleTtlDays": 90 },
  "watcher": { "pollSeconds": 10, "hostBackoffSeconds": 60 },
  "limits": { "taskChars": 20000, "jobsPerClient": 200 }
}
```

Rules: `connectorUrl` `http` only on loopback hosts; `listen.host` loopback only; `defaultWorkspace` must name a configured workspace alias on the same host; a `tokenCommand` is argv (no shell) run once per process start to mint the host credential — the ompk analog of T3's `mintPairingCode` (e.g. `["ompk-chatgpt", "token"]` on a co-located host, `["ssh", "box", "ompk-chatgpt", "token"]` for a remote one).

## Authorization

Same shape as T3: the gateway is its own OAuth 2.1 AS.

- `/.well-known/oauth-protected-resource` + `/.well-known/oauth-authorization-server`, S256 only, `authorization_code` + `refresh_token`, public clients via `POST /oauth/register` (RFC 7591; https or loopback redirects only, caps on count/length).
- `GET /oauth/authorize` renders a server-side approval page (no external assets, `frame-ancestors 'none'`, `X-Frame-Options: DENY`): client name, full redirect origin, and the operator's choices — **Read** / **Operate**, **All machines** / **Selected machines** — gated by a one-time approval code minted with `ompk-fleet-gateway pair`.
- Approval codes: 10 Crockford base32 chars (`XXXXX-XXXXX`), HMAC-SHA256 stored, 15-min TTL, single use; 5 failures lock the request, 20/hr lock the page; minting a new code ends the global lock.
- `POST /oauth/token`: single-use 60 s codes, PKCE + redirect + client + resource checks; refresh rotation with a 2-minute sibling grace window and family revocation on replay.
- Tokens: 256-bit random, SHA-256 hashed at rest, bound to resource + scopes.
- Scopes: `fleet:read`, `fleet:operate` (all hosts incl. future), `host:<id>:read`, `host:<id>:operate`. Permission is a union; malformed scope strings grant nothing; a scope naming an unconfigured host grants nothing live.
- `clients token --name X --access operate|read --hosts all|a,b [--ttl …]` mints a one-shot bearer for header-only clients, stored hashed, revoke via `clients revoke`.

## Tools

Scopes: **read** = `fleet:read` or `host:<h>:read` on the touched host; **operate** likewise. A job on a host the caller cannot read is `not_found`; readable but not operable is `insufficient_scope`.

| Tool | Scope | Purpose |
| --- | --- | --- |
| `fleet_status` | read | Hosts (reachable, connector version, credential validity, running/queued counts, `defaultWorkspace`), configured workspace aliases, gateway version |
| `fleet_workspaces` | read | Live `list_workspaces` per enrolled host (paged per host), merged with configured aliases |
| `work_list` | read | Ledger jobs filtered by workspace alias, host and state, newest first, bounded |
| `work_status` | read | One job: state, host, workspace, connector task id, title, timestamps, latest progress excerpt, `lastError`, settled flag |
| `work_messages` | read | Task progress/events text paged back (`before`) and forward (`after`) from the connector record |
| `work_result` | read | `get_task_result`: final answer text for a settled job, progress for a running one |
| `work_diff` | read | `get_task_diff`: the workspace git diff captured for the job |
| `work_feed` | read | `job_events` since a cursor + jobs needing attention; the agent's scheduled-poll surface |
| `work_start` | operate | Launch a task: `workspace` alias, or `target: { host }` for the host's `defaultWorkspace`, `task`, optional `title`, `model`, `timeout_seconds`. Idempotent on `requestId` |
| `work_continue` | operate | `follow_up_task` on a settled job. Idempotent on `requestId` |
| `work_cancel` | operate | `cancel_task`; `cancel_requested` until the watcher confirms, then `cancelled` |

Errors are tool errors (`isError: true`) with stable codes: `not_found`, `job_state_conflict`, `request_id_conflict`, `start_disabled`, `host_unreachable`, `unknown_task`, `invalid_request`, `insufficient_scope`, `internal_error`.

## Jobs

### States

`queued → dispatching → running → idle`, `cancel_requested → cancelled`, `failed`, `unknown`. `idle` = the connector task is in a settled state (`completed`, `failed`, `cancelled`, `timed_out`) and can still be continued via `work_continue` while the host retains it. `unknown` = launch response lost; reconciled, never auto-retried. Terminal for ledger purposes: `cancelled`, `failed` (launch rejected or task evicted/forgotten by host), plus `released` for operator-dropped follow.

Every transition appends `job_events` (monotonic id = feed cursor).

### Launch

1. Validate scope, workspace resolution, task length; check `(clientId, tool, requestId)` — same input hash returns the existing job, different input is `request_id_conflict`.
2. Insert `queued` + `created` event in one transaction.
3. Dispatcher (host under `maxConcurrentJobs`) marks `dispatching`, calls `launch_task` with `title` = `<agent title or task first line> [job:<id>]`, `wait_seconds: 0`, `model`, `timeout_seconds`.
4. Result → `running` with the connector task id. `unknown_workspace`/`invalid_request` → `failed` with the connector's code. Transport errors with `delivery: not_delivered` → back to `queued` + host backoff. Timeouts/`5xx` after send → `unknown` (the task may exist).

### Reconciliation

On startup, `dispatching`/`unknown` jobs are probed: `list_tasks` filtered by title containing `[job:<id>]`; found → attach and resume watching; not found within the window with the host reachable → `failed` (`launch_not_confirmed`). A `running` job whose task id the host no longer knows (`unknown_task`) is `failed` (`task_lost`) — connector tasks are memory-only, so a host restart retires them; the feed says so rather than pretending.

### Watching

`pollSeconds` tick per host with open jobs: reconciliation → watch → dispatch, ticks never overlap, hosts in parallel. Watch = `get_task` per active job; map connector states (`queued`/`running` → `running`, settled → `idle`), record `progress.lastText` excerpt, emit `state_changed`/`followup_sent`/`cancel_confirmed` events. Unreachable host: backoff, `hostUnreachableSince`, job state preserved.

### Cancel / continue

`work_cancel` → `cancel_task`, `cancel_requested` until the watcher sees a settled state → `cancelled` (queued jobs cancel locally). `work_continue` → `follow_up_task`; allowed on `idle` jobs only, returns to `running`.

## CLI

- `serve` — run gateway; refuses permissive data-dir.
- `pair [--ttl]` — mint an approval code.
- `enroll <id> --url <connectorUrl> [--workspace <id>…]` — probe `list_workspaces`, verify auth, mint via `tokenCommand` or accept `--token`, write host + workspace aliases into config.
- `clients list|diagnose|token|revoke` — same semantics as T3's (no token or hash ever printed).
- `jobs list|release` — operator view; `release` stops following a job (host task untouched).
- `doctor` — per host: URL scheme/loopback rules, credential reachability, `list_workspaces` against configured aliases, `defaultWorkspace` validity, data-dir modes, Node/Bun version.

## Evidence gates

1. `bun test` green: protocol negotiation, scope enforcement, idempotent launch/continue, state machine, reconciliation-by-marker, ledger migrations.
2. `bun run check` + `check:types` clean.
3. Smoke: fake connector in-process (its `McpServer` + `TaskService` fake) enrolled; `work_start` → `work_feed` → `work_result` round trip over real HTTP.
4. `doctor` output names what it verified per host.
