# LocalMesh sovereign agent mesh — orchestration

## Purpose

Build the OMPK Sovereign Agent Mesh as a durable, private-first control plane
that composes OMPK's existing task, isolation, model-routing, session, and UI
surfaces. This is deliberately not a replacement for the coding-agent,
CoLab, Hub, IRC, or `remote-workspace` local Docker runner.

The implementation is divided into five lanes because the core contract must
stabilize first; runtime, compute, and transport/artifact work can then move
independently; and all external-facing wiring must be verified last.

## Letter-group dispatch table

| Letter | Lane | Archetype | Effort | Depends on | File |
|---|---|---|---|---|---|
| A | Contracts and policy | `[pre-phase]` | LARGE | none | `.prd/localmesh-lane-a-contracts.md` |
| B | Durable runtime | `[parallel-builder]` | LARGE | A | `.prd/localmesh-lane-b-runtime.md` |
| C | Node, scheduler, and execution | `[parallel-builder]` | LARGE | A | `.prd/localmesh-lane-c-compute.md` |
| D | Event, artifact, and handoff adapters | `[parallel-builder]` | LARGE | A | `.prd/localmesh-lane-d-transport.md` |
| E | OMPK integration and acceptance | `[acceptance-gate]` | LARGE | A, B, C, D | `.prd/localmesh-lane-e-acceptance.md` |

## Operational dispatch table

| Lane | Owned files | Depends on | Verify |
|---|---|---|---|
| A | `packages/mesh-contracts/**`, `packages/mesh-policy/**` | none | focused Bun tests for contracts/policy |
| B | `packages/mesh-orchestrator/**`, `packages/mesh-evidence/**` | A | SQLite, idempotency, outbox, and lease tests |
| C | `packages/mesh-node/**`, `packages/mesh-scheduler/**`, `packages/mesh-worker-sdk/**`, `packages/mesh-model-broker/**` | A | scheduling, QoS, and executor-adapter tests |
| D | `packages/mesh-eventbus/**`, `packages/mesh-eventbus-nostr/**`, `packages/mesh-artifacts/**`, `packages/mesh-artifacts-blossom/**`, `packages/mesh-checkpoint/**`, `crates/mesh-iroh/**`, `infra/localmesh/**` | A | transport dedupe, CAS, checkpoint, and adapter tests |
| E | `packages/coding-agent/src/mesh/**`, `packages/mesh-client/**`, `packages/mesh-e2e/**`, `docs/architecture/localmesh-*`, `docs/operations/localmesh-*` | A–D | end-to-end acceptance and targeted OMPK checks |

## File-ownership matrix

| File family | A | B | C | D | E |
|---|---|---|---|---|---|
| `packages/mesh-contracts/**` | own | – | – | – | – |
| `packages/mesh-policy/**` | own | – | – | – | – |
| `packages/mesh-orchestrator/**` | – | own | – | – | – |
| `packages/mesh-evidence/**` | – | own | – | – | – |
| `packages/mesh-node/**` | – | – | own | – | – |
| `packages/mesh-scheduler/**` | – | – | own | – | – |
| `packages/mesh-worker-sdk/**` | – | – | own | – | – |
| `packages/mesh-model-broker/**` | – | – | own | – | – |
| `packages/mesh-eventbus/**` | – | – | – | own | – |
| `packages/mesh-artifacts/**` / `packages/mesh-checkpoint/**` | – | – | – | own | – |
| `crates/mesh-iroh/**`, `infra/localmesh/**` | – | – | – | own | – |
| `packages/coding-agent/src/mesh/**`, UI, CLI, e2e and docs | – | – | – | – | own |

## Hard boundaries

- PostgreSQL/SQLite state managed by the mesh orchestrator is authoritative;
  Nostr events, CoLab, Hub, IRC, and GitHub/Linear are projections or
  transports, never the source of operational truth.
- Existing `packages/remote-workspace` remains a local execution backend. Do
  not promote its in-process orchestration state to mesh authority.
- Existing OMPK task contracts, assignment verifier, `pi-iso`, workspace
  protections, and model resolver are reused through narrow adapters.
- Mesh code must not import or alter `packages/wire/**`, `src/collab/**`, or
  `src/irc/**` unless Lane E explicitly establishes an additive bridge.
- All external effects require a causal ID and idempotency key. A signature is
  origin evidence, not authorization.
- No phase may claim completion without tests and durable evidence. Local
  proof precedes Nostr, multi-node placement, Blossom, Iroh, and handoff.

## Execution sequence

1. Land Lane A with schemas, canonicalization, policy, identities, fixtures,
   and test vectors.
2. Build B, C, and D against only Lane A public exports. They must not edit
   each other's owned files.
3. Land E after the three interfaces are available. It is responsible for
   additive OMPK bridges, CLI/API, end-to-end tests, deployment manifests,
   trace presentation, and acceptance evidence.
4. Run acceptance gates in the packet order: local lifecycle, durable recovery,
   OMPK executor, Nostr, multi-node QoS, persistent artifacts, Iroh, portable
   handoff, resilience, consequential integrations, then optional federation.

## Acceptance criteria

- [ ] `packages/mesh-contracts` rejects malformed or broadened contracts and
  produces stable digests.
- [ ] `packages/mesh-orchestrator` survives duplicate delivery, restart, stale
  lease, and cancellation/completion races without duplicate effects.
- [ ] `packages/mesh-node` refuses assignments that violate local QoS or policy
  and produces a cleanup proof for every worker.
- [ ] `packages/mesh-eventbus-nostr` cannot make a relay the transactional
  authority and deduplicates/replays envelopes safely.
- [ ] `packages/mesh-artifacts` verifies content hashes before use and keeps
  private data encrypted outside authorized execution boundaries.
- [ ] `packages/mesh-e2e` proves a harmless isolated OMPK task, artifact,
  receipt, cancellation, restart recovery, and unchanged active checkout.
- [ ] Existing OMPK CoLab, Hub, IRC, task, worktree, and model-routing tests
  remain passing or have an explicit, reviewed compatibility migration.
