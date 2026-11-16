# Copilot Instructions — oh-my-pk

Canonical SSOT: `.agents/instructions.md` (read in full). On-demand rules: `.agents/rules/` (`rule://<name>`). Context: `.agents/context/`. Commands: `.agents/commands/`.

## Scope

- Primary package: `packages/coding-agent/`. Siblings: `ai`, `catalog`, `agent`, `tui`, `natives`, `stats`, `utils`, `llm-router-agent`, `crates/pi-natives`, and Python packages `python/robomp`, `python/omp-rpc`, `python/fugu`.
- Import catalog values from `@pk-nerdsaver-ai/pi-catalog/*`, never `pi-ai`. Type-only `Model`, `Api`, `ThinkingConfig`, `Effort` from `pi-ai` allowed.
- Keep changes scoped; review logical clusters before staging; never commit unless asked.
- Read `packages/coding-agent/AGENTS.md`, `packages/catalog/AGENTS.md`, `python/robomp/AGENTS.md` before editing those directories.

## Code

- Avoid `any` and `ReturnType<>`. Use ES `#private` fields/methods.
- Use `Promise.withResolvers()`, prefer Bun APIs over `node:*` where covered, avoid sync I/O in async flows and repeated `Bun.file()` calls.
- Never run `tsc` or `npx tsc`; use `bun check`.

## Testing

- Test externally observable behavior (output, transitions, errors, regression boundaries). Focused contract/integration tests.
- No placeholders, tautologies, mocks, or source-text assertions. Restore spies per test; never use `mock.module()`.

## PR 45 & boundaries

- `main` is the production baseline. Port one coherent behavior lane at a time from `oh-my-pk Wiki/concepts/pr45-convergence.md` (**Pull into main** only); prove `main` lacks it first.
- Preserve `docs/fork-boundaries.md` boundaries: CoLab, Hub/IRC, `pk-speak /remote`, SSH, `remote-workspace` have distinct lifetimes and contracts.
- Keep stable prompt prefixes byte-stable; append dynamic context late.
- `packages/coding-agent/dist/*.exe` and `build-manifest.json` refresh in the same commit as the final `src` change; `bun run check:dist` must pass.
