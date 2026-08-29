---
name: pk-subagent-orchestrator
description: Use when designing, configuring, or running oh-my-pk subagent orchestration: one visible endpoint over task/quick_task/oracle/reviewer/explore agents, deterministic route planning, parallel waves, recursive delegation caps, independent verification, and final synthesis without exposing internal routing. Also use when invoking the verifier-extension `subagent_orchestrator_plan` tool to compute an OMP-native route plan.
---

# PK Subagent Orchestrator for oh-my-pk

Build one public controller over oh-my-pk subagents. The caller sees one answer. Internally you MAY answer directly, call one specialist, spawn a parallel `task` wave, recurse through a narrower child orchestrator, verify, then synthesize.

<critical>
- NEVER delegate simple low-risk requests.
- NEVER expose routing, subagent names, recursion depth, or raw transcripts.
- NEVER treat subagent output as truth. Evidence wins.
- MUST cap recursion and fanout before spawning.
- MUST synthesize one answer in the user's requested format.
</critical>

## OMP primitives

| Need | OMP primitive |
|---|---|
| Specialist implementation/research | `task` |
| Mechanical lookup/update | `quick_task` |
| Broad read-only codebase scouting | `explore` |
| Senior hands-on judgment | `oracle` |
| Review/failure finding | `reviewer` or CE reviewer agents |
| Parallel wave | one `task` call with `tasks[]` |
| Peer coordination | IRC + Agent Hub |
| Route-plan computation | verifier-extension `subagent_orchestrator_plan` |
| Independent verification | `llm_as_verifier`, `fmh`, reviewer from different model family |

## Route first

Before spawning, classify:

- complexity: `single-step | multi-step | open-ended`
- risk: `low | med | high`
- evidence need: `current-context | tool-retrieval | multi-source`
- decomposition: `independent | sequential | not-decomposable`
- data sensitivity: `public | internal | confidential | unknown`

If the extension tool is available, call `subagent_orchestrator_plan` with:

```json
{
  "request": "<user request or narrowed subproblem>",
  "complexity": "multi-step",
  "risk": "med",
  "evidenceNeed": "tool-retrieval",
  "decomposability": "independent",
  "dataSensitivity": "unknown",
  "recursiveAllowed": false,
  "specialists": [
    {
      "name": "CodeResearcher",
      "scope": "codebase discovery and file evidence",
      "costTier": "low",
      "role": "specialist",
      "capabilities": ["read", "search", "codegraph"]
    },
    {
      "name": "IndependentVerifier",
      "scope": "evidence checking and contradiction finding",
      "costTier": "med",
      "role": "verifier"
    }
  ]
}
```

Tool result gives:

- `mode`: `fast | deep`
- `routing`: `direct | single | parallel | recursive`
- `subagents`: selected specialists
- `verification`: `V0..V3`
- `maxDepth`, `maxFanout`, `childCallLimit`
- private hidden route-plan block

Use the plan. Override only when repo evidence proves it wrong.

## Routing policy

- Direct: simple + low risk + current context sufficient.
- Single: one specialist materially improves result.
- Parallel: independent subtasks can run without shared output.
- Sequential: B requires A's artifact or decision.
- Recursive: only open-ended decomposable subproblem needs orchestration.

Cost rule: cheapest capable first. Escalate on high risk, weak evidence, conflict, verifier failure, missing capability, or human-only decision.

## Delegation contract

Every subagent assignment MUST include:

- Objective: one sentence.
- Scope: exact files/systems; explicit non-goals.
- Inputs: paths, handles, artifacts, constraints.
- Output: required shape.
- Evidence: files, tests, sources, or `unknown`.
- Failure: what to report instead of guessing.
- Verification ban: subagents do not run project-wide gates.

Use OMP task format:

```markdown
# Goal
One-sentence batch goal.

# Constraints
MUST/NEVER rules, shared assumptions, no project-wide gates.

# Contract
Shared interfaces, expected outputs, handoff format.
```

Per task:

```markdown
# Target
Exact files/symbols/scope.

# Change
Concrete work or investigation.

# Acceptance
Observable result; no project-wide commands.
```

## Verification tiers

- V0 self-check: low-risk subjective output.
- V1 evidence check: factual/technical/user-actionable.
- V2 independent review: complex, multi-agent, code changes, conflicts.
- V3 adversarial: security, privacy, legal, financial, destructive, credentials.

V2+ MUST use an independent family/persona. Aggregate by evidence, not votes.

## Recursion controls

Defaults:

- max depth: `2`
- max fanout per level: `5`
- max total child calls: `12`

Stop when solved, uncertainty repeats, two iterations add no evidence, outputs become circular, or more calls will not change the answer.

Child orchestrators receive a narrower objective, allowed subagents, non-goals, output contract, and stop condition. Parent owns final synthesis.

## Final synthesis

Return one answer:

- Satisfy the user's requested format.
- Cite files/tests/sources when trust depends on them.
- Mark inference explicitly.
- Name unresolved blockers.
- Hide route details and raw transcripts.
- Do not average contradictions; resolve by evidence.

<critical>
- Route before spawning.
- Parallelize independent subtasks in one `task` batch.
- Verify before final synthesis.
- Keep routing private.
</critical>
