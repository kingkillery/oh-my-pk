# Reproducible contained pilot

This is an opt-in Linux/WSL pilot. It never changes normal OMPK settings. All
model work uses a new output directory and empty home; there is no automatic
resume or promotion. Run commands in a tool-owned PK-Herdr session launched
with `--session-auto-close-after 4h` and close that session after cleanup.

## Requirements and preparation

Use Linux storage, not `/mnt/c`, for the worker. Install Python 3.12, Bubblewrap,
Git, npm, coreutils and a working systemd **user** manager with cgroup v2.
Supply a reviewed native Linux OMPK executable. The manifest records its SHA-256;
this does not imply it was built from the adapter's commit.

Fetch the pinned upstream archive using a credential-free connection:

```sh
curl --fail --location --proto '=https' --tlsv1.2 \
  https://codeload.github.com/google-research/harness2/tar.gz/1cfe254e8d25b15f37048c3730134686abe60335 \
  -o /tmp/harness2-upstream.tar.gz
bash sandbox/prepare.sh /tmp/h2-example /absolute/python-root \
  /absolute/reviewed/omp /tmp/harness2-upstream.tar.gz
bash sandbox/offline.sh /absolute/python-root /tmp/h2-example/upstream
```

The installer verifies the archive digest, then builds upstream's pinned
OpenCode revision with its compatibility patch and Bun 1.3.11. The 15-minute
installer has network access but sees only system tools, public dependencies,
the explicit executable and its own empty home. Dependency install scripts are
disabled except Bun's explicit platform-binary installer. Failed directories
are retained; fix the cause and use a fresh path.

## One bounded live run

Make an **existing** OpenRouter credential available only to the host process
through `OPENROUTER_API_KEY` or an explicit `--credential-env` name. Do not put it
in a command, repository file, worker, transcript or output. A host-specific
credential-store launcher may set it in process memory before invoking run.py.
No API purchase or paid fallback is permitted.

```sh
OMPK_HARNESS2_ENABLED=1 python3.12 sandbox/run.py --execute \
  --job /tmp/h2-example --python /absolute/python-root \
  --run-id clean-001 --model minimax/minimax-m3.1-flash:free
```

The host gateway verifies the current model catalog's zero-price entry, rejects
other model names and admin routes, forces zero maximum token prices and
`allow_fallbacks=false`, and caps the entire run at 120 requests / 8 MiB input /
4,096 output tokens per request. Unknown, unavailable or non-free routes fail
closed. Only request/response hashes, sizes, status, timing and usage are logged.
Usage-reported cost and missing receipts must be distinguished.

The worker has no external network, host home, host drive mounts, credentials
or Docker socket. Source and runtime are read-only; only its output and fresh
home/tmp are writable. Kernel limits are mandatory: 2 GiB RAM, zero swap, two
CPU cores and 128 tasks. The 20-minute wall limit covers offline tests, baseline,
recursion, reflection and comparison. It cannot be extended or resumed by this
runner. A fresh `--run-id` is required for each attempt. Cleanup stops only the
named unit it created and removes its model socket, retaining evidence.

## What is tested

- Original strict grader and all three original task prompts, without output
  normalization. `solver_prompt_mode=classification` places the complete
  scenario and unchanged fixed safety text in OMPK's custom system prompt;
  a neutral user carrier avoids ordinary root-work classification.
- Actual upstream INV/DOM/AGG orchestration on one training task and k=1.
  Proposals still use OpenCode and the original tree validation rules.
- Reflection receives the complete upstream evidence packet in one bounded
  text-only model request. It has no file-editing tools, and upstream still
  parses and accepts the experience/NO_ENTRY response. Oversized evidence is
  rejected, never silently truncated. Grader scores/labels are not injected.
- Six baseline and six selected-prompt executions (two independent draws per
  task), paired by task/trial. Selection happens before these candidate scores.
  A tie is reported as **no demonstrated accuracy improvement**. Three tiny
  deterministic tasks cannot establish general agent-quality improvement.

Read `runs/<run-id>/output/result.json`, `gateway.json`, `runtime-manifest.json`
and `cleanup.json`. A submitted command or completed installer is not a live
pass. A pass requires the worker's zero exit, three non-fallback stages, valid
reflection, all six strict selected checks and confirmed cleanup. `NO_ENTRY`
is valid reflection completion but does not mean a library entry was created.

The adapter's default CLI mode remains `append`; classification is explicit:
`ompk-harness2 run ... --solver-prompt-mode=classification`. The CLI itself does
not provide containment; use this runner for live testing.
