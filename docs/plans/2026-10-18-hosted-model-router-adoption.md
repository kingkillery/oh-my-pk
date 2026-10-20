# Hosted Model Router — Task Reference & Checkpoints

**Run:** October 18, 2026 (America/Denver; verification continued into October 19 UTC)  
**Canonical working copy:** `C:\dev\Infra\oh-my-pk\docs\plans\2026-10-18-hosted-model-router-adoption.md` on PK Windows  
**Hosted endpoint:** `https://api.gopk.xyz` · Cloudflare Worker `free-tier-router` (production)  
**Objective:** Reuse one existing hosted model router across agents without duplicating infrastructure.

## Starting constraints
- The OMPK working tree was already dirty, on branch `fix/clef-bootstrap-jev-gate-criteria`, HEAD `05f5e9491c`; preserve unrelated changes.
- No secrets in logs, documents, or CLI arguments. No token rotation, unauthenticated workaround, or speculative deployment.
- Existing Cloudflare tunnels and DNS remain unless consumers are verified and retirement is explicitly scoped.
- Checkpoints are appended after each workstream; an earlier completed step is not rerun without new evidence.

## Step 1 — Authentication and inference
**Status: Blocked at authenticated inference; public API checks verified.**

- `GET /health` returns HTTP 200.
- `GET /v1/models` and `GET /v1/routes` return HTTP 401 without a router key, as designed.
- The deployed Worker has a `ROUTER_API_KEY` secret binding, but this does not grant access to its plaintext.
- Checked environment-variable names on PK and MSI: no router credential found. A separate provider credential cannot be substituted.
- No billable model completion was run or claimed successful.

**Checkpoint #1:** Authentication gate verified. No production changes. Remaining dependency: authorized router credential and a bounded successful chat completion.

## Step 2 — Existing routing behavior
**Status: Implementation/configuration verified; failure-path runtime test pending.**

Observed production configuration:

| Control | Value |
|---|---|
| Default model chain | `secure` |
| Maximum attempts | 4 |
| Circuit-breaker threshold | 3 failures |
| Circuit-breaker cooldown | 60 seconds |
| Canary fraction | 5% |
| Latency escalation threshold | 10,000 ms |
| Non-stream timeout | 60,000 ms |
| Time to first byte | 8,000 ms |
| Strict zero-data-retention flag | `false` |
| Workers AI enabled | `false` |

Source contains provider adapters, fallback selection, circuit breakers, latency EWMA, and KV-backed state. Their presence is not proof of successful failover. **Security review finding:** internal diagnostic POST handlers capable of contacting providers appear before the API-key gate. Protect/remove those handlers through the Worker's source and release process; paths are intentionally excluded.

**Checkpoint #2:** Existing router is sufficiently developed; don't build another. Live failover remains unverified. Diagnostic authentication needs hardening.

## Step 3 — Register OMPK's existing provider interface
**Status: Configured, schema-validated, awaiting credentials for live usage.**

- Existing `models.yml`: `C:\Users\prest\.ompk\agent\models.yml`.
- Added optional `gopk-router` pointing to `https://api.gopk.xyz/v1`.
- Model selectors: `chain/secure` and `chain/assume-read`.
- Authentication references environment-variable **name** `ROUTER_API_KEY`, not a literal secret.
- Both selectors conservatively mark `supportsTools: false` until tool-call compatibility is verified.
- All six existing providers preserved; seven providers now defined.
- Repository `ModelsConfigSchema` validation passed. Default model unchanged. No tracked implementation files changed.

**Checkpoint #3:** Optional OMPK provider is registered, but live inference and tool use are not proven. Provision the approved key to activate.

## Step 4 — Monitoring
**Status: Enabled for public health; authenticated inference monitor pending.**

- `https://api.gopk.xyz/health` returned HTTP 200 with JSON `ok: true`.
- Created **Hosted Model Router Watch** as an hourly condition watch: report only health failures, stay quiet when healthy, and don't confuse unauthenticated HTTP 401 with an outage.
- Old **PK Chat Tunnel Watch** remains disabled.
- First future scheduled execution had not yet been observed at documentation time.

**Checkpoint #4:** Correct endpoint monitored. No duplicate tunnel monitoring. Model-level health must be added when safe router credentials become available.

## Step 5 — Inventory legacy endpoints
**Status: Scoped review complete; no destructive retirement.**

| Endpoint / tunnel | Evidence | Decision |
|---|---|---|
| `api.gopk.xyz` | Existing production Worker; healthy public endpoint | **Canonical router — keep** |
| `api.pkking.computer` | Routes to healthy `ix-dash` tunnel; `/v1/models` was 404 | Keep: different service |
| `models.pkking.computer` | `models-api` tunnel DOWN, zero connectors; previous HTTP 530 | Retirement candidate; consumer audit required |
| `chat.gopk.xyz` | `muse-subscription-chat` tunnel DOWN; separate chat Worker route | Keep separate pending ownership review |
| `mesh-bonsai-inference` | Healthy Cloudflare tunnel with four connections | Keep |

Git-tracked searches of local OMPK, Mesh Inference, and 9Router checkouts found no references to those hostnames. This cannot rule out external clients, runtime environment variables, or other repositories.

**Checkpoint #5:** No DNS records, services, Worker deployments, or tunnels deleted. One canonical router identified; old endpoints remain until real consumers are ruled out.

## Handoff — what remains

1. **Auth:** Supply an approved `ROUTER_API_KEY` to OMPK's runtime via its supported secret mechanism. Never print or commit it.
2. **Inference:** Run one minimal `chain/secure` completion; verify HTTP response, content, tokens, timing, and selected model. Then verify tool-call support before enabling agent tooling.
3. **Reliability:** Exercise bounded failover and circuit-breaker acceptance in a safe testing context; preserve production traffic.
4. **Security:** Patch the pre-auth diagnostic routes in the Worker-owned codebase, with regression tests and controlled deployment.
5. **Cleanup:** Audit actual consumers before retiring the `models-api` and chat-related legacy routes.

**Completion boundary:** Public health and optional provider registration are complete. Successful authorized inference, failover, and full legacy retirement are **not** complete.