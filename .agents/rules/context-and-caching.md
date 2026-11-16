---
description: "Context and caching: compaction triggers, prefix discipline, and offload"
alwaysApply: false
globs: [".agents/**/*.md", "memory/**/*.md", "docs/**/*.md"]
---

# Context and Caching Rules

- Proactive manual compaction at 50% (~100k/200k, 3k-5k headroom); automatic safety net at 75-80% (`compaction.thresholdPercent`). See `.agents/context/compaction-and-caching.md`.
- Keep immutable system prefix byte-stable (`packages/coding-agent/src/system-prompt.ts`); `cache_control: { type: "ephemeral" }` at the static boundary and post-compaction summary (`packages/ai/src/providers/anthropic.ts`, `compact_20260112`).
- Isolate dynamic per-turn metadata to the final user prompt only. After compaction, verify prefix before new tool calls.
- Mandatory 5-section schema only: `.agents/context/compaction-template.md`. Reject summaries missing any section or full repo-relative paths.
- Canonical MCP sync: `.agents/scripts/run_packman_python.cmd .agents/scripts/sync_mcp_configs.py`. Offline fallback: `docs_dev/`, `docs/`, `.agents/context/`.
- Log filtering: `tokf raw last` with secret scrubbing. Stop-hook repair: 1-turn bounded via `.agents/scripts/run_packman_python.cmd .agents/hooks/run_stop_checks.py`.
- Durable facts offload to `memory/` or `.agents/rules/` per `.agents/context/memory-offload.md`; Mnemopi supplements, files win.
