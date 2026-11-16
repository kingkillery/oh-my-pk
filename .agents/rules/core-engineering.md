---
description: "Core engineering: scope, imports, Bun/promise rules, and fork boundaries"
alwaysApply: false
globs: ["packages/*/src/**/*.ts", "crates/**/*.rs", "python/**/*.py"]
---

# Core Engineering Rules

- Primary package `packages/coding-agent/`; siblings `ai`, `catalog`, `agent`, `tui`, `natives`, `stats`, `utils`, `llm-router-agent`, `crates/pi-natives`. Stay scoped to the owning package.
- Import catalog values from `@pk-nerdsaver-ai/pi-catalog/<module>`; never `pi-ai` for values. Type-only `Model`, `Api`, `ThinkingConfig`, `Effort` from `pi-ai` allowed.
- Never edit `src/models.json`; fix resolver/descriptors then run `bun run generate-models`.
- Keep changes scoped; review logical clusters before staging; never commit unless asked.
- Read `packages/coding-agent/AGENTS.md` before touching `packages/coding-agent/`; read `packages/catalog/AGENTS.md` before touching `packages/catalog/`; read `python/robomp/AGENTS.md` before touching `python/robomp/`.
- Code: no `any`, no `ReturnType<>`; ES `#private`; `Promise.withResolvers()`; prefer Bun APIs, `node:*` only where uncovered; no sync I/O or repeated `Bun.file()` in async flows; never `tsc`, use `bun check`.
- Preserve `docs/fork-boundaries.md`: `/collab` vs `/remote` vs `/remote-control`, `oh-my-pk` identity, domain separation, LocalMesh isolation.
- See `.agents/context/architecture.md` for the workspace map and `.agents/instructions.md` for canonical scope.
