# Hosted Model Router Adoption — Task Reference

**Created:** 2026-10-18 (America/Denver). **Execution mode:** verify → compact → continue.
**Source of truth:** Existing Cloudflare Worker `free-tier-router` attached to `https://api.gopk.xyz`.
**Goal:** One reusable hosted, authenticated model-routing endpoint for OMPK and other agents; no duplicate routers or tunnels.
**Baseline:** Cloudflare Worker production, `/health` HTTP 200, `/v1/routes` and `/v1/models` unauthenticated HTTP 401; successful authenticated inference unproven.
**Cloudflare provenance:** Worker deployment 2026-10-18T05:42:42Z; provider secret bindings NVIDIA_API_KEY, OPENROUTER_API_KEY, ROUTER_API_KEY; KV binding ROUTER_STATE; routing and breaker settings present.
**Safety:** No secret values in documentation, logs, CLI arguments, or chat. Never replace existing router. Do not remove other endpoints until consumers are identified.
**Local checkout:** `C:\dev\Infra\oh-my-pk` on `fix/clef-bootstrap-jev-gate-criteria`, HEAD `05f5e9491c` at start, contains substantial unrelated modifications; preserve them without edits or reset.

## Workstream and acceptance gates

1. **Real inference:** Safely obtain credential from an already-authorized runtime/store without revealing it; test authenticated `GET /v1/models` and one minimal `POST /v1/chat/completions`; record status, model, provider, request ID, latency and response validation (never content/secrets). No claim of success from 200 health alone.
2. **Routing behavior:** Inspect existing router source/config and verify model choices, fallback, limits, breaker, and routing telemetry with safe non-destructive probes. Do not fabricate outage or spend significant quota.
3. **OMPK integration:** Inspect OMPK existing provider/client config first; reuse/point to `api.gopk.xyz` only where absent; keep secrets in approved provider. Verify an actual invocation and preserve dirty work in existing checkout.
4. **Monitoring:** Reuse an existing check if possible; otherwise create narrowly scoped health + authenticated model probe with alert-on-failure and bounded frequency. Avoid checking unrelated chat tunnel.
5. **Legacy review:** Inventory domains/tunnels, source ownership and consumers; report retire candidates, don't delete without direct evidence and explicit scope.

## Evidence and progress journal
### Step 0 — Baseline / starting checkpoint
- Hosted route confirmed on Cloudflare `api.gopk.xyz` → Worker `free-tier-router`, production.
- The **old** `muse-subscription-chat` down-tunnel starter task/config created in prior troubleshooting were removed; hourly watch disabled. Existing Cloudflare routes retained.
- `api.pkking.computer` responds at `/` but `/v1/models` HTTP 404; `models.pkking.computer/v1/models` HTTP 530; `api.gopk.xyz/v1/models` HTTP 401 unauthenticated. These are not proof of router malfunction.
- `free-tier-router` source defines `/health`, `/v1/models`, `/v1/routes`, `/v1/chat/completions`.
- Execution rule: record a compact checkpoint at the end of EACH step before starting the next.

## Compact checkpoint (overwrite/supersede at each completed step)

**Step:** 0/5 — baseline established.
**Verified:** Hosted Worker exists and responds; auth gate active.
**Changed:** This task-reference document only.
**Blocked:** Authenticated inference unverified; credential location unknown.
**Next:** Step 1 — inspect approved existing credential mechanisms and exercise a minimal inference request if authorized.
**Do not repeat:** Create Worker, proxy, tunnel, startup task, or anonymous 401 health tests as proof.

### Step 1 — Authentication and inference verification (2026-10-18 MDT)
- **Status:** BLOCKED for authenticated request; safe, unauthenticated surface verified.
- Cloudflare production source: `GET /v1/models`, `GET /v1/routes`, and `POST /v1/chat/completions` require `ROUTER_API_KEY` authorization. `/health` is public and HTTP 200.
- Cloudflare lists `ROUTER_API_KEY` as `secret_text` binding, which does **not** make its plaintext available to readers.
- On PK the environment has no `ROUTER_API_KEY`, `GOPK_API_KEY`, or `MODEL_ROUTER_API_KEY`. On MSI the matching environment vars are absent too. A separate provider key on PK is not a router credential.
- No credential read, printed, invented, rotated, or transplanted. No billed inference performed. **Do not claim inferencing operational until authenticated model response and completion are validated.**
- Follow-up: test with existing approved router credential via runtime secret management. Keep credentials out of shell history and published documents; if unavailable, request authorized binding instead of bypassing auth.

**Compact #1:** Completed evidence: auth gates confirmed, secret binding present. Change: no production changes. Blocker: authorized router key missing from checked runtimes. Next: inspect routing implementation and safe operational behavior (step 2). Do not redo health-only requests or build a new router.

