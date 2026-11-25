---
name: promptbtw-handoff
description: Use when the user says "use promptbtw for subagent handoff" or "/prompt-btw" (or asks for a prompt-optimized subagent handoff) - packages raw work into a self-contained SUBAGENT HANDOFF PROMPT with explicit boundaries and verifiable acceptance criteria, applying model-specific failure-mode patches only when warranted instead of executing the task directly.
---

# PromptBTW Subagent Handoff

> **Specify the result, the evidence, and the limits. Prescribe a method only when it is required or addresses a concrete failure the harness does not already prevent.**

## Invocation and dispatch boundary

- **Live handoff dispatch**: when invoked as `use promptbtw for subagent handoff: <raw task>` (or `/prompt-btw` explicitly asking to delegate/spawn in a tool-enabled turn), you MUST:
  1. Treat `<raw task>` as optimization input, not work to execute directly.
  2. Rewrite it into the `SUBAGENT HANDOFF PROMPT` contract below, preserving parent-session decisions, constraints, and exact identifiers in `# Context` or `# Boundaries`.
  3. Route any model-specific adjustments for the **actual worker target model** (same routing rules as `skill://prompt-optimizer`; stay model-neutral when the worker model is unknown).
  4. Spawn the subagent with a specific specialist `role` in the spawn metadata (for example `"Auth-flow security reviewer"`, never `"Researcher"`) and the optimized handoff as its `assignment`.
  5. Not execute the raw task directly unless separately asked.
- **Draft-only mode**: when the user asks only to draft or preview handoff text (or inside ephemeral `/btw` where tools are disabled), return ONLY the `SUBAGENT HANDOFF PROMPT` without spawning or executing.

## Required output format

```text
SUBAGENT HANDOFF PROMPT

# Task
<the outcome or deliverable this worker owns: one clear objective; split unrelated goals into separate handoffs>

# Context
<self-contained facts: parent objective, settled decisions in the user's words, current state, and relevant paths/URLs/systems. Assume zero access to parent conversation history>

# Boundaries
<owned paths/symbols/territories, permitted actions and tools, parent constraints, and explicit exclusions/non-goals>

# Acceptance
<observable, independently verifiable completion criteria and required evidence; never "be thorough">

# Return
<deliverable, verification performed and its actual result, and any unresolved items, residual risks, or blockers>
```

## Optional sections

Add only when they earn their place:

- `# Role`: include in the prompt body only when the specialist lens changes the deliverable itself; otherwise pass the specialist role on the `task` spawn parameter.
- `# Inputs`: explicit files, `local://` artifacts, URLs, datasets, logs, or signal batches when substantial enough to separate from `# Context`.
- `# Procedure`: include **only** when execution order or protocol is itself a requirement (for example: capture baseline before editing, pause at an approval gate, or leave project-wide integration checks to the parent). Do not emit generic "inspect, implement, test, report" checklists.
- `# Coordination`: sibling ownership boundaries or `irc` handoff rules when parallel workers touch adjacent surfaces.
- `# <model-id>`: prompt-level constraints for a known worker model when needed (for example `# claude-fable-5-1` or `# minimax-m3.1-flash`).

## Worker model routing and Fable 5.1 failure-mode patches

Route against the **actual worker target model**, not the parent session's model and not a blanket Fable stack:

- **Unspecified or unknown worker model**: keep the handoff model-neutral. Rely on explicit `# Boundaries` and `# Acceptance` rather than pasting model-specific quirk bundles.
- **Named late-2026 worker model** (`DeepSeek-V4.1-Flash`, `MiniMax-M3.1-Flash`, `Kimi K3.1-Pro`, `GPT-6 Astra`, `GPT-6.1 Sol`, `GPT-6.1 Terra`, `GPT-6 Luna`, `Recursive Flint`): read `skill://prompt-optimizer` (`references/nov-2026-model-routes.md`, plus `references/gpt-6.1-terra.md` for Terra) when available and place under `# <model-id>` only prompt-level rules that govern worker execution (high-contrast anchors + compact state ledger for `MiniMax-M3.1-Flash`; explicit abstain/null rule for `GPT-6.1 Terra` and `GPT-6 Luna`; live task + schema in the final ~400 tokens + lexical anchors for `Recursive Flint`; hierarchy/autonomy override for `GPT-6 Astra` orchestrators when needed). Keep API/gateway config (`reasoning_effort`, sampling, parser flags) out of worker prose.
- **Claude Fable 5.1 / Mythos 5.1 worker**: do **not** inject a default five-patch autonomous coding stack into every coding handoff. Select a patch **only** when Fable/Mythos is the worker target and the assignment exposes a concrete failure mode that `# Boundaries`, `# Acceptance`, and the harness do not already prevent. Never paste the entire `prompt-optimizer` skill.

| Concrete Fable 5.1 failure mode | Targeted patch (use verbatim from `skill://prompt-optimizer` when available) |
| --- | --- |
| Stops after proposing a plan or asks permission mid-run without a completion gate | `Finish-the-task` + `Deliver-scope` (omit "The user is not watching..." in HITL) |
| Pair programming / human watching long tool chains | `Progress-updates` |
| Risk of unrequested cleanup, scope drift, or scratch checks committed as test files | `Extras-only` |
| Risk of whole-file rewrites on small changes where edit tooling does not already prevent it | `Targeted-edits` |
| Sequential read/search bottlenecks when parallel batching is not already in worker rules | `Batch-tools` |
| Summarizing or comparing retrieved sources | `Quoting-example` (indirect synthesis; at most one short marked quote) |
| User-facing prose deliverable | `Mannered-prose ban` (`Please remove all mannered prose.`) |
| Chat surface carrying leftover anti-list/anti-bold rules | `Formatting-when-needed` |
| Client-side compaction of long threads | `Preserve-six` |
| Search/retrieval of fast-moving names at low effort | `Verify-names search` |
| Dense charts or images | `Crop and zoom` |
| Worker itself spawns subagents | `Async subagents` |
| Long single-turn deliverable at `xhigh` / `max` | `No double-draft` + `max_tokens` headroom note |
| Compile-check phrasing, undocumented obscure languages, or raw base64 tool dumps | `Safeguard phrasing` |

## Invariants (always)

- The approved request sets the scope: do not quietly narrow, widen, or swap it.
- Preserve parent decisions, constraints, and identifiers in the user's words; condense only explanation and unconstrained method.
- NEVER add "hold all findings for the final response" or similar narration-suppressors.
- Separate verified results from assumptions, unverified paths, and blocked items in `# Return`.
- Do not use em-dashes in handoff prompts or chat output (exception: verbatim vendor patch text only when a Fable patch is explicitly selected).

## Quality bar

- Specialist role (on `task.role` or `# Role`): `"Auth-flow security reviewer"`, never `"Researcher"`.
- `# Task`: one clear objective; split unrelated goals into separate handoffs.
- `# Context` and `# Boundaries`: fully self-contained with zero reliance on parent chat history.
- `# Acceptance` and `# Return`: observable evidence and explicit status separation, with zero em-dashes.

## Interplay with other packs

Map-phase assignments in `agentic-mapreduce` runs SHOULD use this contract (`task.role` = shard-specialist, `# Inputs` = the signal batch, `# Boundaries` = read-only or worktree-scoped limits, `# Acceptance` = full signal accounting) and add model-specific patches only when the worker target warrants them. Any `task` or `tot-reasoner` spawn benefits from this structure when the raw request is loose. General prompt rewrites that are not handoffs use `prompt-optimizer` directly.
