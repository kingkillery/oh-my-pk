# Lane E — OMPK integration and acceptance [acceptance-gate]

## 1. Mission + read-first

Expose verified LocalMesh package surfaces to OMPK as a **personal, opt-in
ompk extension** and produce evidence for each phase gate. LocalMesh is not a
core feature: core never imports it, and it is enabled only by loading the
extension (`~/.ompk/agent/extensions`, the `extensions:` setting, or
`--extension`). Read all Lane A–D plans plus:

- `docs/extensions.md` and `docs/extension-loading.md` (the `ExtensionAPI`
  contract and how extensions are discovered)
- `packages/clips-extension` (a small reference `omp.extensions` package)
- read-only, to understand existing behaviour: `packages/coding-agent/src/sdk.ts`,
  `packages/coding-agent/src/modes/components/agent-hub.ts`,
  `packages/coding-agent/src/orchestration/subagent-model-routing.ts`
- packet `09-testing/**`, `08-operations/**`, and `10-delivery/**`

## 2. Owned files

- `extensions/localmesh/packages/localmesh-extension/**` (new): the
  `omp.extensions` entry point; registers commands/tools through `ExtensionAPI`
- `extensions/localmesh/packages/mesh-client/**` (new)
- `extensions/localmesh/packages/mesh-e2e/**` (new)
- `extensions/localmesh/docs/architecture/**` (new)
- `extensions/localmesh/docs/operations/**` (new)
- no files under `packages/coding-agent/**`. If the extension needs a hook that
  `ExtensionAPI` lacks, propose a generic, LocalMesh-agnostic hook as its own
  core PR rather than wiring mesh code into core.

## 3. Gap

> E — Integration and acceptance: provide one OMPK experience over the
> canonical mesh API, prove end-to-end lifecycle and operations, and keep
> existing CoLab/Hub/IRC/task behavior compatible. [LARGE] depends on: A–D.

## 4. What to build

- Thin client bridge that maps curated local task/session events to mesh API
  requests and trace updates; it must not become another scheduler/state store.
- Extension commands/tools for submit, status, follow, cancel, artifact
  inspection, and trace with stable JSON output.
- Any Agent Hub view goes through a generic extension hook, never a direct
  edit of `agent-hub.ts`.
- End-to-end fixture: isolated harmless exact-ref task → validated artifact →
  signed receipt → completion decision → cleanup proof, including duplicate,
  restart, cancellation, stale result, and active-checkout preservation.
- Phase evidence/operations documents, deployment configuration validation,
  backup/restore/rollback procedures, and clear deferred-infrastructure flags.

## 5. Hard constraints

1. No edits to CoLab, Hub, IRC, session, task, or other core systems; LocalMesh
   reaches OMPK only through the extension API.
2. Do not publish to external relays, create infrastructure, or use live
   credentials without separate user authorization.
3. Never claim integration success from a mocked happy path alone.
4. Preserve existing model routing and task worktree invariants.

## 6. Verification

Run focused package tests, e2e fixture tests, relevant coding-agent tests, and
the final suite allowed by the machine’s active-workstation policy.

## 7. Commit message

`feat(localmesh): add the LocalMesh ompk extension`

## 8. Final report

Produce an evidence matrix with IDs/hashes, exact test commands, failure
injection outcome, active-checkout before/after proof, and all remaining
external blockers.
