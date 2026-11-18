---
workstream: simple-mode-config-verification
title: "Simple Mode config verification"
authority: canonical
revision: 1
updated: 2026-11-17T18:58:56.633Z
evidence_observed: 2026-11-17
source_sessions:
  - current
---

<handoff-prompt>

## Objective

Determine the live OMPK single-agent/Simple Mode configuration for C:/dev/infra/oh-my-pk, and enable then disable it per explicit user approval. No repo source code was changed at any point.

## Current State

Global config at C:/Users/prest/.ompk/agent/config.yml (task block ~lines 66-76) is back to its original pre-session values, verified by oh-my-pk config get and a direct file read: task.maxConcurrency: 8, task.batch: false, task.simpleMaxAgents: 0, task.simpleMode: false. Change sequence applied: simpleMode false -> true and simpleMaxAgents 0 -> 1 (user-approved pair), then simpleMode true -> false on user instruction "simple off", then simpleMaxAgents 1 -> 0 to restore the original value. Net effect: zero persistent change; no other key touched. No project-level .ompk/config.yml exists in the repo, so global values were always effective.

## Key Context

Canonical single-agent intent already exists: .agents/instructions.md:18-24 says when solo-first is requested, reuse Simple Mode (task.simpleMode, /simple) and do not build another single-agent mode, orchestrator, or supervisor; the primary agent keeps reasoning, planning, implementation, and accountability, loading specialized knowledge via skills/tools rather than child agents. Restated in .agents/rules/workflow-modes.md:9 and .agents/context/four-loop-architecture.md:10. Simple Mode semantics: docs/subagents.md:15-17 (off by default; one general-purpose subagent per task call on the current model; specialist/model routing and nested subagents disabled) and docs/subagents.md:19-44 (/simple status|on|N|0|off; task.simpleMaxAgents default 1, range 1-32). Concurrency: docs/subagents.md:47-83 and docs/tools/task.md:150-162; task.maxConcurrency is an orthogonal session semaphore and Simple adds its own simpleMaxAgents ceiling even when maxConcurrency=0. docs/fusion.md has no Simple/single-agent definition (Fusion is separate compaction-boundary model routing). Read-only scout EvolutionaryPanther (explore agent, history://EvolutionaryPanther) independently confirmed the same intent locations and found no definition of "Minimal Delivery" in .agents/, docs/, docs/tools/, or the ponytail/caveman skills (only the unrelated branch codex/pr45-minimal-reconciliation) - treat that term as undefined unless the user clarifies. Notebook storage rules: docs/settings.md:101-138 - continuity.store defaults to repo, record at .agents/continuity/notes/<workstream-id>.md with pointer .agents/continuity/workstreams.json; /notebook is an alias of /auto-handoffs and applies to new registrations only. Tooling note: early in the session shell execution was unavailable, so omp config get could not run and values were read directly from the global YAML file; later bash calls succeeded.

## Next Steps

none known - the requested configuration change was applied and then fully reverted at the user's instruction; investigation closed, no further work requested.

## Validation

oh-my-pk config get task.simpleMode -> false; oh-my-pk config get task.simpleMaxAgents -> 0. Direct read of C:/Users/prest/.ompk/agent/config.yml:60-80 confirms the task block matches original values and no other key changed. Document semantics and defaults for both keys confirmed against docs/subagents.md:15-83 and docs/tools/task.md:150-162. No project-level override file exists, so global values are effective. continuity register succeeded with canonical .agents/continuity/notes/simple-mode-config-verification.md and index .agents/continuity/workstreams.json.

## Blockers

none known

</handoff-prompt>
