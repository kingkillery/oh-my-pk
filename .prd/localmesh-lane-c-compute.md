# Lane C — Node, scheduler, and execution [parallel-builder]

## 1. Mission + read-first

Build the node-side and placement layer against Lane A contracts. Read:

- `.prd/localmesh-orchestration.md`
- `.prd/localmesh-lane-a-contracts.md`
- `packages/remote-workspace/src/backend/types.ts`
- `packages/remote-workspace/src/backend/msi-docker.ts`
- `packages/coding-agent/src/task/isolation-runner.ts`
- `packages/coding-agent/src/task/assignment-verifier.ts`
- `crates/pi-iso/src/lib.rs`
- root `AGENTS.md`

## 2. Owned files

- `packages/mesh-node/**` (new)
- `packages/mesh-scheduler/**` (new)
- `packages/mesh-worker-sdk/**` (new)
- `packages/mesh-model-broker/**` (new)

Do not alter OMPK task execution or remote-workspace production files in this
lane. A later integration lane owns additive bridges.

## 3. Gap

> C — Compute plane: build node capabilities/presence, local QoS admission,
> deterministic placement, worker supervision, bounded execution adapters, and
> model-routing provenance without allowing remote scheduling to override local
> safety. [LARGE] depends on: A.

## 4. What to build

- Node daemon lifecycle and capability snapshot/advertisement.
- Scheduler with hard filters first (authorization, capabilities, trust,
  compatibility, active-machine reserve) and deterministic scored explanation
  second (locality, model fit, cost, capacity).
- Node-local admission guard whose denial is final; leases are validated before
  launch and heartbeats/cancel/cleanup are receipt-producing operations.
- ExecutionBackend adapter interfaces and an initial OMPK/remote-workspace
  adapter shape that keeps jobs in isolated worktrees or container profiles.
- Model broker interface that calls existing OMPK model-routing decisions and
  records provenance instead of duplicating policy.
- Tests for incompatible node rejection, active-host reserve, deterministic
  tie-breaks, stale lease rejection, cancel/timeout cleanup, and unchanged
  dirty source baseline.

## 5. Hard constraints

1. Never execute a fresh job in an active dirty checkout.
2. Do not expose a host Docker socket to workers.
3. Node-local policy/QoS is final and cannot be overridden by the scheduler.
4. No silent model, trust-zone, or cost fallback.

## 6. Verification

Run focused deterministic scheduler and local node tests only.

## 7. Commit message

`feat(mesh-node): add policy-bound node execution and placement`

## 8. Final report

Report node/scheduler API, worker cleanup behavior, tests, and any backend that
remains an interface awaiting external infrastructure.
