# OMPK ↔ Harness² pilot (default off)

This package implements Google's published BenchmarkAdapter protocol using actual OMPK
non-interactive rollouts. It is deliberately a narrow vertical slice, not an automatic
production harness optimizer. The optimizer remains outside OMPK's runtime authority.

## Supported pilot scope

- Three fixed operational decision tasks: reuse, investigate, implement.
- Google Harness² Propose–Probe–Compose and experience library via run_domain.
- Candidate changes limited to systemprompt.md and tool_descriptions/tool_guidance.md.
- Guardrails and memory locked; no scripts, plugins, agents or skill execution.
- OMPK launches in an empty per-run workspace with --no-tools,
  --no-extensions, --no-irc, --no-skills, --no-rules, --agentmd-off,
  --no-session, a unique --profile, and explicit --model/--max-time.
- Each run stores a trajectory, answer and fingerprinted receipt. A matching
  completed run reuses evidence; a mismatched or partial run fails closed.
- The answer key only feeds score(), never proposer/task context.

## Setup (Linux/WSL, Python 3.12)

From python/harness2-ompk:

    uv venv --python 3.12 .venv
    source .venv/bin/activate
    uv pip install -e '.[upstream]'
    python -m unittest discover -s tests -v
    ompk-harness2 check

The upstream Harness² revision is pinned to
1cfe254e8d25b15f37048c3730134686abe60335.
An OMPK executable must be installed on the worker for live probes.

## Explicit opt-in live recursion

WARNING: Google's upstream proposer uses OpenCode/Claude tooling and permits
unrestricted network access by default. The OMPK solver in THIS adapter has
its tools disabled, but that does not sandbox the upstream proposer. Run live
optimization ONLY in an externally contained Linux/WSL worker with network
egress and filesystem access restricted. Do not run against production data,
credentials, or any directory containing secrets.

In that isolated worker, set the required model credentials and run:

    export OMPK_HARNESS2_ENABLED=1
    ompk-harness2 run --execute --unsafe-upstream-proposer-ack \
      --solver-model=provider/model --improver-model=provider/model \
      --output=runs/harness2-ompk

The explicit acknowledgment confirms that the upstream proposer is separately
contained; it is NOT a substitute for sandboxing. This single pilot uses
one training task and k=1 parallel recursion. It does not auto-promote a
harness, modify existing OMPK settings, or run on normal agent sessions.
Use the saved result to decide whether broader integration is warranted.

## Repeatable contained validation

For the opt-in classification compatibility mode, pinned runtime setup, offline
checks and a bounded **externally contained** live comparison, see
[sandbox/README.md](sandbox/README.md). The original CLI/default activation
boundaries remain unchanged; the sandbox runner does not promote its result.

## Known limits

- Prompt-only comparison: no OMPK tool executions, LSPs, agents, or sessions.
- Text-only answer extraction (no structured tool trace or OMPK provenance).
- Exact-match labels make this a wiring check, not an agent-quality benchmark.
- The bridge does not install or start the upstream proposer automatically.
- No unattended promotion; human review remains required.
