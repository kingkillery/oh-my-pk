# oh-my-pk Canonical Instructions

SSOT is `.agents/`: `context/`, `rules/`, `commands/`, `skills/`, `subagents/`, `hooks/`, `scripts/`. Root and tool adapters (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.clinerules`, `.omp/`, `.pi/`, `.claude/`, `.cursor/`, `.codex/`, `.windsurf/`, `.github/`) stay thin pointers to this file. Read deeper package `AGENTS.md` before editing that tree; `packages/coding-agent/AGENTS.md`, `packages/catalog/AGENTS.md`, `python/robomp/AGENTS.md` are mandatory pre-reads for their dirs.

## Scope

- Primary package `packages/coding-agent/`; siblings `ai`, `catalog`, `agent`, `tui`, `natives`, `stats`, `utils`, `llm-router-agent`, `crates/pi-natives`, plus `python/robomp`, `python/omp-rpc`, `python/fugu`.
- Import catalog values from `import { X } from '@pk-nerdsaver-ai/pi-catalog/<module>'`, never from `pi-ai`. Type-only `import type { Model, Api, ThinkingConfig, Effort } from 'pi-ai'` is allowed.
- Keep changes scoped; review logical clusters before staging. Never commit unless asked.
- Collaboration: `docs/multi-agent-fork-collaboration.md`. Surfaces: `docs/fork-boundaries.md`.

## Colab and model intent

- Colab is general compute by default; `/colab-model` or explicit inference intent establishes model intent.
- Fresh sessions must inspect existing sessions first, offer connection when compatible, provision only when requested.
- Runtime, served model, bridge, provider registration, harness generation are separate evidence gates. Never claim `llama.cpp (colab)` from a saved registry entry without probing the live bridge.

## Single-agent loop

- When solo-first is requested, reuse Simple Mode (`task.simpleMode`, `/simple`). Do not build another single-agent mode, orchestrator, or supervisor.
- Keep reasoning, planning, implementation, and final accountability with the primary agent. Load specialized knowledge via skills/tools, not by spawning an agent merely to hold instructions.
- Preserve optional multi-agent: bounded helpers in Simple Mode, full specialist/parallel workflows when deliberately selected.
- Integrate `work_context` as a scoped read-only tool of the primary agent; verify native availability, do not assume a candidate install.
- Preserve lifecycle authority, permissions, isolation, auditing, evidence-backed completion.

## PR 45 convergence

- `main` is production baseline. PR 45 and `codex/pr45-minimal-reconciliation` are donor branches, not merge bases.
- Port one coherent behavior lane at a time from a named donor commit, adapting to current `main`. Pull only items marked **Pull into main** in `oh-my-pk Wiki/concepts/pr45-convergence.md`; **Already in main** items are verification anchors.
- Prove `main` lacks the behavior first; prefer current `main` design.
- Each port: observable contract, focused tests, package typecheck/lint, final union check. Harness-only success does not make a branch merge-ready.
- Preserve fork boundaries: CoLab, Hub/IRC, pk-speak `/remote`, SSH, remote-workspace have distinct lifetimes and APIs. `/collab` is ephemeral encrypted sharing; `/remote` is pk-speak persistent operator gateway; `/remote-control` is collab compatibility alias.
- Keep stable prompt prefixes byte-stable, append dynamic context late. Never trade required instructions, tool schemas, or safety for cache hits.

## Kade bootstrap

- Bootstrap from `C:\Users\prest\.agents\kade.md` and `human.md`; load `kade-hq` for detail.
- Unqualified wiki updates route to `C:\dev\Vaults\Design-and-Building\oh-my-pk Wiki\`. External Kade vault `C:\dev\Vaults\Kade` is explicit Kade destination only. `pk-has-adhd` is supplemental.

## Machine and compute (`pk`)

- Never `taskkill` `bun.exe`/`node.exe` broadly. Filter `Get-CimInstance Win32_Process` on `CommandLine` and kill only own-script matches.
- Heavy verification may offload to `msi`: `cd C:/dev/Infra/ompk-remote && bun run remote.mjs auto --bg -- bun test <file>`. Test-class routes to `msi`, light stays local.

## Code

- Avoid `any` and `ReturnType<>`; use ES `#private` fields/methods.
- Use `Promise.withResolvers()`, not the constructor pattern. Prefer Bun APIs; use `node:*` only where Bun lacks coverage.
- In async flows avoid sync I/O, unnecessary copies, repeated `Bun.file()` calls.
- Never run `tsc` or `npx tsc`; use `bun check`. Never edit `src/models.json`; fix resolver/descriptors and run `bun run generate-models`.

## Bend

- `bend guide` to learn, `LAWS.bend` for rules, `bend PROOF.bend` before commit. Parallelize where possible.

## Testing

- Test externally observable behavior: output, transitions, errors, regression boundaries.
- Focused contract/integration tests. No placeholders, tautologies, mocks, or source-text assertions.
- Restore spies per test, never `mock.module()`. Exercise real lifecycle transitions; skip only tiny edits without contract impact.

## Changelog and release

- Entries only under `## [Unreleased]`; released sections immutable.
- Never create GitHub issues/comments or run release/commit unless asked.
- `packages/coding-agent/dist/*.exe` and `build-manifest.json` must refresh in the same commit as the final `packages/*/src` change; `bun run check:dist` fails otherwise.

## Context, compaction, caching

- Two-tier compaction: proactive manual compaction at 50% (~100k/200k tokens, keep 3k-5k output headroom) and automatic safety net at 75-80% (`compaction.thresholdPercent`, 80% ceiling). See `.agents/context/compaction-and-caching.md` and `.agents/context/compaction-template.md`.
- Keep immutable system prefix byte-stable at top (`packages/coding-agent/src/system-prompt.ts`); explicit `cache_control: { type: "ephemeral" }` at static system boundary and post-compaction summary block (`packages/ai/src/providers/anthropic.ts`, Anthropic `compact_20260112`); dynamic per-turn metadata isolated to final user prompt only.
- After compaction verify session/header prefix before new tool calls. Mandatory 5-section compaction schema only.
- Canonical `.mcp.json` sync: `.agents/scripts/run_packman_python.cmd .agents/scripts/sync_mcp_configs.py`. Offline fallback: `docs_dev/`, `docs/`, `.agents/context/`, local patterns.
- Log filtering: `tokf raw last` with secret scrubbing. Stop-hook repair: 1-turn bounded via `.agents/scripts/run_packman_python.cmd .agents/hooks/run_stop_checks.py`.

## Self-Improvement Memory (SIM)

- Canonical harness edit ledger: `.omp/sim.json` (schema v2 `.omp/sim.schema.json`), injected into `buildSystemPrompt` as untrusted experiential data (SEC-007: never authorization or policy authority).
- Before editing prompts, hooks, parsers, retry policies, truncation, or `pi-catalog` compat fixups, follow `.agents/rules/harness-sim.md` (check `domain + benchmark + model` provenance, reuse transferable rationale, recalibrate model-specific heuristics).
- Two-phase workflow: `bun run sim:predict` -> `bun run sim:replay` -> `bun run sim:record` -> `bun run sim:validate` (plus `bun run sim:carry` for cross-run carry-forward and `bun run sim:status`).
- Attribution & §3.2 hygiene: 8-state baseline-to-candidate attribution (`fixed` requires `FAIL -> PASS` against a matching baseline); `.omp/sim.json` stores chosen edits only (`accepted: true`), while rejected candidates (`accepted: false`) append to `.omp/sim-rejected.jsonl`.
