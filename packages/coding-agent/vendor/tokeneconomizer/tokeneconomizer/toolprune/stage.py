"""`ToolingStage`: tool pruning's lifecycle hook -- learn which loaded tools go unused, and propose
dropping them.

An agent's tool definitions are re-sent, and billed, on every request, whether or not a
repository's work ever calls them. Two paths, chosen by agent:

  * Evidence pruning (Claude Code, Copilot) -- `ToolingConfig.evidence`: a tool is proposed once
    it has been LOADED BUT UNUSED for `evidence` consecutive sessions; a protected work-surface
    tool, or one ever seen in use, never is. With `judge=True` a per-task LLM judge may also
    drop tools the task text makes irrelevant, its cost charged to the ledger.
  * Capability pruning (Codex) -- `ToolingConfig.codex_untool`: whole capability PACKAGES leave
    Codex's request through the evidence-gated controller in `codex.CodexUntoolProfile`. The
    stage computes the mask; mapping it onto Codex's configuration is the caller's job.

The evidence (`used_tools`, `tool_unused_streaks`, the catalog) accrues every session even when
pruning is off, so switching it on later starts from what was already seen.
"""
import os

from ..stage import Stage
from . import codex as cu
from .tools import judge_tools_for_task

_CODEX_AGENTS = ("codex",)


