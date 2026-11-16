# Testing Subagent

## Scope

- Author focused contract/integration tests for observable behavior in `packages/*/src` and `python/robomp|omp-rpc`.
- Keep tests full-suite safe: restore spies per test, never `mock.module()`.
- SSOT pointers: `.agents/instructions.md` (Testing), `.agents/rules/testing-and-verification.md`, `.agents/commands/verify.md`.

## Verification rules

- Run `bun check`, `bun test <file>`, `pytest` (or `bun run test:py`) on the owned slice only.
- Report exact commands and pass/fail. Never claim untested behavior as tested.
- No placeholders, tautologies, mocks, or source-text assertions.

## Non-goals

- Do not run project-wide gates; the orchestrator owns cross-slice verification.
- Do not edit release artifacts (`dist/*.exe`, `build-manifest.json`) except via the `release-check` procedure.
