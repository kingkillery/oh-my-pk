# Compaction and Caching — Phase 4 Protocol

Structured compaction preserves grounding while keeping the prompt prefix cacheable. Two triggers, one schema, strict prefix discipline.

## Triggers

- Proactive manual compaction at 50% of the window (~100k/200k tokens). Reserve 3k-5k tokens for output headroom. Invoke the `compact-handoff` command before the model degrades into summarization drift.
- Automatic safety net at 75-80% (`compaction.thresholdPercent`; Claude Code ceiling 80%). Automatic compaction is a safety net, not a plan; frequent hits mean the task should have been decomposed.
- Never trade required instructions, tool schemas, or safety context to increase cache hits (PR 45 caching policy).

## Immutable system prefix

- Stable harness instructions live at the top and stay byte-identical across turns: `packages/coding-agent/src/system-prompt.ts`. `CONTEXT_FILE_BLOAT_WARNING_CHARS = 8_000` warns when an expanded context file exceeds ~2k tokens; trim files instead of silently taxing every turn.
- Split static from dynamic: static `.md` prompt files with Handlebars, imported with `with { type: "text" }`. Dynamic project context renders after the static prefix; Fusion-style dynamic blocks stay terminal and deduplicated via `dedupeAlwaysApplyRules` / `dedupePromptSource`.

## Cache breakpoints

- Provider `packages/ai/src/providers/anthropic.ts` places explicit `cache_control: { type: "ephemeral" }` at (1) the static system-prompt boundary and (2) the post-compaction summary block.
- Anthropic `compact_20260112` behavior: the compacted summary is cache-prefixed so post-compaction turns reuse the prefix instead of re-encoding history. Verify prefix stability after every compaction.
- Prefix-cache discipline: keep stable prompt prefixes byte-stable, append dynamic context late. Test rendered behavior and capability gating, not source text, when caching changes.

## Dynamic metadata isolation

- Per-turn metadata (goal progress, repo context, tool results) is isolated strictly to the final user prompt. It must never be interleaved into the system prefix or static context files.
- `packages/coding-agent/src/system-prompt.ts` renders active repo context and project context after the static template. Custom system prompts resolve through the same path; user-level files never mutate the project prefix.

## Post-compaction verification

1. Before any new tool call, verify the session/header prefix matches the pre-compaction prefix (byte-stable check on `system-prompt.ts` output).
2. Confirm `cache_control` breakpoints still hit: static boundary and summary block.
3. Replay the mandatory 5-section schema from `.agents/context/compaction-template.md` verbatim; reject summaries missing any section or full repo-relative paths.
4. Re-load durable context from `.agents/context/` and `memory/` rather than re-deriving from chat history. If retrieval fails, say so; never hallucinate the dropped state.

## External memory offload

- Architectural decisions and operational facts that outlive a session belong in `memory/` or `.agents/rules/` (promotion criteria in `.agents/context/memory-offload.md`), not in compaction summaries.
- Compaction summarizes the session; memory offload preserves what the next session must not rediscover. Mnemopi (`retain` / `recall` / `reflect`) supplements, never replaces, these files.
