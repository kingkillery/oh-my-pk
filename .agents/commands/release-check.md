# release-check — Changelog and Distribution Parity

1. Confirm changelog entries are only under `## [Unreleased]`; released sections are immutable.
2. Confirm no GitHub issues/comments and no release/commit commands were run without explicit user ask.
3. Confirm `packages/coding-agent/dist/*.exe` was rebuilt and `build-manifest.json` refreshed in the same commit as the final `packages/*/src` change.
4. Run `bun run check:dist` in `packages/coding-agent`; it must pass. A mismatch blocks release.
5. Confirm PR 45 gates for any ported lane: observable contract, focused tests, package typecheck/lint, final union check.
6. Report exact commands, outputs, and the commit SHA when authorized.

See `.agents/rules/testing-and-verification.md` and `docs/multi-agent-fork-collaboration.md`.