class ToolingStage(Stage):
    name = "tooling"

    def __init__(self, cfg, agent, optimizer_model,
                 untool_runner=None, judge_tool_runner=None, adapter=None,
                 repo=None, results_root=None, fresh=False):
        self.cfg = cfg
        self.agent = agent
        self.optimizer_model = optimizer_model
        self.judge_tool_runner = judge_tool_runner
        self.adapter = adapter

        # ---- shared pruning state (owned here, mutated across tasks) ----
        self.used_tools = set()          # tools observed in use across the stream so far
        self.tool_unused_streaks = {}    # {tool: consecutive tasks unused while loaded}
        self.catalog_tools = set()       # every tool ever seen in the full catalog
        self._warned_no_catalog = False   # one loud warning per stream, not per task
        self.catalog_desc = {}           # {tool: description} for the per-task judge

        # ---- Codex-native capability controller ----
        self.codex_profile = None
        self._codex_selection = None
        if cfg.codex_untool and agent in _CODEX_AGENTS:
            if not repo or not results_root:
                raise ValueError("Codex capability pruning requires repo and results_root")
            self.codex_profile = cu.CodexUntoolProfile(repo, results_root, fresh=fresh)

        # ---- generic per-task instruction-aware judge: redacted-issue lookup ----
        self.problem_by_iid = {}
        if cfg.judge and adapter is not None:
            try:
                self.problem_by_iid = adapter.problem_statements()
            except Exception as e:
                print(f"[untool-judge] could not load problem statements ({e}); "
                      f"judge disabled")
                self.problem_by_iid = {}

        # per-task locals stashed by build_tools for after_task
        self._ev_reaudit = False
        self._exclude_tools = None
        self._task_judge_tokens = 0
        self._task_judge_dropped = []

    # -- construction: this task's tool-exclusion set / codex capability mask --
    def build_tools(self, task, i):
        iid = task["instance_id"]
        cfg = self.cfg
        self._task_judge_tokens = 0
        self._task_judge_dropped = []
        self._ev_reaudit = False

        # Codex path: freeze the capability mask; the runner maps it to prune-items.
        if self.codex_profile is not None:
            self._codex_selection = self.codex_profile.begin_task(
                iid, problem_statement=task.get("problem_statement", ""))
            self._exclude_tools = list(
                self._codex_selection.get("relay_capabilities") or ())
            return list(self._exclude_tools)

        # Generic evidence path (Claude / Copilot).
        if cfg.evidence:
            ev_reaudit = (cfg.evidence_reaudit > 0 and i > 0
                          and i % cfg.evidence_reaudit == 0)
            self._ev_reaudit = ev_reaudit
            if ev_reaudit:
                exclude_tools = []
            else:
                protected = self.adapter.protected_tools() if self.adapter else frozenset()
                trace_excluded = [
                    t for t in self.catalog_tools
                    if t not in protected and t not in self.used_tools
                    and self.tool_unused_streaks.get(t, 0) >= cfg.evidence]
                if cfg.judge and self.catalog_tools and self.problem_by_iid.get(iid):
                    cand = {t: self.catalog_desc.get(t, "") for t in self.catalog_tools
                            if t not in protected and t not in self.used_tools
                            and t not in trace_excluded}
                    if cand:
                        loadmap, self._task_judge_tokens = judge_tools_for_task(
                            self.problem_by_iid[iid], cand, self.judge_tool_runner,
                            model=self.optimizer_model)
                        self._task_judge_dropped = [t for t, load in loadmap.items()
                                                    if not load and t in cand]
                exclude_tools = sorted(set(trace_excluded) | set(self._task_judge_dropped))
            self._exclude_tools = exclude_tools
            return exclude_tools

        self._exclude_tools = None
        return None

    def run_kwargs(self, task):
        """Hand the runner the frozen mask's CONFIG half (evidence pruning needs none).

        The relay half already crosses the seam as `build_tools`' return value, but the two
        are not interchangeable and the config half cannot be recovered from it: the
        `collaboration` package expands to NO relay id (see `codex_untool._RELAY_CAPABILITIES`),
        so a runner reading only `exclude_tools` would prune it from nothing while the row
        reported it pruned -- an overstated saving on the arm whose whole claim is the
        saving. Passing the logical capability names keeps Layer 1 free of any Codex
        config knowledge: which toggles remove a package is the runner's business, because
        the runner is what owns the request contract.
        """
        if self.codex_profile is None:
            return {}
        selection = self._codex_selection or {}
        return {"codex_config_capabilities": list(
            selection.get("config_capabilities") or ())}

    # -- post-rollout: accrue usage + mechanism bookkeeping --
    def after_task(self, task, row, run_dir_path, srow):
        cfg = self.cfg
        transcript = os.path.join(run_dir_path, "transcript.jsonl")
        task_used = (set(self.adapter.tool_usage(transcript).keys())
                     if self.adapter else set())
        self.used_tools.update(task_used)

        # ---- Codex capability pruning ----
        if self.codex_profile is not None:
            selection = self._codex_selection or {}
            usage = cu.inspect_usage(transcript)
            record = self.codex_profile.observe(usage, resolved=srow.get("resolved"))
            srow["codex_untool_active"] = True
            srow["codex_untool_profile"] = cu.PROFILE_VERSION
            srow["codex_untool_reason"] = selection.get("reason")
            srow["codex_untool_config_capabilities"] = list(
                selection.get("config_capabilities") or ())
            srow["codex_untool_relay_capabilities"] = list(
                selection.get("relay_capabilities") or ())
            srow["codex_untool_core_capabilities"] = list(
                selection.get("core_capabilities") or ())
            srow["codex_untool_newly_pruned"] = record["newly_pruned"]
            srow["codex_untool_mask_after"] = record["mask_after"]
            srow["codex_untool_usage_attempted"] = record["attempted"]
            srow["codex_untool_usage_completed"] = record["completed"]
            srow["codex_untool_adapt_tokens"] = 0
            return 0

        # ---- evidence pruning bookkeeping ----
        if cfg.evidence:
            srow["untooled_excluded"] = row.get("untooled_excluded", [])
            srow["untool_evidence_excluded"] = list(self._exclude_tools or [])
            srow["untool_evidence_reaudit"] = bool(self._ev_reaudit)
            if not self._exclude_tools and self.adapter is not None:
                # Source-aware where the adapter supports it: an empty catalog is
                # indistinguishable from "this agent loaded no tools", which would leave
                # pruning a no-op unnoticed (trace.catalog_sources). Record which source won
                # so a change of log format shows up in the rows, and say so out loud the
                # first time nothing parses.
                getter = getattr(self.adapter, "parse_catalog_with_source", None)
                if getter is not None:
                    cat, src = getter(run_dir_path, self.agent)
                else:
                    cat, src = self.adapter.parse_catalog(run_dir_path, self.agent), "unknown"
                srow["untool_catalog_source"] = src
                if cat:
                    self.catalog_tools.update(cat.keys())
                    self.catalog_desc.update(cat)
                elif not self.catalog_tools and not self._warned_no_catalog:
                    self._warned_no_catalog = True
                    print(f"[tooling] !! no tool catalog parsed for agent={self.agent} "
                          f"from {run_dir_path} -- evidence pruning can drop NOTHING and "
                          f"this arm will behave as its baseline. Likely an agent-CLI "
                          f"upgrade that moved the catalog; see trace.catalog_sources.",
                          flush=True)
            for t in self.catalog_tools:
                if t in task_used:
                    self.tool_unused_streaks[t] = 0
                else:
                    self.tool_unused_streaks[t] = self.tool_unused_streaks.get(t, 0) + 1
            srow["untool_catalog_size"] = len(self.catalog_tools)
            if cfg.judge:
                srow["untool_judge_tokens"] = self._task_judge_tokens or 0
                srow["untool_judge_dropped"] = list(self._task_judge_dropped or [])
        return 0
