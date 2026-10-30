"""`Stage`: the lifecycle hooks a mechanism offers around one task (a session, in the plugin).

Each mechanism implements only the hooks it needs; the rest keep the no-op default. A caller
-- the plugin's `fold`, or a benchmark harness -- runs them in this order:

    before_task(task, injected)  -> str        # before: may extend the injected prefix
    build_tools(task)            -> list|None  # at launch: the tools to exclude
    run_kwargs(task)             -> dict       # at launch: settings for the agent runner
    after_task(task, row, run_dir_path, srow)  # after: update state, record telemetry
                                 -> opt_tokens (LLM overhead; 0 for a free mechanism)

`srow` is the caller's record of the task, where a mechanism may attach its own telemetry.
"""


class Stage:
    name = "base"

    def before_task(self, task, injected):
        return injected

    def build_tools(self, task):
        return None

    def run_kwargs(self, task):
        return {}

    def after_task(self, task, row, run_dir_path, srow):
        return 0
