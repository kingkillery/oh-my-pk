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
| A | Contracts and policy | `[pre-phase]` | LARGE | none | `extensions/localmesh/docs/prd/localmesh-lane-a-contracts.md` |
| B | Durable runtime | `[parallel-builder]` | LARGE | A | `extensions/localmesh/docs/prd/localmesh-lane-b-runtime.md` |
| C | Node, scheduler, and execution | `[parallel-builder]` | LARGE | A | `extensions/localmesh/docs/prd/localmesh-lane-c-compute.md` |
| D | Event, artifact, and handoff adapters | `[parallel-builder]` | LARGE | A | `extensions/localmesh/docs/prd/localmesh-lane-d-transport.md` |
| E | OMPK integration and acceptance | `[acceptance-gate]` | LARGE | A, B, C, D | `extensions/localmesh/docs/prd/localmesh-lane-e-acceptance.md` |

## Operational dispatch table

| Lane | Owned files | Depends on | Verify |
|---|---|---|---|
| A | `extensions/localmesh/packages/mesh-contracts/**`, `extensions/localmesh/packages/mesh-policy/**` | none | focused Bun tests for contracts/policy |
| B | `extensions/localmesh/packages/mesh-orchestrator/**`, `extensions/localmesh/packages/mesh-evidence/**` | A | SQLite, idempotency, outbox, and lease tests |
| C | `extensions/localmesh/packages/mesh-node/**`, `extensions/localmesh/packages/mesh-scheduler/**`, `extensions/localmesh/packages/mesh-worker-sdk/**`, `extensions/localmesh/packages/mesh-model-broker/**` | A | scheduling, QoS, and executor-adapter tests |
| D | `extensions/localmesh/packages/mesh-eventbus/**`, `extensions/localmesh/packages/mesh-eventbus-nostr/**`, `extensions/localmesh/packages/mesh-artifacts/**`, `extensions/localmesh/packages/mesh-artifacts-blossom/**`, `extensions/localmesh/packages/mesh-checkpoint/**`, `extensions/localmesh/crates/mesh-iroh/**`, `extensions/localmesh/infra/**` | A | transport dedupe, CAS, checkpoint, and adapter tests |
| E | `extensions/localmesh/packages/localmesh-extension/**`, `extensions/localmesh/packages/mesh-client/**`, `extensions/localmesh/packages/mesh-e2e/**`, `extensions/localmesh/docs/architecture/**`, `extensions/localmesh/docs/operations/**` | A–D | end-to-end acceptance through the loaded extension |

## File-ownership matrix

| File family | A | B | C | D | E |
|---|---|---|---|---|---|
| `extensions/localmesh/packages/mesh-contracts/**` | own | – | – | – | – |
| `extensions/localmesh/packages/mesh-policy/**` | own | – | – | – | – |
| `extensions/localmesh/packages/mesh-orchestrator/**` | – | own | – | – | – |
| `extensions/localmesh/packages/mesh-evidence/**` | – | own | – | – | – |
| `extensions/localmesh/packages/mesh-node/**` | – | – | own | – | – |
| `extensions/localmesh/packages/mesh-scheduler/**` | – | – | own | – | – |
| `extensions/localmesh/packages/mesh-worker-sdk/**` | – | – | own | – | – |
| `extensions/localmesh/packages/mesh-model-broker/**` | – | – | own | – | – |
| `extensions/localmesh/packages/mesh-eventbus/**` | – | – | – | own | – |
| `extensions/localmesh/packages/mesh-artifacts/**` / `extensions/localmesh/packages/mesh-checkpoint/**` | – | – | – | own | – |
| `extensions/localmesh/crates/mesh-iroh/**`, `extensions/localmesh/infra/**` | – | – | – | own | – |
| `extensions/localmesh/packages/localmesh-extension/**`, e2e and docs | – | – | – | – | own |

## Hard boundaries

- LocalMesh is a personal, opt-in ompk extension living entirely under
  `extensions/localmesh/`, with its own Bun workspace, lockfile, Cargo
  workspace and CI workflow. Core (`packages/**`, the root workspace and root
  CI) never imports or builds it; OMPK reaches it only by loading the extension.

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

- [ ] `extensions/localmesh/packages/mesh-contracts` rejects malformed or broadened contracts and
  produces stable digests.
- [ ] `extensions/localmesh/packages/mesh-orchestrator` survives duplicate delivery, restart, stale
  lease, and cancellation/completion races without duplicate effects.
- [ ] `extensions/localmesh/packages/mesh-node` refuses assignments that violate local QoS or policy
  and produces a cleanup proof for every worker.
- [ ] `extensions/localmesh/packages/mesh-eventbus-nostr` cannot make a relay the transactional
  authority and deduplicates/replays envelopes safely.
- [ ] `extensions/localmesh/packages/mesh-artifacts` verifies content hashes before use and keeps
  private data encrypted outside authorized execution boundaries.
- [ ] `extensions/localmesh/packages/mesh-e2e` proves a harmless isolated OMPK task, artifact,
  receipt, cancellation, restart recovery, and unchanged active checkout.
- [ ] Existing OMPK CoLab, Hub, IRC, task, worktree, and model-routing tests
  remain passing or have an explicit, reviewed compatibility migration.
