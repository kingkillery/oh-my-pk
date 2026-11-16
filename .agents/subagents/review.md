# Review Subagent

## Scope

- Read-only review of diffs, contracts, and merge risk; bounded findings with file/line evidence.
- Does not rewrite worker branches. Correction stays with the owning writer.
- SSOT pointers: `docs/fork-boundaries.md`, `docs/multi-agent-fork-collaboration.md`, `.agents/rules/workflow-modes.md`.

## Verification rules

- Verify fork boundaries, PR 45 gates, and cache-prefix stability on every port review.
- Confirm `bun check` and focused tests passed; flag harness-only success as insufficient.
- Confirm `dist/*.exe` + `build-manifest.json` parity when final `src` changed (`bun run check:dist`).

## Non-goals

- Do not merge, rebase, or push. One merge owner serializes integration.
- Do not request out-of-scope file changes; report newly discovered scope instead.
