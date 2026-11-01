"""One cost definition for every mechanism.

The cost of a task (a session, in the plugin) is the agent's EXECUTION cost plus every
mechanism's LLM OVERHEAD, both on the cache-aware effective basis of `pricing.effective_tokens`:

    task_cost(t) = effective_exec(t) + overhead(t)
    amortized(T) = (1/T) * sum_{t<=T} task_cost(t)

`overhead()` sums the per-mechanism token fields a mechanism records. Every field is real LLM
spend made on the agent's behalf, so a mechanism that adds paid proposer, judge or redirect calls
pays for them in the same account as the work they are meant to save. The plugin's session
ledger (`plugin.accounting`) and the experiments' aggregation scripts both read this one
definition, so the recorded and the reported cost cannot drift apart.
"""
from . import pricing

# Per-task mechanism-overhead token fields, by owning mechanism. All are real
# mechanism-internal LLM cost that must be amortized into the honest task cost.
OVERHEAD_KEYS = (
    "optimizer_tokens",            # injection: paid between-task manual proposer (manual4)
    "untool_classify_tokens",      # untooling: one-shot tool-classifier LLM call
    "untool_judge_tokens",         # untooling: per-task instruction-aware tool judge
    "codex_untool_adapt_tokens",   # codex untooling: repository capability classifier
    "spiral_judge_tokens",         # spiral: paid live trace-judge
    "spiral_nudge_writer_tokens",  # spiral: targeted-nudge writer
)


def _num(x):
    return x if isinstance(x, (int, float)) else 0


def overhead(row):
    """Sum every mechanism-overhead token field present on a stream row."""
    return sum(_num(row.get(k)) for k in OVERHEAD_KEYS)


def effective_exec(row):
    """Cache-aware effective execution cost of a task (pricing.effective_tokens)."""
    return pricing.effective_tokens(row)


class CostLedger:
    """Accumulates the amortized cost over a stream. Thin wrapper over the two canonical
    functions above -- used by tests and any caller that wants a running total without
    re-deriving the math. The aggregation scripts share these definitions via
    OVERHEAD_KEYS / overhead()."""

    def __init__(self):
        self.cum_exec = 0.0
        self.cum_overhead = 0.0
        self.n = 0

    def add(self, row, exec_cost=None):
        """Fold one stream row. `exec_cost` overrides the effective exec (e.g. a
        breakdown-resolved record); defaults to this row's effective exec."""
        ec = effective_exec(row) if exec_cost is None else exec_cost
        oh = overhead(row)
        self.cum_exec += ec
        self.cum_overhead += oh
        self.n += 1
        return ec + oh

    @property
    def cum_total(self):
        return self.cum_exec + self.cum_overhead

    @property
    def amortized_per_task(self):
        return (self.cum_total / self.n) if self.n else 0.0

    @property
    def overhead_frac(self):
        return (self.cum_overhead / self.cum_total) if self.cum_total else 0.0
