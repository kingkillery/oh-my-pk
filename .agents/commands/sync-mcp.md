# sync-mcp — Canonical MCP Config Sync

Root `.mcp.json` is the canonical MCP registry; IDE surface configs are generated from it and never hand-edited.

1. Edit `.mcp.json` if server definitions change, then run canonical sync: `.agents/scripts/run_packman_python.cmd .agents/scripts/sync_mcp_configs.py`
2. Verify byte-for-byte parity with `.agents/scripts/run_packman_python.cmd .agents/scripts/sync_mcp_configs.py --check` across generated targets (`.codex/config.toml`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.windsurf/mcp.json`, `.windsurf/mcp_config.json`) while preserving `.ompk/mcp.json` (`enabled: false` native override for built-in `ompk-tools`).
3. Re-run sync after any server add/remove/rename before review.
4. Offline or corporate-VPN: fall back to `docs_dev/`, `docs/`, `.agents/context/`, local package patterns. Mark unreachable surfaces degraded; never invent endpoint contents.
5. Inspect logs with `tokf raw last` and scrub secrets before sharing.

See `.agents/context/mcp-and-surfaces.md` for the 11-surface matrix.
