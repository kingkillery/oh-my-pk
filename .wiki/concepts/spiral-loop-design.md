---
type: Design
title: Spiral /loop design
description: A loop.mode "spiral" that runs a verifier/synthesis step between iterations so synthesized context compounds until a plan completes.
tags: [loop, agent, verifier, synthesis, reflexion, self-refine, oh-my-pk]
timestamp: 2026-06-20T00:00:00Z
status: implemented
---

# Status

Shipped. `loop.mode: "spiral"` is implemented:
- Synthesis module: `packages/coding-agent/src/modes/loop-synthesis.ts` (`runLoopSynthesis`, `composeSpiralPrompt`).
- Runtime wiring: `#runLoopSpiralIteration` in `packages/coding-agent/src/modes/interactive-mode.ts` (objective immutable, reflection appended, complete-verdict + no-progress-delta stops, synthesis-failure degrades to plain re-submit).
- Prompts: `packages/coding-agent/src/prompts/loop/loop-synthesis-{system,user}.md`.
- Enum: `loop.mode` in `packages/coding-agent/src/config/settings-schema.ts`.
- Tests: `packages/coding-agent/test/interactive-mode-loop-spiral.test.ts`.

Reused the existing `loopLimit` for the iteration safety bound rather than a new `maxIterations`. Forced compaction between iterations was deliberately left out of this slice (the `compact` mode remains separate); spiral focuses on the synthesis + reflection injection.

# Problem

The existing `/loop` runtime re-submits a prompt each iteration with no feedback
between runs. Modes are `prompt | compact | reset` (all manual context handling).
A re-prompt-without-feedback loop is [Self-Refine](/references/self-refine.md)
*minus* the feedback step — the paper's ablations show feedback is where the gains
come from. We want a mode where each iteration learns from the last and the loop
terminates on a real completion signal, not a fixed count.

# Decision

Add `loop.mode: "spiral"`. Between iterations, run a **verifier + synthesis** step
(a `task` subagent) that grades the last turn against explicit criteria and emits a
reflection, which is fed additively into the next iteration. This is
[Self-Refine](/references/self-refine.md)'s refine cycle carrying
[Reflexion](/references/reflexion.md)'s episodic memory.

```
loopPrompt (original objective — IMMUTABLE)

iteration N:
  1. run iteration            (existing #runLoopIteration)
  2. VERIFIER subagent grades the turn against a rubric (never saw the generation)
  3. SYNTHESIS reflection = { progress, remaining, lessons, nextFocus, complete }
  4. COMPACTION: /compact between iterations, preserving the reflection block
  5. nextPrompt = loopPrompt + reflection[N]      (reflection is ADDITIVE)
  6. STOP if verifier.complete  OR  maxIterations  OR  no-progress-delta
```

# The three decisions that matter most

1. **The verifier must not have seen the generation.** Spawn it as a `task`
   subagent with an isolated context window so it cannot grade its own work — the
   adversarial-independence property from [Reflexion](/references/reflexion.md) and
   the [Claude Code subagent model](/references/claude-code-subagents.md) (parent
   receives only a summary; full transcript stays local).
2. **The original objective is immutable.** Each iteration prepends `loopPrompt`
   unchanged; the reflection is additive. This prevents goal drift — the agent
   cannot redefine "done" away from what the user asked.
3. **The stop condition is not a fixed count.** Primary signal is the verifier's
   completeness verdict; `maxIterations` (default ~5) is only a safety bound; a
   no-progress-delta check (reflection unchanged for 2 consecutive iterations)
   breaks stuck loops. Reflexion's memory only helps if the loop can terminate.

# Why this shape over alternatives

* vs. plain `prompt` mode — adds the [Reflexion](/references/reflexion.md) memory
  that compounds; plain re-prompt lacks the feedback step.
* vs. `compact` mode — compaction alone discards; spiral treats compaction as a
  *carrier* for the reflection, not the endpoint.
* vs. [Tree-of-Thoughts](/references/tree-of-thoughts.md) branching — ToT's value
  is search over uncertain reasoning paths; this loop is sequential refinement
  toward a fixed plan, so branching is overkill. See the
  [pattern survey](/concepts/agent-loop-patterns.md) for mode selection.

# Implementation map

Runtime lives in `packages/coding-agent/src/modes/interactive-mode.ts`.

| step | mechanism / existing hook |
|------|---------------------------|
| iteration run | `#runLoopIteration(action, prompt)` (~line 1085) |
| verifier | `task` tool subagent, read-only, rubric prompt, isolated context |
| synthesis | same subagent returns `{ verdict, reflection }` in one round-trip |
| injection | reflection as a `synthetic` developer prompt (see `SubmittedUserInput.synthetic`, `main.ts:268-306`) |
| prompt assembly | prepend immutable `loopPrompt` (`interactive-mode.ts:396-397`); never replace it |
| compaction | run `/compact` between iterations with a compact-prompt that preserves the reflection block |
| mode enum | add `"spiral"` to `loop.mode` in `config/settings-schema.ts:1255-1278` |
| stop | verifier `complete` flag + `loop.maxIterations` (default 5) + no-progress-delta |

# Smallest valuable first slice

1. Add the `"spiral"` enum value to `loop.mode`.
2. After each iteration, spawn one `task` subagent with a verifier+synthesizer
   prompt + the iteration transcript + the original objective + a rubric; collect
   `{ complete, progress, remaining, lessons, nextFocus }`.
3. Inject the reflection as a synthetic developer prompt; prepend the unchanged objective.
4. Add `loop.maxIterations` and no-progress-delta termination.

Branching/search (ToT) and parallel tournament subagents are later extensions, only
if single-thread refinement demonstrably stalls.

# Anti-patterns

* Re-prompting without feedback — Self-Refine minus the feedback step.
* Compaction that discards the reflection — loses the only thing that compounds.
* Fixed iteration count as the only stop signal — wastes turns or stops early.
* Verifier sharing context with the generator — grades its own work.
* Letting the agent mutate the original objective across iterations — goal drift.

# Citations

[1] [Self-Refine: Iterative Refinement with Self-Feedback](https://arxiv.org/abs/2303.17651)
[2] [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366)
[3] [Tree of Thoughts: Deliberate Problem Solving with LLMs](https://arxiv.org/abs/2305.10601)
[4] [Claude Code — Create custom subagents](https://code.claude.com/docs/en/sub-agents)
