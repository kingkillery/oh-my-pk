# Tool pruning

How tool pruning (see the [main README](../../README.md)) decides what to drop, per agent.

- **Evidence pruning** (Claude Code, Copilot CLI; `stage.ToolingStage`). After each session, a
  loaded tool's unused streak grows or resets. In the experiments a tool is proposed once its
  streak reaches `evidence` sessions. The plugin asks for more (`plugin/fold.py`): unused over
  `toolprune_evidence` prompts across at least `toolprune_min_sessions` sessions, or over
  `toolprune_sessions` sessions, and three times as long for `NotebookEdit`. A protected
  work-surface tool (`tools.PROTECTED_TOOLS`) or one ever seen in use is never proposed. In the
  experiments only, a per-task judge (`tools.judge_tools_for_task`) can also drop tools the
  task text makes irrelevant, its cost charged to the ledger; the plugin has no task text and
  never calls a model to prune.
- **Capability pruning** (Codex; `codex.CodexUntoolProfile`). Codex's unit is a capability
  package (collaboration, goals, image/media, ...) switched off in its config. A package is
  demoted only after enough loaded-but-unused sessions, at most two per session, and a single
  use protects it for good. The plugin proposes a demoted package only once it also meets the
  prompt-and-session evidence above (three times as long for image/media).

This package decides *what* to drop. Writing the decision into an agent's own settings file is
the plugin's job (`tokeneconomizer/plugin/denylist.py`): by itself under `toolprune=auto` (the
default), once the repository's sessions have been idle `toolprune_quiet_minutes`, or on
`toolprune apply` under `propose`; either way it takes effect from the next session.

| Module | |
|---|---|
| `stage.py` | `ToolingStage`: evidence across sessions, the proposal, the Codex mask |
| `codex.py` | `CodexUntoolProfile`: Codex's evidence-gated capability controller |
| `tools.py` | the protected and inapplicable tool sets; the experiments' per-task tool judge |
