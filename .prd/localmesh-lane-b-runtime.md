# Lane B — Durable runtime [parallel-builder]

## 1. Mission + read-first

Build the authoritative local mesh control plane after Lane A is stable. Read:

- `.prd/localmesh-orchestration.md`
- `.prd/localmesh-lane-a-contracts.md`
- `packages/remote-workspace/src/db/job-store.ts`
- `packages/remote-workspace/src/job/state-machine.ts`
- `packages/ompk-linear-agent/src/types.ts`
- `packages/coding-agent/src/orchestration/{completion-gate,evidence-ledger}.ts`
- root `AGENTS.md`

## 2. Owned files

- `packages/mesh-orchestrator/**` (new)
- `packages/mesh-evidence/**` (new)

No edits to Lane A, C, D, or E files. Do not make `remote-workspace` the mesh
authority.

## 3. Gap

> B — Durable runtime: build SQLite migrations, state dimensions, idempotency,
> outbox/inbox, scheduler epoch, leases/fences, approvals, completion gating,
> reconciliation, and cursor-friendly query API. [LARGE] depends on: A.

## 4. What to build

- WAL-backed transactional store with explicit migrations, optimistic revision
  checks, immutable accepted-transition/event records, idempotency keys,
  inbox/dedupe, and transactional outbox.
- State machine that rejects illegal transitions and stale fencing tokens.
- Lease grant/heartbeat/revoke/expire/reconcile lifecycle, single scheduler
  epoch, and task/assignment/job projections.
- Root completion gates that require evidence, policy, cleanup, and active
  claim reconciliation.
- Evidence ledger and signed-receipt interface consuming Lane A types.
- Focused failure tests: process restart after each critical transition,
  duplicate submit/delivery, stale result, cancellation race, outbox publish
  retry, and expired lease reclamation.

## 5. Hard constraints

1. All mutations are transactional and idempotent.
2. Never trust a remote event to mutate authority without local policy and
   fencing validation.
3. No process-global in-memory active-run state as the source of truth.
4. Preserve raw event evidence separately from projections.

## 6. Verification

Run focused package tests plus migration/open/reopen tests. Do not run a full
monorepo suite from a lane worktree.

## 7. Commit message

`feat(mesh-orchestrator): add durable fenced control plane`

## 8. Final report

Report migrations, public API, state invariants proven, test commands/results,
and every deferred external adapter.
