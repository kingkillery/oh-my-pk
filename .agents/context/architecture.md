# Architecture — Ambient Repo Blueprint

Monorepo root `C:/dev/infra/oh-my-pk`, primary package `packages/coding-agent/` (the harness: CLI, AgentSession, system-prompt assembly, discovery, tooling). Siblings below are runtime planes, not independent apps.

## Workspace map

- `packages/coding-agent/` — primary implementation: `src/system-prompt.ts` (immutable prefix + `CONTEXT_FILE_BLOAT_WARNING_CHARS = 8_000`), `src/discovery/` (context-file providers), `src/capability/`, `src/extensibility/skills`, `src/tools/`, `src/prompts/system/`.
- `packages/ai/` — provider wire layer; `src/providers/anthropic.ts` owns `cache_control: { type: "ephemeral" }` breakpoints and Anthropic `compact_20260112` behavior.
- `packages/catalog/` — model catalog; never edit `src/models.json` directly, fix resolvers/descriptors then `bun run generate-models`.
- `packages/agent/`, `packages/tui/`, `packages/natives/`, `packages/stats/`, `packages/utils/`, `packages/llm-router-agent/` — agent core, terminal UI, native bindings, stats, utilities, routing.
- `crates/pi-natives/` plus `crates/pi-shell`, `crates/pi-ast`, `crates/pi-iso` — Rust-native helpers consumed by the harness.
- `python/robomp/` — GitHub triage-and-fix bot driving `omp --mode rpc`; durable SQLite queue, `WorkerPool`, worktree sandbox.
- `python/omp-rpc/` — RPC bridge; `python/fugu/` — companion Python tooling.
- `docs/` — authoritative product docs: `docs/fork-boundaries.md`, `docs/multi-agent-fork-collaboration.md`, `docs/fusion.md`, `docs/settings.md`, `docs/models.md`.
- `.agents/` (this tree) — Single Source of Truth: `context/`, `rules/`, `commands/`, `skills/`, `subagents/`, `hooks/`, `scripts/`. `docs_dev/` and `memory/` are offline fallback and durable-memory indexes.

## Discovery provider priority

OMPK `context-files` deduplicates to one winner at `project:0` by priority. Higher wins:

| Priority | Provider | File | Role |
|---|---|---|---|
| 100 | `native` | `.ompk/AGENTS.md` | DO NOT create; native override only |
| 90 | `okf` | OKF discovery | Open Knowledge Format |
| 80 | `claude` | `.claude/CLAUDE.md` | DO NOT create; root `CLAUDE.md` is the Claude surface |
| 70 | `agents` | `.agents/AGENTS.md` | Canonical SSOT pointer (this tree) |
| 70 | `codex` | `.codex/` | Codex surface, tie-break by discovery order |
| 60 | `gemini` | `.gemini/GEMINI.md` | Thin pointer to SSOT |
| 50 | `cursor` | `.cursor/rules/*` | Always-apply deduped via `dedupeAlwaysApplyRules` |
| 50 | `windsurf` | `.windsurf/rules/*` | Manual rules, <6,000 chars |
| 40 | `cline` | `.clinerules` | Cline rules file |
| 30 | `github` | `.github/copilot-instructions.md` | Copilot instructions |
| 20 | `vscode` | `.vscode/*` | Workspace settings |
| 10 | `agents-md` | root `AGENTS.md` | Thin shim, `@.agents/instructions.md` + map |
| 5 | `mcp-json` | `.mcp.json` | MCP server registry (synced, not hand-edited) |

`agents` at 70 wins over `github` (30) and `agents-md` (10). `.agents/AGENTS.md` contains exactly `@./instructions.md` so `expandAtImports` resolves to the 6,306-char canonical file within the 8,000-char `CONTEXT_FILE_BLOAT_WARNING_CHARS` budget.

## Fork boundaries

`docs/fork-boundaries.md` defines five: (1) command namespace — `/collab` primary, `/remote-control` collab alias, `/remote` pk-speak extension only; (2) product identity — fork outbound uses `oh-my-pk` via `APP_NAME`; (3) hosting domains — `oh-my-pk.pkking.computer` landing/browser client, `collab.pkking.computer` relay/storage/hub, apex `pkking.computer`; (4) surface capability — ephemeral encrypted sharing vs persistent paired operator gateway; (5) LocalMesh isolation under `extensions/localmesh/`, never imported by core.

## Multi-agent collaboration

`docs/multi-agent-fork-collaboration.md` defines the Linear-suspended manual queue mode: one fork, branch-per-issue, worktree-per-agent, one writer per worktree, one merge owner. WIP caps 3 global / 2 per repo / 1 overlapping lane / 1 merge lane. Handoff envelopes are bounded (16 KB queue, 2k-char brief); never embed transcripts, secrets, or unbounded logs.
