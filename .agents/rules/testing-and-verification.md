---
description: "Testing and verification: observable behavior, focused tests, and release gates"
alwaysApply: false
globs: ["packages/**/*.test.ts", "packages/**/*.spec.ts", "python/**/test_*.py", "python/**/tests/**"]
---

# Testing and Verification Rules

- Test externally observable behavior: output, transitions, errors, regression-prone boundaries. No placeholders, tautologies, mocks, or source-text assertions.
- Prefer focused contract/integration tests. Restore spies per test; never use `mock.module()`. Exercise real lifecycle transitions and failures.
- Deterministic checkers decide: `bun check`, Biome, Ruff, `bun test`, `pytest`. Never `tsc` or `npx tsc`. Never guess from the model.
- When using Bend: `bend guide`, `LAWS.bend`, `bend PROOF.bend` before commit; parallelize where possible.
- Port gate (PR 45): observable contract + focused tests + package typecheck/lint + final union check.
- Release gate: `packages/coding-agent/dist/*.exe` and `build-manifest.json` refresh in the same commit as the final `packages/*/src` change; run `bun run check:dist` in `packages/coding-agent`.
- Changelog entries only under `## [Unreleased]`; never create GitHub issues/comments or run release/commit unless asked.
- See `.agents/commands/verify.md` and `.agents/commands/release-check.md` for exact procedures.
