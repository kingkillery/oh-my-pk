# @pk-nerdsaver-ai/clips-extension

oh-my-pk client extension for **Clips** — agent-native screen recording (https://gopk.xyz/clip).

This package is just the in-CLI integration. The Clips **service** (the Cloudflare Worker, storage, accounts, transcription) lives in its own standalone repository and is not part of the monorepo.

## What it adds

- **`/record`** — opens the Clips recorder in your browser.
- **`/clip <url|id>`** — fetches a clip's agent-readable briefing (transcript + timestamped screenshot URLs) and injects it into the session so the agent can "see and hear" the recording.
- **`clip_context` tool** — lets the model pull a clip into context on its own.

## Configuration

- Host: `--clips-host` flag or `GOPK_CLIPS_URL` env (default `https://gopk.xyz`).
- Auth: `--clips-token` flag or `GOPK_CLIPS_TOKEN` env (your Clips account API key; required for a private host).
