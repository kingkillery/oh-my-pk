# Lane E — OMPK integration and acceptance [acceptance-gate]

## 1. Mission + read-first

Integrate verified LocalMesh package surfaces into OMPK additively and produce
evidence for each phase gate. Read all Lane A–D plans plus:

- `packages/coding-agent/AGENTS.md`
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/modes/components/agent-hub.ts`
- `packages/coding-agent/src/orchestration/subagent-model-routing.ts`
- `packages/coding-agent/src/cli-commands.ts`
- packet `09-testing/**`, `08-operations/**`, and `10-delivery/**`

## 2. Owned files

- `packages/coding-agent/src/mesh/**` (new)
- `packages/mesh-client/**` (new)
- `packages/mesh-e2e/**` (new)
- `docs/architecture/localmesh-*` (new)
- `docs/operations/localmesh-*` (new)
- narrowly scoped existing coding-agent CLI/SDK/UI files only when required to
  expose already-tested package surfaces.

## 3. Gap

> E — Integration and acceptance: provide one OMPK experience over the
> canonical mesh API, prove end-to-end lifecycle and operations, and keep
> existing CoLab/Hub/IRC/task behavior compatible. [LARGE] depends on: A–D.

## 4. What to build

- Thin client bridge that maps curated local task/session events to mesh API
  requests and trace updates; it must not become another scheduler/state store.
- CLI/API commands for submit, status, follow, cancel, artifact inspection,
  and trace with stable JSON output.
- Agent Hub projection that consumes canonical cursored snapshots.
- End-to-end fixture: isolated harmless exact-ref task → validated artifact →
  signed receipt → completion decision → cleanup proof, including duplicate,
  restart, cancellation, stale result, and active-checkout preservation.
- Phase evidence/operations documents, deployment configuration validation,
  backup/restore/rollback procedures, and clear deferred-infrastructure flags.

## 5. Hard constraints

1. No broad rewrites of CoLab, Hub, IRC, session, or task systems.
2. Do not publish to external relays, create infrastructure, or use live
   credentials without separate user authorization.
3. Never claim integration success from a mocked happy path alone.
4. Preserve existing model routing and task worktree invariants.

## 6. Verification

Run focused package tests, e2e fixture tests, relevant coding-agent tests, and
the final suite allowed by the machine’s active-workstation policy.

## 7. Commit message

`feat(localmesh): integrate mesh control plane with OMPK`

## 8. Final report

Produce an evidence matrix with IDs/hashes, exact test commands, failure
injection outcome, active-checkout before/after proof, and all remaining
external blockers.
