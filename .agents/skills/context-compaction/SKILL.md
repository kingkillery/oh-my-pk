---
name: context-compaction
description: "Structured compaction and caching: 50 percent manual, 75-80 percent safety net, 5-section handoff"
---

# context-compaction

Applies the Phase 4 compaction protocol without copying it.

- Read `.agents/context/compaction-and-caching.md`, `.agents/context/compaction-template.md`, and `.agents/rules/context-and-caching.md`.
- Trigger: 50% proactive manual (~100k/200k, 3k-5k headroom); 75-80% automatic safety net.
- Keep immutable prefix byte-stable; `cache_control: { type: "ephemeral" }` at static boundary and summary block; dynamic metadata in final user prompt only.
- Emit the exact 5-section schema; offload durable facts per `.agents/context/memory-offload.md`.
- Execute with `.agents/commands/compact-handoff.md`; verify prefix before new tool calls.
