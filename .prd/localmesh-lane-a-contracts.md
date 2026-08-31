# Lane A — Mesh contracts and policy [pre-phase]

## 1. Mission + read-first

You establish the stable, transport-neutral contract and authorization surface
that every later LocalMesh lane consumes. Read in full:

- `.prd/localmesh-orchestration.md`
- `../ompk-sovereign-agent-mesh-packet/02-contracts/CONTRACTS_GUIDE.md`
- `../ompk-sovereign-agent-mesh-packet/02-contracts/schemas/`
- `packages/coding-agent/src/task/assignment-contract.ts`
- `packages/coding-agent/src/orchestration/task-contract.ts`
- `packages/coding-agent/src/orchestration/reasoning-plan.ts`
- root `AGENTS.md`

## 2. Owned files

You may edit only new files under:

- `packages/mesh-contracts/**`
- `packages/mesh-policy/**`

You may not edit existing OMPK task, CoLab, Hub, relay, or remote-workspace
files. Do not add a runtime dependency on Nostr, Blossom, Iroh, Docker, or a
database.

## 3. Gap

> A — Contracts and policy: OMPK has local task and assignment contracts but
> lacks mesh envelopes, node/lease/receipt/artifact contracts, identity and
> delegation policy, and versioned transport-neutral validation. [LARGE]
> depends on: none.

## 4. What to build

- Bun workspace packages with explicit package names and build/check/test
  scripts consistent with the monorepo.
- Immutable TypeScript types and validators for task, plan, assignment lease,
  event envelope, node advertisement, artifact manifest, checkpoint manifest,
  evidence record, execution receipt, completion decision, policy decision,
  approval, identity delegation, and revocation.
- Canonical JSON plus SHA-256 digests with recursive key ordering, no silent
  coercion, and test vectors.
- Typed error taxonomy with safe operator detail.
- Narrowing checks: a child assignment cannot broaden a task's goal, policy,
  budget, capabilities, paths, model trust level, or retention requirements.
- Versioned schema fixtures for valid and invalid forms. IDs must use the
  prefixes specified in the implementation packet.

## 5. Hard constraints

1. No new runtime dependencies unless already present in root `package.json`.
2. Keep domain contracts protocol-neutral; no Nostr/Blossom/Iroh types.
3. Use immutable frozen outputs and deterministic time/UUID injection in tests.
4. A cryptographic signature is never considered authorization by itself.
5. Do not use `any`, `ReturnType<>`, or source-text-only tests.

## 6. Verification

Run focused tests for canonicalization, validation, authorization attenuation,
revocation, and invalid fixtures. Report the exact commands and changed paths.

## 7. Commit message

`feat(mesh-contracts): establish versioned mesh contracts and policy`

## 8. Final report

Report public exports, fixtures, validation commands/results, changed paths,
and any intentionally deferred cryptographic-provider choice.
