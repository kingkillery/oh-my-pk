# Completion-aware delegations — central work records

The OMPK/Pi extension in this directory provides a Factory-inspired delegation ingress, a central broker, durable work ledger, and an opt-in OMPK CLI worker. It **does not replace** OMPK's built-in `/delegate`, task compiler, policy snapshots, tool guards, or lifecycle authority.

## What's actually implemented

- `index.ts`: installable Pi/OMPK extension. `ompk_delegation` accepts purpose `status|execute|retry|verify|extend|alternative`. The `/delegations` command shows setup. Unconfigured broker fails closed.
- `broker.ts`: authenticated HTTP ingress, exact repository allowlist, fixed principal/worker identity, separate requester/worker/reviewer credentials, read-only status, atomic enqueue/join, claim/progress/review/evidence/certify.
- `ledger.ts`: SQLite WAL + durable work records, idempotency keys and payload digests, criterion-level receipts, append-only events, leases/fencing and uncertain-outcome reconciliation. Source transcripts are *leads*, not completion proof.
- `worker.ts`: explicitly launched CLI worker. Claims one queued task, invokes trusted `ompk --print` in an allowlisted repository path without shell interpolation, writes a private log, records progress, and finishes `review_ready` **without claiming completion**. A reviewer attaches evidence and certifies acceptance.
- Tests: `bun test extensions/ompk-delegations`.

## Identity and deployment

Use a single central broker for each authority/identity lane. Its SQLite file is the record authority. Each machine running Pi uses the broker's HTTPS URL; it does **not** open or copy the central database.

Set broker variables (supply secrets through your secret manager, never write real keys to repo):

```bash
export OMPK_DELEGATION_REQUESTER_TOKEN='<long-random-requester-token>'
export OMPK_DELEGATION_WORKER_TOKEN='<different-long-random-worker-token>'
export OMPK_DELEGATION_REVIEWER_TOKEN='<different-long-random-reviewer-token>'
export OMPK_DELEGATION_PRINCIPAL='your-authority:personal-user-or-service'
export OMPK_DELEGATION_WORKER_ID='trusted-worker-instance'
export OMPK_DELEGATION_WORKER_MODE='personal' # or shared, never auto-infer
export OMPK_DELEGATION_REPOSITORIES='kingkillery/oh-my-pk'
export OMPK_DELEGATION_DB='/private/state/ompk/work-ledger.db'
export OMPK_DELEGATION_BIND='127.0.0.1'
export OMPK_DELEGATION_PORT='8899'
bun extensions/ompk-delegations/broker.ts
```

Non-loopback HTTP binding requires an **authenticated TLS-terminating reverse proxy**, configured separately. A browser or public internet must never access plaintext bearer tokens. Tokens must be distinct; broker refuses missing/short credentials. Set `OMPK_DELEGATION_ALLOW_SHARED=1` only for a service-account broker actually running with the service principal's authorized credentials. Personal tasks must use the matching personal worker lane. A request cannot change its principal or service identity.

Configure worker (same protected broker and worker token):

```bash
export OMPK_DELEGATION_BROKER_URL='http://127.0.0.1:8899'
export OMPK_DELEGATION_WORKER_TOKEN='<same-worker-token>'
export OMPK_DELEGATION_WORKER_MODE='personal'
export OMPK_DELEGATION_OMPK_BIN='/usr/local/bin/ompk'
export OMPK_DELEGATION_REPO_PATHS='{"kingkillery/oh-my-pk":"/srv/repos/oh-my-pk"}'
export OMPK_DELEGATION_LOG_DIR='/private/state/ompk/logs'
export OMPK_DELEGATION_MAX_SECONDS='600'
bun extensions/ompk-delegations/worker.ts once
```

The optional `watch` worker mode polls for work but should be managed by an operator's chosen service supervisor with a dedicated identity. The worker runs OMPK under its **actual OS account and existing credentials**. Configure least privilege and isolate workspace; the ledger is not a sandbox.

Configure Pi/OMPK client using `OMPK_DELEGATION_BROKER_URL` and `OMPK_DELEGATION_TOKEN` (same as requester token) and install local plugin:

```bash
ompk install ./extensions/ompk-delegations
# or run explicitly
ompk --extension ./extensions/ompk-delegations/index.ts
```

The remote worker intentionally uses `--no-extensions` to avoid recursively submitting new broker work.

## Audit and verification

Records are queryable at `GET /v1/delegations/{operationId}` (requester/reviewer token). The central ledger stores chronological events, stages, actor, principal, repo, original task, acceptance criteria, request source, attempt links, lease epochs and evidence refs. Evidence content remains at its original location; references are not proof of accessibility or current health.

Reviewer-only routes:

1. `POST /v1/delegations/{id}/evidence` with `{"receipts":[{"criterion":"...","uri":"https://...","sourceId":"..."}]}`
2. `POST /v1/delegations/{id}/certify` with `{"evidence":{"criterion name":["https://matching-evidence-uri"]}}`.

Only certify after independently checking artifacts and the exact acceptance criteria. No automatic approval from CLI exit code or agent's final prose.

If a worker exits abnormally, loses its claim, or expires, the record is **uncertain/blocked**. Do not replay potentially effected operations blindly. `POST /v1/delegations/reconcile` requires reviewer token and marks expired leases uncertain. Recovery must externally inspect side effects before an explicit retry.

## Honest limits

This integration is a real broker/client/worker path but does **not** yet establish the original Completion-Aware Prompt Packet's universal A01–A26 behavior across OMPK's native task tools, direct shell writes, MCP, SDK, UI, Slack, Linear, Jira or Teams. Similarity matching is deliberately conservative: exact normalized task, repository, principal and criteria only; paraphrases need an authorized semantic candidate index with evidence checks. Concurrent broker replicas cannot share a SQLite file over unreliable network storage; use a single-writer broker with protected state and backups, or implement a transactionally equivalent central database.

Running `bun test` against in-memory broker/worker mocks is not a live model execution, and a locally successful smoke test does not establish deployed runtime health. Production readiness requires real OMPK integration tests, permission validation, cross-process crash/race fixtures, source adapter authentication and operator rollout.

Do not classify this as production completion-aware intake until all reachable execution paths are covered and evidence-backed stopping is enforced at runtime.
