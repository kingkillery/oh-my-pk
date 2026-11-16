# Memory Offload — Durable External Memory Rules

Compaction summarizes a session; memory offload preserves what the next session must not rediscover. Put durable facts on disk, keep chat history ephemeral.

## Where things live

- `memory/README.md` — durable project memory index and schema. One fact per entry, with date, scope, and verification command.
- `.agents/rules/*.md` — load-on-demand rules (`alwaysApply: false`, `description`, `globs`, `rule://<name>`); promote session-discovered invariants here only when they are stable and testable.
- `.agents/context/*.md` — architecture and protocol reference, not a diary.
- Mnemopi (`retain` / `recall` / `reflect`) — supplemental recall layer. It never replaces the files above; file content wins on conflict.

## Promotion criteria

Promote a session discovery to `memory/` or `.agents/rules/` only when all hold:

1. It is stable across sessions (not a transient branch name, SHA, or worktree path).
2. It has an observable contract and a verification command (`bun check`, `bun test`, `pytest`, `tokf raw last`, `bun run check:dist`, or the exact repo-local command).
3. It names a repo-relative path or command, never a bare description.
4. It does not contain secrets, tokens, env dumps, or credentialed URLs (redact per `python/robomp` `sandbox.redact_credentials` precedent).
5. `check_memory_promotion.py` passes; rejected promotions stay in session history.

Do not promote: full transcripts, raw logs, diffs, screenshots, unbounded webhook payloads, pasted issue threads, or provider credentials. Link to the artifact instead.

## Schema discipline

- `memory/` entries: `title`, `date`, `scope`, `fact`, `verification`, `expires` (or `permanent`). Keep entries scannable; no prose essays.
- `.agents/rules/` entries: valid YAML frontmatter (`description`, `alwaysApply: false`, `globs`), concrete directives only, no duplicated core prose from `.agents/instructions.md`.
- Compaction summaries (`compaction-template.md`) never serve as memory. If a summary contains a durable fact, offload it during the same turn.

## Relationship to sessions

- SessionManager JSONL and `GoalRuntime` are runtime state (Loop 3), not knowledge. Memory files are knowledge (Loop 4 input to `autolearn` / `evolve-skill-from-traces`).
- After compaction, re-load `memory/README.md` and `.agents/context/` instead of re-deriving from chat. If retrieval fails, state the gap explicitly.
