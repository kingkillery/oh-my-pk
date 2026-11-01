"""TokenEconomizer: experience-driven black-box cost control for coding agents.

The agent stays as it is (Claude Code, Codex, Copilot CLI, Pi). Three mechanisms read its
finished sessions and change what the next ones pay for:

  * `microskills` -- micro-skill synthesis and injection: short repository facts learned from
                     recurring failures, stated at the start of the next session;
  * `toolprune`   -- tool pruning: tool definitions a repository never uses, proposed for the
                     agent's deny list;
  * `loopguard`   -- failure-loop intervention: a turn stuck repeating the same failure is
                     redirected once, then stopped or flagged.

They share one trace reader (`trace`), one cost ledger (`ledger`, `pricing`) and one domain
interface (`domain.DomainAdapter`). `plugin` runs them inside real sessions through each agent's
hooks; the mechanisms never import it. Stdlib only.
"""
from .config import EconomizerConfig, InjectionConfig, SpiralConfig, ToolingConfig
from . import ledger, trace

__all__ = ["EconomizerConfig", "InjectionConfig", "ToolingConfig", "SpiralConfig", "ledger",
           "trace"]
