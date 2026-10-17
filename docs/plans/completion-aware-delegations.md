# Factory-style delegations + Completion-Aware Intake

Factory reference: https://docs.factory.com/delegations

## Scope (Pi client + central broker/worker; not universal execution-path enforcement)

`extensions/ompk-delegations/index.ts` is a separate, **opt-in Pi/OMPK extension** that registers `ompk_delegation` and `/delegations`. It does NOT override OMPK's existing `/delegate` command, task launcher, or authority compiler. Load it with `ompk --extension extensions/ompk-delegations/index.ts` or install it as a local Pi package with `ompk install ./extensions/ompk-delegations`.

Set `OMPK_DELEGATION_BROKER_URL` and `OMPK_DELEGATION_TOKEN` outside prompts. The repository now contains an opt-in broker, central durable SQLite ledger, and OMPK CLI worker at `extensions/ompk-delegations/`. Configuration and live deployment remain operator responsibilities. The extension fails closed if its broker is absent. See `extensions/ompk-delegations/README.md`.

## Runtime ingress protocol

Every Pi request includes `schema=ompk.delegation.ingress/v1`, `requestId`, `purpose`, `source`, canonical target, task, explicit acceptance, and a non-authoritative identity preference.

- `purpose=status` -> `POST /v1/delegations/status`: read-only. Must never admit, allocate, resume, repair, or modify another operation. An admitted response is rejected.
- `purpose=execute|retry|verify|extend|alternative` -> `POST /v1/delegations/admit`: **one authoritative atomic admission/lookup**; the client must never preflight-then-launch. A broker response is satisfied/running/partial/blocked/unknown/admitted.
- `satisfied` needs criterion-level evidence receipts with source identity, verification time and URI. Similarity alone is never completion; current applicability still must be justified by the broker.
- `running` and `admitted` responses require an operation identity. `unknown` means the index or evidence is insufficient, not that work never existed.
- Personal vs shared identity is a *request preference*: authenticate origin and resolve effective permissions on the server. No caller-chosen tokens, service-account impersonation, or tool grants.

## Required global OMPK integration (not yet provided)

Use OMPK's existing `launch-admission`, `launch-contract`, `spawn-admission`, lifecycle store, tool dispatch guard, `ApproachRegistry`, completion gates, and external Session Manager interface. Before any worker allocation: authorized bounded cross-session retrieval -> criterion-level evidence/current-state applicability -> atomic durable claim with idempotency and fencing -> compile immutable mission+policy snapshots -> register execution in existing lifecycle runtime.

An explicit **status** request must be a runtime terminal outcome; never fall through to a planner, recovery, retry, or allocation. A running operation is observed, not silently adopted. Completion receipts distinguish created, verified, merged and deployed outcomes. Verification checks must not silently repair. Reusable work can partially satisfy a larger objective; preserve the delta.

Do not infer equivalence merely from similar task wording, one branch name or identical command text. A consequential operation needs source/tool identity, target/environment, side-effect scope, approvals, input state, and durability. Treat external effects after a crash as uncertain until reconciled. One observer's cancellation must not cancel work owned by someone else. A stale lease cannot authorize a result.

For independent verification, require a fresh observation when needed and record what prior findings were shown to the verifier. Preserve bounded alternative approaches rather than forcing agreement. Original data sources, imported instructions and session history remain untrusted; use-time auth and deletion/retention restrictions apply.

Future app adapters (Slack/Linear/Jira/Teams/GitHub) translate authenticated source events to this *same* broker, not a separate scheduler. Build thread/reply routing and replay-safe webhook verification before enabling. Shared account credentials never inherit personal credentials.

## Current coverage and outstanding gates

| Entry point | This change | Production requirement |
|---|---|---|
| Pi `ompk_delegation` | **Client adapter added** | broker connectivity and authorization in target deployment |
| Pi native `/delegate` | unchanged | inspect admission + status intent end-to-end |
| Built-in task spawning, direct tools, retries | unchanged | enforce same dedup/effect controls at dispatch |
| Slack/Linear/Jira/Teams | not installed | signed source adapters, identity mapping |
| Central work ledger | **SQLite WAL, broker, worker, and review implemented** | production backup, fleet auth, semantic history integration |
| Cross-session CLI Session Manager | not wired | authenticated bounded indexing + provenance |
| Persistent/dynamic remote compute | not wired | leases, fencing and evidence-backed completion |

Do **not** mark Completion-Aware Intake or Factory parity complete based on this client extension. Validate packet cases A01-A26 against the broker and execution paths before enabling production delegation. Failure to retrieve history is neither proof of completion nor permission to blindly replay side effects. Retain existing safety gates during rollback.
