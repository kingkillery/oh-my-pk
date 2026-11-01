# @pk-nerdsaver-ai/pi-coding-agent

Core implementation package for the `omp` coding agent in the `oh-my-pi` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:
- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:
- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [Ethereal Workspaces](../../docs/ethereal-workspaces.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.ompk/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session is honoured on the next system-prompt rebuild and the next `/memory` slash command. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch.

## TokenEconomizer

[TokenEconomizer](https://github.com/microsoft/TokenEconomizer) ships vendored
under `vendor/tokeneconomizer/` and loads as an inline extension. It learns
repository facts (microskills), watches tool results for stuck loops
(loopguard), and folds session transcripts into a cost ledger on session end.

Requirements: **Python 3.10+** on `PATH`. No other install step.

Inside a session:

- `/te status` — what TokenEconomizer knows about this repo, cost so far
- `/te microskills` — list/update the learned manual
- `/te config set microskills=on` — enable a mechanism (per-repo or `--global`)

Disable entirely with `TE_DISABLE=1`. Override the Python interpreter with
`TE_PYTHON`; override the vendored core path with `TE_CORE_PATH`. `toolprune`
is not supported on this host (same as Pi).

## LFM harness adapters (local inference)

The [`harness-hub` LFM2.5-24B adapters](https://huggingface.co/collections/harness-hub/lfm25-24b-harness-adapters)
are LoRA weights for `LiquidAI/LFM2.5-24B-A2B`, trained against harness prompts
and tools. Serve one with vLLM (or llama.cpp for the GGUF variants), then
register it as an OpenAI-compatible provider:

```json
{
	"providers": {
		"vllm": {
			"baseUrl": "http://localhost:8000/v1",
			"api": "openai-completions",
			"apiKey": "dummy",
			"models": [{ "id": "lfm-harbor-pi" }]
		}
	}
}
```

`api: "openai-completions"` is required — the adapters were not trained or
evaluated against the Responses API. When the model id matches an LFM harness
adapter (`lfm-harbor-*`, `*A2B-pi`, `*A2B-claude-code`, …), model discovery
overrides a Responses-family or unset `api` to `openai-completions`
automatically, marks the model as reasoning-capable, and disables
unsupported compat fields (`supportsStore`, `supportsDeveloperRole`,
`supportsReasoningEffort`).
