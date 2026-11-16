---
alwaysApply: false
description: oh-my-pk core operational, coding, testing, compaction, and hook rules. Deep procedures live in .agents/; this file inlines the always-needed subset only.
---

# oh-my-pk Project Rules

SSOT: `.agents/instructions.md`. On-demand: `.agents/rules/`, `.agents/context/`, `.agents/commands/`. Root map: `AGENTS.md`.

## Scope

- Primary: `packages/coding-agent/`. Siblings: `ai`, `catalog`, `agent`, `tui`, `natives`, `stats`, `utils`, `llm-router-agent`, `crates/pi-natives`.
- Imports: `@pk-nerdsaver-ai/pi-catalog/*` for values, never `pi-ai` (type-only `Model`, `Api`, `ThinkingConfig`, `Effort` allowed).
- Keep changes scoped; review logical clusters before staging. Never commit unless asked.
- Read `packages/coding-agent/AGENTS.md`, `packages/catalog/AGENTS.md`, `python/robomp/AGENTS.md` before editing those directories.
- Boundaries: `docs/fork-boundaries.md` (CoLab, Hub/IRC, pk-speak `/remote`, SSH, remote-workspace are distinct). Collab: `docs/multi-agent-fork-collaboration.md`.

## Code

- Avoid `any` and `ReturnType<>`. Use ES `#private` fields/methods.
- Use `Promise.withResolvers()`. Prefer Bun APIs; `node:*` only where Bun lacks coverage.
- Avoid sync I/O in async flows and repeated `Bun.file()` calls.
- Never `tsc` / `npx tsc`; use `bun check`.

## Testing

- Test observable behavior: output, transitions, errors, regression boundaries.
- Focused contract/integration tests. No placeholders, tautologies, mocks, or source-text assertions.
- Restore spies per test; never use `mock.module()`.

## PR 45

- `main` is the baseline; port one behavior lane at a time (**Pull into main** only in `oh-my-pk Wiki/concepts/pr45-convergence.md`); prove `main` lacks it first; contract + tests + `bun check` + union check.
- Keep stable prompt prefixes byte-stable; append dynamic context late.

## Compaction

- Auto-compact ceiling 80% context; proactive compaction at 50-75%. Preserve stable prefix, append dynamic context late. Handoff: `.agents/commands/compact-handoff.md`.

## Hooks & MCP

- Stop hooks: `.agents/hooks/run_stop_checks.py` via `.agents/scripts/run_packman_python.cmd`.
- MCP SSOT: root `.mcp.json`; sync IDE targets with `.agents/scripts/sync_mcp_configs.py` (and `--check`).
- Offline fallback: bypass unreachable external MCP endpoints; use local repo patterns, `docs_dev/`, `docs/`, `.agents/context/`.

## Changelog

- Entries only under `## [Unreleased]`. Never create issues/comments or release/commit unless asked. `dist/*.exe` + `build-manifest.json` refresh in same commit as final `src` change (`check:dist`).
