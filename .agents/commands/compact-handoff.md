# compact-handoff — Structured Compaction Procedure

Trigger at 50% proactive manual (~100k/200k, 3k-5k headroom) or at the 75-80% automatic safety net.

1. Stop and emit the exact 5-section schema from `.agents/context/compaction-template.md`: `Session Intent`, `Files Modified`, `Key Decisions`, `Active Goals & Unresolved Errors`, `Next Steps`. Full repo-relative paths only; reject partial schemas.
2. Offload durable facts to `memory/` or `.agents/rules/` per `.agents/context/memory-offload.md` in the same turn.
3. Keep the immutable prefix byte-stable (`packages/coding-agent/src/system-prompt.ts`); dynamic metadata stays in the final user prompt only.
4. After compaction, verify the session/header prefix and `cache_control: { type: "ephemeral" }` breakpoints before any new tool call.
5. Resume by re-loading `.agents/context/` and `memory/`; if retrieval fails, state the gap and never hallucinate dropped state.
