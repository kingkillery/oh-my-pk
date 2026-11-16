# Four-Loop Architecture Blueprint — Mapped to oh-my-pk

The harness is a four-loop agent: grounded action, deterministic verification, durable orchestration, and hill-climbing evolution. Each loop owns one failure class and one primary implementation surface in this monorepo.

## Loop 1 — ReAct Agent Core

Cycle: Think -> Act -> Observe -> Think. Grounded extraction happens before decisions; no tool call is issued from an ungrounded plan.

- Implementation: `AgentSession` in `packages/coding-agent/` plus `model.loopGuard`. Step caps and loop guards defend ungrounded actions and infinite tool loops; repeated identical tool intent without new observation terminates.
- System prefix is immutable and byte-stable (`packages/coding-agent/src/system-prompt.ts`); dynamic context appends late. Prompt templates are static `.md` files imported with `with { type: "text" }`, never built in code.
- `work_context` is a scoped read-only tool of the primary agent; verify native availability rather than assuming an install. Simple Mode reuses `task.simpleMode` / `/simple` without a second orchestrator.

## Loop 2 — Verification and Retry

Deterministic checkers decide; the model does not guess. Failure feedback is targeted: exact failure lines, exact command, exact file, then a single bounded retry.

- Commands: `bun check` (never `tsc`), Biome for TypeScript, Ruff for Python, `bun test` and `pytest` for behavior, `.agents/hooks/check_completion_gates.py` for stop-hook completion gates (and `python/robomp/src/host_tools.py` for bot PR gates), `bun run check:dist` in `packages/coding-agent` for release parity.
- Retry cap: 1-turn bounded stop-hook repair via `.agents/scripts/run_packman_python.cmd .agents/hooks/run_stop_checks.py`. No open-ended self-repair loops.
- Failure modes to reject: placeholder tests, tautologies, mocks, source-text assertions, `mock.module()`, un-restored spies. Tests assert externally observable behavior only.
- Port gate (PR 45): observable contract + focused tests + package typecheck/lint + final union check. Harness-only success is insufficient.

## Loop 3 — Event Queue Poller

Durable state persistence and orchestration separate from single-turn reasoning. Crashes resume; no context is invented after restart.

- Implementation: `GoalRuntime` + `SessionManager` JSONL under `packages/coding-agent/` for sessions/goals; `python/robomp` SQLite `WorkerPool` with `BEGIN IMMEDIATE` claim, `_inflight` per-issue serialization, `ROBOMP_MAX_CONCURRENCY` (default 8); Linear queue mirrors under `docs/multi-agent-fork-collaboration.md` manual queue mode.
- Heartbeats, webhooks, and goal checks drive polling; checksum/manifest validation guards state; isolated exception handling records `failed` with redacted trace and releases the slot.
- robomp flow: `POST /webhook/github` (HMAC, 401 on bad) -> `db.record_event` dedup on delivery ID -> `_dispatch_loop` claims `queued` -> `SandboxManager` worktree `farm/<8hex>/<slug>` -> `omp --mode rpc` with `--continue` resuming the session dir -> `done`/`failed`.
- Linear states: Backlog, Todo+Ready, In Progress, In Review, Done, Blocked/Reconcile/Dead Letter. One `Queue/*` label only; retained claims serialize overlaps.

## Loop 4 — Hill-Climbing (Prompt and Skill Evolution)

Reflect on historical failure traces, mutate instructions/skills, gate against held-out evals to prevent overfitting, under an isolated budget.

- Implementation: `autolearn`, `evolve-skill-from-traces`, `tool-prompt-optimization`, `check_memory_promotion.py` (promotion criteria in `.agents/context/memory-offload.md`).
- Budget guard: `BudgetExhaustedError` stops evolution; exhausted budgets never fall back to unbounded retries or to silent truncation of the envelope.
- Evolution never edits `packages/*/src` wholesale, never replaces generated catalogs wholesale, never replays **Already in main** lanes. Each mutation ships with eval evidence and a rollback note.
- Memory promotion rule: session discoveries promote to `memory/` or `.agents/rules/` only with an observable contract and a verification command; otherwise they stay in session history.

## Loop wiring

Loop 1 proposes, Loop 2 disposes, Loop 3 persists, Loop 4 improves. Compaction (`.agents/context/compaction-and-caching.md`) is the context-hygiene layer that keeps Loop 1 grounded across long sessions.
