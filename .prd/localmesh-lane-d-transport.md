# Lane D — Event, artifact, and handoff adapters [parallel-builder]

## 1. Mission + read-first

Build transport/artifact/checkpoint adapters against Lane A contracts without
coupling mesh authority to a relay. Read:

- `.prd/localmesh-orchestration.md`
- `.prd/localmesh-lane-a-contracts.md`
- `packages/coding-agent/src/utils/event-bus.ts`
- `packages/coding-agent/src/session/blob-store.ts`
- `packages/coding-agent/src/workspace/{ethereal,secrets}.ts`
- `packages/coding-agent/src/collab/{host,guest,crypto}.ts`
- packet `04-storage/**` and `03-runtime/CHECKPOINT_AND_HANDOFF.md`
- root `AGENTS.md`

## 2. Owned files

- `packages/mesh-eventbus/**` (new)
- `packages/mesh-eventbus-nostr/**` (new)
- `packages/mesh-artifacts/**` (new)
- `packages/mesh-artifacts-blossom/**` (new)
- `packages/mesh-checkpoint/**` (new)
- `crates/mesh-iroh/**` (new)
- `infra/localmesh/**` (new)

Do not edit `packages/wire/**`, `packages/collab-relay/**`,
`packages/coding-agent/src/collab/**`, or `src/irc/**`.

## 3. Gap

> D — Transport/artifacts/handoff: build durable replay-safe EventBus adapters,
> encrypted content-addressed artifacts, Nostr/Blossom/Iroh boundary adapters,
> and portable checkpoint manifests. [LARGE] depends on: A.

## 4. What to build

- Transport-neutral EventBus with envelope validation, cursor/replay, causal
  provenance, dedupe, timeout/cancellation, and local deterministic adapter.
- Nostr adapter boundary with strict relay auth, encrypted payload abstraction,
  bounded retry, cursors, and no transactional state ownership. Do not claim
  production NIP compatibility without vector tests and selected dependency
  verification.
- Local SHA-256 CAS, immutable manifests, encrypted blob envelopes,
  read-after-write/hash verification, retention/replica model, and safe
  quarantine/previews.
- Blossom interface/adaptor and Iroh peer transport interface/probe/receipt;
  production remote connectivity remains gated on pinned upstream integration.
- Non-mutating portable checkpoint inspector/manifest and restore validation;
  never capture excluded secrets or alter the source checkout.
- Infrastructure templates for private relay, artifact store, telemetry, and
  access boundaries with no hard-coded credentials or addresses.

## 5. Hard constraints

1. Keep bytes/logs out of Nostr envelopes.
2. Integrity hash is not confidentiality; encrypt private artifacts before
   storage/transport.
3. CoLab/Hub/IRC remain separate protocols; prevent reflection loops.
4. Never delete or garbage-collect data without explicit verified eligibility.

## 6. Verification

Run tests for duplicate/reordered envelopes, CAS mismatch, encrypted roundtrip,
checkpoint exclusion, interrupted transfer metadata, and fallback selection.

## 7. Commit message

`feat(mesh-transport): add event, artifact, and handoff adapters`

## 8. Final report

Report implemented adapters versus guarded stubs, test vectors/results, and
external deployments intentionally left unperformed.
