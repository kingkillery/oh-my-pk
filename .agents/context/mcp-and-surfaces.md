# MCP and Surfaces — 11-Surface Matrix and Sync Protocol

Root `.mcp.json` is the canonical MCP source of truth; IDE surface configs are deterministically generated from it via `sync_mcp_configs.py` and never hand-edited.

## 11-surface agent matrix

| Surface | Entry | SSOT pointer | Notes |
|---|---|---|---|
| Pi | native runtime | `.agents/instructions.md` | Primary harness via `packages/coding-agent` |
| OMP / oh-my-pk | `.ompk/` | `.agents/` | Native override wins at 100; `.ompk/AGENTS.md` stays absent |
| Claude Code | root `CLAUDE.md` | `.agents/instructions.md` | `.claude/CLAUDE.md` stays absent (claude 80) |
| Cursor | `.cursor/rules/*.mdc` | `.agents/instructions.md` | Thin `.mdc` wrapper (`globs: ["**/*"]`) + `.cursor/hooks.json` (`loop_limit: 1`) |
| GitHub Copilot | `.github/copilot-instructions.md` | `.agents/instructions.md` | Loses to `agents` 70 in OMPK discovery |
| Windsurf | `.windsurf/rules/*.md` | `.agents/instructions.md` | Manual rules, strictly <6,000 chars inline |
| Cline | `.clinerules` | `.agents/instructions.md` | Single-file rules |
| Gemini CLI | `.gemini/GEMINI.md` | `../.agents/instructions.md` | Thin pointer |
| Google Antigravity | native | `.agents/context/` | Reads SSOT directly |
| OpenAI Codex | `.codex/` | `.agents/instructions.md` | Tie at 70 with `agents`; discovery order decides |
| Aider | repo files | `.agents/context/` | Offline fallback, no MCP endpoint required |

All surfaces converge on one SSOT; adapters are thin pointers, never second copies of rules.

## Canonical sync targets

Run: `.agents/scripts/run_packman_python.cmd .agents/scripts/sync_mcp_configs.py`

Canonical source & generated targets:

- `.mcp.json` — canonical workspace MCP source of truth (edit here, then run sync)
- `.codex/config.toml` — generated Codex TOML target (do not hand-edit)
- `.cursor/mcp.json` — generated Cursor MCP target (do not hand-edit)
- `.vscode/mcp.json` — generated VS Code MCP target (do not hand-edit)
- `.windsurf/mcp.json` & `.windsurf/mcp_config.json` — generated Windsurf MCP targets (do not hand-edit)
- `.ompk/mcp.json` — intentional priority-100 native OMPK override (`ompk-tools` set to `enabled: false` because OMPK already provides `read`, `grep`, `glob`, `ast_grep`, and `lsp` natively without spawning a duplicate stdio subprocess)
Re-run sync after any server add/remove/rename. Verify with the `sync-mcp` command.

## Offline / corporate-VPN fallback

When external MCP endpoints are unreachable, never block on network:

1. Read `docs_dev/README.md` (developer index) for the local map.
2. Use `docs/` (fork boundaries, collaboration, fusion, settings, models) as the authoritative local reference.
3. Use `.agents/context/` for architecture, compaction, MCP, and memory-offload rules.
4. Use package `AGENTS.md` files (`packages/coding-agent/AGENTS.md`, `packages/catalog/AGENTS.md`, `python/robomp/AGENTS.md`) for local patterns.
5. Filter logs with `tokf raw last` and scrub secrets before pasting. Do not invent endpoint contents; mark unreachable surfaces as degraded and continue locally.
