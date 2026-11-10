# Subagents and parallel work

The `task` tool delegates independent work to subagents. It can run several workers at once, collect their results, and optionally isolate editing workers in separate workspaces. See the [task tool reference](./tools/task.md) for the complete schema and lifecycle details.

## Choose how agents run

- **Standard mode** keeps the full agent choices and routing available, including specialist agent types, model selection, and nested delegation when policy allows.
- **Batch tasks** are enabled by default. A single `task` call can launch one worker for each item in `tasks[]`, with a shared `context`. Turn `task.batch` off to use the older one-assignment-per-call shape.
- **Background tasks** are controlled by `async.enabled`. When enabled and a background job manager is available, eligible task calls can return while workers run, with results delivered later. Calls still wait when it is disabled, for blocking agents, or when the lifecycle/native execution path requires foreground work.
- **Isolated work** uses the `isolated` option together with `task.isolation.mode`. An isolated worker uses a separate workspace; the task system captures its changes and attempts to integrate them into the parent workspace. Check the result for merge failures and review the integrated changes.
- **Model and capability controls are separate.** A task's `difficulty` (`low`, `medium`, or `high`) selects the `smol`, `task`, or `slow` model role; an explicit `model` takes precedence. `/tier light|mid|frontier|auto` controls the execution profile/capabilities of newly spawned agents, not the number of workers. See [Settings: Agent Model Profiles and Difficulty Routing](./settings.md#agent-model-profiles-and-difficulty-routing).

## Simple mode

Simple mode favors working directly and permits one general-purpose subagent per task call, using the current model. It disables specialist/model routing and nested subagents; it does not change the normal task concurrency setting. Simple mode is off by default.

In an interactive session, use:

```text
/simple status   # show the current mode and, when on, its worker limit
/simple on       # enable it using the configured limit
/simple 4        # enable it and allow up to four general workers at once, subject to other limits
/simple 0        # keep it on but disable new subagent launches
/simple off      # restore standard agent routing
```

The numeric form accepts any whole number from `0` through `32`. Zero prevents new launches; already-running workers are allowed to finish. `/simple on` uses the current `task.simpleMaxAgents` value (default `1`).

The slash commands save the changed settings globally. If a project or command-line overlay has higher precedence, the command also applies a session override; the overlay can take precedence again in a new session. Simple mode cannot enable a `task` tool excluded at session launch: allow the tool and start a new session if `/simple` reports that it is unavailable.

To set the global defaults from a shell, use:

```sh
oh-my-pk config set task.simpleMode true
oh-my-pk config set task.simpleMaxAgents 4
```

Set `task.simpleMode` to `false` to restore standard mode. `task.simpleMaxAgents` is a simple-mode-only cap; it does not change the full-mode concurrency limit described below.

## Set the number of concurrent launch lanes

Here, a **lane** means one subagent run active at a time through the `task` tool. Set `task.maxConcurrency` to control the maximum number of concurrent workers across parallel task calls in a session. The default is `32`.

```sh
# Allow at most eight task subagents to run at once
oh-my-pk config set task.maxConcurrency 8

# Raise the default ceiling from 32 to 64 concurrent task launches
oh-my-pk config set task.maxConcurrency 64

# Serialize task subagents: only one active task at a time
oh-my-pk config set task.maxConcurrency 1

# Remove the task semaphore's concurrency ceiling
oh-my-pk config set task.maxConcurrency 0

# Check the effective value in the current directory
oh-my-pk config get task.maxConcurrency
```

Use a positive whole number for the maximum number that can run simultaneously; additional batch items or parallel task calls wait for an available slot. `0` removes this task semaphore's ceiling, rather than disabling workers. Fractional values are truncated, so do not use them: values between `0` and `1` remove the ceiling. This controls concurrency, not the number of tasks the model may propose or the number of worker types available. Lower values conserve resources; higher values can improve throughput when the tasks are independent, but use more provider, memory, and CPU capacity.

`task.maxConcurrency` is shared across a session's synchronous and background task execution, not across all sessions on the machine. Each session has its own task limit. Its semaphore is created on the first task spawn, so if you change this setting after a task has already launched, start a new session for the new ceiling to take effect.

Simple mode has an additional ceiling: `task.simpleMaxAgents` (default `1`, maximum `32`). For example, `task.maxConcurrency: 8` with `task.simpleMaxAgents: 2` still allows only two simple-mode workers at once; `/simple 4` cannot exceed a positive `task.maxConcurrency` limit. If `task.maxConcurrency` is `0`, the Simple-mode ceiling still applies.

Other limits can still apply when `task.maxConcurrency` is `0`, including Simple mode and provider limits. The optional lifecycle launch authority also imposes its own admission limits; when it creates a root authority with `task.maxConcurrency: 0`, it uses `32` for its child limit.

For a project-specific limit, add this to that repository's `.ompk/config.yml`:

```yaml
task:
  maxConcurrency: 8
```

`config set` and the `/settings` panel under **Tasks** → **Subagents** write the global configuration. Project settings and `--config` overlays take precedence, so a project override can make the effective value differ from the one just written globally. Run `config get` from the project directory to check it. See [Settings](./settings.md) for precedence and config-file locations.

## Related references

- [Task tool](./tools/task.md) — parameters, batch calls, background execution, isolation, and output.
- [Settings](./settings.md) — task configuration, model profiles, and agent execution tiers.
- [Task agent discovery](./task-agent-discovery.md) — where custom and bundled agent definitions come from.
