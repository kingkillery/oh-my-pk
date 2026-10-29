# ompk-fleet-gateway

One MCP connection that routes coding work to **ompk connectors on every enrolled machine** — the T3 "one MCP controls the whole fleet" pattern for oh-my-pk.

```
ChatGPT (or any MCP agent)
        │
        │  one Bearer token (or OAuth grant)
        ▼
  ompk-fleet-gateway  ←── you run this
        │
        ├─ host: this-machine  → ompk-chatgpt connector
        ├─ host: dev-box       → ompk-chatgpt connector (over ssh/tailscale)
        └─ host: workstation   → ompk-chatgpt connector
```

The connector (`@pk-nerdsaver-ai/pi-chatgpt-connector`) on each host is the fleet's *agent*; this gateway is its *front door*. Agents get `work_*` tools and a single feed over every job on every host they are allowed to see.

## Install

```sh
# in the oh-my-pk repo
bun install
# binary: packages/fleet-gateway/src/cli.ts → ompk-fleet-gateway
```

## 60-second setup

```sh
# 1. write a starter config at ~/.ompk/fleet-gateway.json
ompk-fleet-gateway init

# 2. edit hosts[] (each a machine running `ompk-chatgpt serve`) and
#    workspaces[] (aliases agents use, each {host, workspace}).

# 3. run the gateway
ompk-fleet-gateway serve
# listening   http://127.0.0.1:3880  (public: http://127.0.0.1:3880)

# 4. check everything at once
ompk-fleet-gateway doctor
```

## Config

`~/.ompk/fleet-gateway.json` (or `--config PATH` / `OMPK_FG_CONFIG`):

```jsonc
{
  "publicUrl": "http://127.0.0.1:3880",   // where agents can reach the gateway
  "listen":    { "host": "127.0.0.1", "port": 3880 },
  "hosts": [
    {
      "id": "this-machine",               // <=32 chars, becomes host:<id>:*
      "label": "This machine",
      "connectorUrl": "http://127.0.0.1:3939",   // `ompk-chatgpt serve`
      // the gateway's bearer credential into that connector, either:
      "token": "paste-a-connector-token",
      // or minted once at startup:
      "tokenCommand": ["ompk-chatgpt", "token"],
      "maxConcurrentJobs": 2,
      "defaultWorkspace": "repo"          // alias used when only `host` is named
    }
  ],
  "workspaces": [
    { "alias": "repo", "host": "this-machine", "workspace": "repo",
      "allowStart": true, "model": "opus" }
  ]
}
```

`workspace` is the **connector's** workspace id on that host; `alias` is what agents pass. `allowStart: false` makes an alias read-only (watch, results, diff — no `work_start`).

`connectorUrl`/`listen` may use `http` only on a loopback host; anything else must be `https`.

## Enrolling an agent

Two ways in — both end as the same `Authorization: Bearer …` on `POST /mcp`.

### A. One-time approval code → OAuth (recommended for ChatGPT)

```sh
ompk-fleet-gateway pair          # XXXXX-XXXXX, one use, 15 minutes
```

Point the agent at `https://your-gateway/mcp`. It registers, opens `/oauth/authorize` in a browser, you choose **Read | Operate** over **All machines | Selected machines** and paste the code. The agent holds a rotating refresh token from then on.

### B. Long-lived bearer token (agents without OAuth)

```sh
ompk-fleet-gateway token --name claude --access operate --hosts all
ompk-fleet-gateway token --name watcher --access read --hosts this-machine --ttl 86400
```

## Scopes

| Scope | Covers |
|---|---|
| `fleet:read` | `fleet_status`, `fleet_workspaces`, `work_list/status/result/diff/feed/messages` on every host |
| `fleet:operate` | `fleet:read` + `work_start`, `work_continue`, `work_cancel` |
| `host:<id>:read` / `host:<id>:operate` | the same, one host only |

A job on a host the caller can't read is `not_found` — never "exists but denied".

## Tools an agent sees

`fleet_status` · `fleet_workspaces` · `work_list` · `work_status` · `work_result` · `work_diff` · `work_feed` · `work_messages` · `work_start` · `work_continue` · `work_cancel`

Lifecycle: `work_start` → job `queued` → the watcher launches it → `running` → settles to `idle` → `work_result`. `work_feed` is one cursor over every job. Every mutating tool takes a `requestId` so retries are safe.

## Operator commands

| Command | Does |
|---|---|
| `serve` | run the gateway |
| `init` | write `~/.ompk/fleet-gateway.json` |
| `pair [--label L]` | mint a 15-minute approval code |
| `token --name N --access r\|o [--hosts a,b\|all] [--ttl s]` | mint a bearer client |
| `clients` / `clients revoke <id>` | list / revoke enrolled agents |
| `hosts` | reachability + live-task count per connector |
| `jobs [--state S]` | ledger jobs |
| `doctor` | config + hosts + ledger in one pass |

## Design

See [DESIGN.md](./DESIGN.md). Job states `queued → dispatching → running → idle`, `cancel_requested → cancelled`, `failed`, `released`, `unknown`; launches are reconciled by a `[job:<id>]` marker in the task title, never retried blindly. The ledger (`~/.ompk/fleet-gateway/fleet-gateway.sqlite`) survives restarts; connector tasks are memory-only, so a restarted host is reported honestly as `task_lost`.
