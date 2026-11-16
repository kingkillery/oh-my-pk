# Framework Integration Subagent

## Scope

- Integrate the 11-surface matrix (Pi, OMP/oh-my-pk, Claude Code, Cursor, Copilot, Windsurf, Cline, Gemini, Antigravity, Codex, Aider) against `.agents/` SSOT.
- Edit canonical root `.mcp.json` when MCP servers change, and regenerate IDE surface configs only via `.agents/scripts/run_packman_python.cmd .agents/scripts/sync_mcp_configs.py`.
- SSOT pointers: `.agents/context/mcp-and-surfaces.md`, `.agents/context/architecture.md`, `.agents/commands/sync-mcp.md`.

## Verification rules

- Re-run `sync_mcp_configs.py` and `sync_mcp_configs.py --check` after any `.mcp.json` change; verify `.codex/config.toml`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.windsurf/mcp.json`, `.windsurf/mcp_config.json`, plus `.ompk/mcp.json` native override.
- Offline fallback verified: `docs_dev/`, `docs/`, `.agents/context/`, package `AGENTS.md`.
- Provider cache parity where applicable; never trade safety for cache hits.

## Non-goals

- Never hand-edit generated configs. Never invent endpoint contents on unreachable surfaces.
- Do not duplicate SSOT prose into surfaces; keep adapters as thin pointers.
