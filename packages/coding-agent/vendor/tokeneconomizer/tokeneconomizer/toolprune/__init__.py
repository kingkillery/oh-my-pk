"""Tool pruning: stop paying, on every request, for tool definitions a repository never uses.

  * `stage` -- `ToolingStage`: tracks which loaded tools go unused, session after session, and
               proposes dropping a tool once it has gone unused for `evidence` sessions (never a
               protected tool, never one ever used);
  * `codex` -- `CodexUntoolProfile`: the same idea for Codex, whose unit is a capability
               package switched off in its config rather than a single tool;
  * `tools` -- the protected work surface, the inapplicable-by-construction set, and the
               optional per-task tool judge.

Stdlib only; never imports the plugin runtime.
"""
from .codex import CodexUntoolProfile
from .stage import ToolingStage
from .tools import INAPPLICABLE_TOOLS, PROTECTED_TOOLS, judge_tools_for_task

__all__ = ["CodexUntoolProfile", "ToolingStage", "INAPPLICABLE_TOOLS", "PROTECTED_TOOLS",
           "judge_tools_for_task"]