### Step 2 — Routing controls audit (2026-10-18 MDT)
- **Status:** Source/config verification COMPLETE; authenticated runtime failover NOT YET VALIDATED (dependent on step 1 key).
- Cloudflare production settings: `DEFAULT_CHAIN=secure`, `MAX_ATTEMPTS=4`, breaker threshold `3`, cooldown `60000ms`, canary `0.05`, latency escalation `10000ms`, non-stream timeout `60000ms`, TTFB timeout `8000ms`.
- Production source contains candidate planning, provider adapters, fallback, EWMA tracking, breaker state, KV registry, and separate routes/model listing.
- Noted policy: `SECURE_REQUIRE_ZDR=false` and `WORKERS_AI_ENABLED=false`. Do not assume strict ZDR enforcement or Workers AI availability.
- **Security finding to fix in the owning router source:** two hard-to-guess, non-public-looking internal test POST endpoints are processed **before** the API-key gate and can trigger upstream inference. Obscure paths are not authentication. Avoid calling or disclosing their exact paths; add auth/disable and regression coverage via normal Worker repo release procedure. No production change made without that source/release ownership identified.
- Do not test fallback by forcing provider failures or consuming unbounded tokens; use a bounded authenticated synthetic request after credentials available.

**Compact #2:** Verified: source/config support existing routing and resilience. Change: evidence only. Blockers: live failover needs valid key; internal pre-auth inference test paths need security remediation. Next: inspect OMPK wiring and reuse it without touching collaborators' uncommitted work (step 3).

### Step 3 — OMPK integration (2026-10-18 MDT)
- **Status:** Provider registration COMPLETE (optional/staged), live requests BLOCKED on credential.
- Existing OMPK custom-provider loader already supports OpenAI Chat Completions. No second router implementation, library, or proxy created.
- On PK existing config `C:\Users\prest\.ompk\agent\models.yml` initially contained 6 providers and no reference to `api.gopk.xyz`. Existing per-machine auth stores did not contain the router provider.
- Added optional `gopk-router` provider pointing to `https://api.gopk.xyz/v1` using `apiKey: ROUTER_API_KEY` (name of future environment variable, NOT a token), plus `chain/secure` and `chain/assume-read` model selectors.
- Marked model tool support conservatively as `supportsTools: false` until actual tool-wire contracts are verified; did NOT make this the default model.
- Ran the repository's `ModelsConfigSchema` validation against the proposed provider and verified the full config parses, preserves all 6 existing providers, and yields 7 total providers. No tracked implementation files modified.
- Activation remaining: provision an authorized `ROUTER_API_KEY` reference for the OMPK runtime and verify a real model turn, tokens, and eventually tool capability. If absent, selecting the hosted model should be expected to fail authentication; no hidden fallback is assumed.

**Compact #3:** Verified: existing custom-provider path; optional `gopk-router` now installed/config-valid on PK. Change: appended only to local OMPK models.yml. Blocker: missing router key; no production inference. Next: replace obsolete chat-tunnel watch with a router-specific monitoring signal (step 4).

### Step 4 — Monitoring (2026-10-18 MDT)
- **Status:** COMPLETE for public endpoint and domain reachability; inference-level health awaits key.
- Confirmed `GET https://api.gopk.xyz/health` returns JSON `ok: true` from PK Windows; previous HTTP status 200.
- Created condition watch `Hosted Model Router Watch`, recurring hourly, failure notifications ONLY. It checks `/health` JSON and the existing Cloudflare Worker domain mapping, and explicitly treats unauthenticated `/v1/models` 401 as expected.
- Prior `PK Chat Tunnel Watch` remains disabled; it is not a dependency of this hosted Worker.
- Monitoring has NOT yet observed the first scheduled execution. Credential-gated completion is not monitored until authorized credentials exist; health-only monitoring must not be mistaken for verified inference availability.

**Compact #4:** Verified: HTTP+JSON public health. Change: new dedicated hourly condition watch enabled; old chat-tunnel watch remains disabled. Blocker: inference-level probe needs auth. Next: inventory legacy endpoint consumers, mark candidates, do not delete (step 5).

### Step 5 — Legacy endpoint consumer review (2026-10-18 MDT)
- **Status:** Scoped inventory COMPLETE. No endpoint deletion authorized by evidence.
- Canonical model router `api.gopk.xyz` → existing Cloudflare Worker `free-tier-router` production; health JSON `ok:true`.
- `models.pkking.computer` DNS CNAME → `models-api` tunnel; tunnel DOWN with 0 connections, prior HTTP 530. **Retirement candidate only**, usage/consumers not exhaustively known.
- `api.pkking.computer` DNS CNAME → `ix-dash` tunnel; tunnel HEALTHY with 8 connections, root HTTP 200; `/v1/models` HTTP 404. Likely separate dashboard service; explicitly **KEEP**.
- `chat.gopk.xyz` DNS CNAME → `muse-subscription-chat` tunnel DOWN; Worker route `html-basic-chat` exists on hostname. Chat UI is separate from model router; **KEEP** until its independent purpose and consumers are confirmed.
- `mesh-bonsai-inference` tunnel HEALTHY with 4 connections; inference infrastructure distinct from router; **KEEP**.
- Git-tracked content searches across local `oh-my-pk`, `mesh-inference`, and `9router` did not find references to the four hostnames at inspection time. That does not rule out runtime env vars, external apps, DNS clients, or untracked files.
- **No DNS record, tunnel, Worker, or prior infrastructure was deleted, and no permanent redirect made.**

