# Developer Docs (Offline Fallback)

Use this index when external MCP endpoints are unreachable (corporate VPN, offline, rate-limited). Never block on network; continue locally.

## Local map

- `docs/` — authoritative product docs: `docs/fork-boundaries.md` (command, identity, domain, surface, LocalMesh boundaries), `docs/multi-agent-fork-collaboration.md` (Linear-suspended manual queue mode), `docs/fusion.md`, `docs/settings.md`, `docs/models.md`, `docs/providers.md`.
- `.agents/context/` — `architecture.md` (workspace + discovery priorities), `four-loop-architecture.md` (Loop 1-4), `compaction-and-caching.md` (Phase 4), `compaction-template.md` (5-section schema), `mcp-and-surfaces.md` (11-surface matrix + sync targets), `memory-offload.md` (promotion rules).
- `.agents/rules/` — `core-engineering.md`, `testing-and-verification.md`, `context-and-caching.md`, `workflow-modes.md` (load via `rule://<name>`).
- `.agents/commands/` — `verify.md`, `compact-handoff.md`, `sync-mcp.md`, `release-check.md`.
- Package `AGENTS.md` — `packages/coding-agent/AGENTS.md`, `packages/catalog/AGENTS.md`, `python/robomp/AGENTS.md` (pre-read before editing those trees).

## Sync and logs

- Canonical sync: `.agents/scripts/run_packman_python.cmd .agents/scripts/sync_mcp_configs.py`. Generated targets: `.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.windsurf/mcp.json`, `.ompk/mcp.json`.
- Logs: `tokf raw last` with secret scrubbing. Stop-hook repair: `.agents/scripts/run_packman_python.cmd .agents/hooks/run_stop_checks.py` (1-turn bounded).

## Rule

If a surface cannot be reached, mark it degraded in the handoff and cite the local file you used instead. Do not invent endpoint contents.
