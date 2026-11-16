# Memory — Durable Project Memory Index

External durable memory outside compaction history. One fact per entry; compaction summarizes, this directory preserves.

## Schema

Each entry carries: title, date (YYYY-MM-DD), scope (package or surface), fact (one paragraph max), verification (exact command), expiry (date or `permanent`). Reject entries with secrets, tokens, env dumps, or credentialed URLs.

## Promotion rules

- Promote only stable, cross-session facts with an observable contract and a verification command, per `.agents/context/memory-offload.md`.
- Gate every promotion with `check_memory_promotion.py`. Mnemopi (`retain` / `recall` / `reflect`) supplements these files; file content wins on conflict.
- Link to artifacts instead of embedding transcripts, raw logs, diffs, or webhook payloads.

## Current entries

- No entries yet. First entries should cover: canonical SSOT layout (`.agents/`), compaction triggers (50% / 75-80%), MCP canonical sync command, and `check:dist` release parity. Add with full repo-relative paths and verification commands.
