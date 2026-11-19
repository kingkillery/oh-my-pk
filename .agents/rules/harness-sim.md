---
description: "Self-Improvement Memory (SIM): model/domain provenance, replay verification, and ledger updates for harness edits"
alwaysApply: false
globs:
  - "packages/coding-agent/src/prompts/**/*"
  - "packages/coding-agent/src/system-prompt.ts"
  - "packages/coding-agent/src/tools/approval.ts"
  - "packages/coding-agent/src/edit/**/*"
  - "packages/coding-agent/src/session/streaming-output.ts"
  - "packages/coding-agent/src/extensibility/hooks/**/*"
  - "packages/hashline/src/**/*"
  - "packages/ai/src/utils/*retry*.ts"
  - "packages/ai/src/utils/json-parse.ts"
  - "packages/catalog/src/compat/**/*"
  - "packages/catalog/src/provider-models/**/*"
  - ".agents/hooks/**/*"
  - ".omp/sim.json"
---

# Harness Self-Improvement Memory (SIM) Rules

Before modifying `oh-my-pk` prompts, hooks, parsers, retry policies, truncation bounds, or `pi-catalog` model compat fixups, read the complete `.omp/sim.json` ledger (injected verbatim into the system prompt in `oh-my-pk` sessions; read directly in external agents).

## Decision Rules (arXiv:2611.18856 Appendix D.2)

1. **Treat entries as prior experience, not rigid law.** Keep flexibility to choose a different edit when evidence warrants it.
2. **Check `model` and `domain` provenance before touching inherited guardrails.** Never blindly revert or tighten a safeguard without reading why it was introduced and which model/workflow triggered it.
3. **Start with an existing diagnosis** when an entry's `name` already explains the current failure; reuse its problem ID (following `aliases` if merged).
4. **Reuse transferable rationale; recalibrate setting-dependent heuristics.**
   - *Typically transfers directly (Table 8):* core tool/process execution layers, approval/interlock state accounting, central interception points, prompt-injection pipeline, truncation/checkpoint scaffolding.
   - *Requires recalibration across model/workflow shifts (Table 8):* parser repairs tuned to one model's output format, intervention/retry thresholds, timeout knobs, completion predicates, and provider-specific output schemas.
5. **Revise, replace, or override when new evidence warrants it.** Keep all earlier attempts intact in `.omp/sim.json` even when an edit is later changed or replaced.
6. **Revisit a previously tested direction only with new evidence** (different model, new failure trace, or changed domain contract).
7. **Open a new problem entry** when no existing root-cause hypothesis explains the failure.
8. **Weight task-specific evidence by setting similarity:** higher weight when model and domain match; lower weight when both changed.

## Required Verification & Ledger Update Workflow

1. **Predict before testing:** choose the replay case IDs in `scripts/sim/replay.ts` expected to be fixed (or add a new deterministic replay case for a new failure class).
2. **Run the fast replay harness:**
   ```bash
   bun run sim:replay --json
   ```
3. **Record observed evidence in `.omp/sim.json`** (log `predicted`, `fixed`, `missed`, `passed`, `total` even when an accepted edit misses a target):
   ```bash
   bun scripts/sim/cli.ts record \
     --problem <P#|new> \
     --name "<root-cause hypothesis>" \
     --what "<concise change and rationale>" \
     --files "<comma-separated repo-relative paths>" \
     --model "<target model or family>" \
     --domain "<domain e.g. coding-agent|pi-catalog|parsers|hooks>" \
     --predicted "<comma-separated replay case ids>" \
     --accepted true \
     --replay
   ```
4. **Validate ledger integrity:**
   ```bash
   bun run sim:validate
   ```