**Compact #5:** Canonical endpoint confirmed: `api.gopk.xyz`. Optional OMPK provider installed and schema-valid; monitoring enabled and public health verified. Remaining work: authorized router credential, live model/tool verification, router test-endpoint auth hardening, and full legacy consumer audit before retirement. No duplicate service built or destructive changes applied.

## Final handoff summary
- **Completed:** Baseline verification; routing controls source/config audit; OMPK optional provider registration; health monitoring automation; scoped legacy inventory. Progress checkpoints #0–#5 recorded above.
- **Unverified:** Authenticated models list, successful inference output/tokens, failover under provider errors, tool streaming compatibility, inference-level monitor, complete legacy usage inventory.
- **Exact dependency:** Bind approved `ROUTER_API_KEY` to OMPK runtime and safe test harness without exposing secret contents, then run one bounded `chain/secure` text prompt and inspect outcome. Do not reuse provider API keys as router keys.
- **Security backlog:** Remove or protect internal upstream-calling diagnostic routes occurring before authentication; validate in router's owning source/release lane.
- **Workspace preservation:** Pre-existing branch `fix/clef-bootstrap-jev-gate-criteria` and unrelated dirty changes untouched; this new doc is uncommitted unless explicitly staged later.

### Post-merge verification — 2026-10-19 20:49 MDT (2026-10-20 02:49 UTC)
- **Status:** Public endpoint and OMPK configuration PASS. Authenticated model inference BLOCKED for lack of approved router credential in checked PK/MSI process environments.
- Cloudflare production Worker domain `api.gopk.xyz` remains attached to `free-tier-router` and its three relevant secret bindings are present (presence only; values not disclosed).
- Live PK HTTP: `GET /health` = 200, JSON `ok: true`; unauthenticated `GET /v1/models` = 401; `GET /v1/routes` = 401; `POST /v1/chat/completions` = 401.
- Live MSI HTTP: `GET /health` = 200, valid JSON `ok: true`.
- Local OMPK `models.yml` passed `ModelsConfigSchema`. Existing `gopk-router` points to `https://api.gopk.xyz/v1`, uses symbolic `ROUTER_API_KEY`, exposes both `chain/secure` and `chain/assume-read`, and preserves six other providers.
- No keys, source files, Cloudflare resources, or router configuration were changed; no paid completion was attempted.
- **Compact checkpoint:** Router reachable and access control on published endpoints behaves as expected. Integration config validated. Not production-inference verified until an authorized key is bound and an actual completion succeeds. Separately remediate earlier pre-auth internal diagnostic route exposure in the Worker's owned source.

### DeepSeek V4.1 Flash inference acceptance attempt — 2026-10-19 MDT
- **Requested model:** `deepseek/deepseek-v4.1-flash` (OpenRouter model identifier); the deployed `free-tier-router` contains this model in its paid-backup route definitions for secure and assume-read chains.
- **Catalog verification:** `pi --list-models deepseek-v4.1-flash` lists the OpenRouter model as well as a Hugging Face variant. This is catalog evidence only, not live availability.
- **Authentication environment:** The local Pi auth checker reports `{status:ready, provider:openrouter, authType:api_key}`. That checks local credential resolution, not OpenRouter's acceptance of the key. A separate `ROUTER_API_KEY` is still absent in checked PK/MSI process environments.
- **Inference attempt #1:** Pi CLI, ephemeral session, no tools/extensions, OpenRouter model, synthetic `FLASH_OK` prompt: exited 1 with `401 User not found` after 811ms; no model output.
- **Inference attempt #2:** OMPK CLI, ephemeral session, no tools/extensions/IRC, same OpenRouter model and synthetic prompt: exited 1 with `401 User not found` after 8,771ms; no model output.
- **Limits:** Attempts used the local model client/its existing authentication handling, not an authorized request through `api.gopk.xyz`; direct manual credential handling was blocked before any request was sent. No unprotected internal Worker diagnostic routes were invoked, and no changes to production resources or stored credentials were made.
- **Next acceptance gate:** Verify the OpenRouter key is accepted by the provider through a supported secure credential test; restore/re-authorize it if rejected. Provision the distinct router API credential through authorized secret management and run a bounded `/v1/chat/completions` request targeting an explicitly chosen DeepSeek route/chain. Capture HTTP, response text, model, duration, and token usage without recording credentials.

**Compact inference checkpoint:** Route and catalog EXIST; local credential presence only; both real client inference attempts FAILED 401; hosted-router authenticated inference still BLOCKED. Don't claim success or deploy duplicate infrastructure.
