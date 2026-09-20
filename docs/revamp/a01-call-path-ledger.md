 # A01 Call-Path Ledger and Baseline Audit

 Reconciliation 2026-09-20: prior Pass/Present-and-tested labels preserved as helper scope only. Each B/architecture case below must carry source/candidate, command, environment, exit, artifacts, owner before Gate A closure. Stale A01/A02/A03/B06 closure reopened; 18 and 22 IDs intact. Vault ownership replaces Linear per operator override.
 Nonexistent `completeJob/failJob/cancelJob/resume` store APIs already removed — lifecycle mutations strictly via `transitionJob`, claim/checkpoint/lease methods, runner resume. Do NOT assume `runSubprocess` guarantees OS sandbox.

 **Work Package:** A01 — Baseline and Call-Path Audit
 **Target Baseline:** `kingkillery/oh-my-pk` at `dadcd517e52d957e52282697550e309b62145c5a` (`v16.4.24` tag; primary `main` advanced to `b0bdac8310b4316c7e1554fafee1eebb93b6ab50`)
 **Workspace:** `.worktrees/revamp-v16.4.24`
 **Date:** 2026-09-20

---

## 1. Inventory of Real Call Paths

### 1.1 Launch Routes
- **CLI Direct Launch:** `packages/coding-agent/src/cli.ts` (`runAgent()`, `runSession()`). Reads settings, instantiates `ToolSession`, binds UI/TUI, mounts tools, and runs the main loop without hierarchical planner allocation.
- **Task Tool Dispatch:** `packages/coding-agent/src/task/index.ts` (`TaskTool.execute()`).
  - Pre-allocation planning: `spawn-plan.ts` (`createSpawnPlan()`) evaluates `AgentExecutionProfile`, checks `TaskSpawnPolicyHook`, and computes eligible routes without allocating agent IDs, jobs, or worktrees.
  - Multi-agent / batch: `resolveSpawnItems()` expands batch requests (`task.batch`).
  - Async registration: When `async.enabled` is true, registers jobs via `AsyncJobManager.register()` (`#registerSpawnJob()`).
  - Sync fallback: Executes via `#executeSync()` -> `#runSpawn()`.
- **Autonomous & Durable Launch:** `task/index.ts` (lines 1852–1925) when `fusion.mode === "autonomous"`.
  - Opens `OperationalStore.open()`.
  - Serializes `NativeTaskJobPayload` via `nativeTaskJson()`.
  - Enqueues job in `DurableRunner` (`runner.enqueue({ type: "native_task", payload })`).
  - Claims and executes via `runner.runJobById(job.id, signal)`.
- **Subprocess Worker Launch:** `task/executor.ts` (`runSubprocess()`).
  - Spawns worker process via Bun/Node CLI with `--agent` or specialized runner arguments.
  - Passes ephemeral rendered prompt and task context via environment or stream.

### 1.2 Completion & Settlement Routes
- **In-process Tool Settlement:** `task/index.ts` (`#runSpawn()` lines 2380–2460). Gathers `SingleResult`, duration, usage/tokens, and cost.
- **Durable Job Settlement:** `packages/coding-agent/src/operational/store.ts` (`OperationalStore.transitionJob()`, `claimJob()`, `saveCheckpoint()`, `recordHeartbeat()`).
  - NOTE: `OperationalStore` does not expose bare `completeJob()`, `failJob()`, `cancelJob()`, or `resume()` methods; lifecycle status mutations occur strictly through `transitionJob()` with valid transition rules (e.g. `running -> completed | failed | cancelled`).
  - Updates SQLite database using `BEGIN IMMEDIATE` write transaction discipline (`#withImmediateTransaction`).
- **Completion Gate Validation:** `packages/coding-agent/src/orchestration/completion-gate.ts` & `root-completion-gate.ts`.
  - Assesses deliverables against `TaskContractV1` completion criteria.
  - Injects adjudication via `criterion-adjudication.ts`.

### 1.3 Tool Dispatch & Context Firewall Routes
- **Harness & Capability Filter:** `packages/coding-agent/src/orchestration/agent-harness.ts` (`resolveAgentHarness()`, `filterSkillsForHarness()`).
  - Filters available tools and autoload skills based on harness kind (`simple`, `standard`, `full`).
- **Context Firewall / Lane Policy:** `packages/coding-agent/src/orchestration/context-policy.ts` (`compileLanePolicy()`).
  - Compiles `sharedContext`, `requestedCollaboration`, and filters sibling findings based on `contextPolicy` (`shared`, `blind`, `staged`).
- **Prompt Isolation:** `packages/coding-agent/src/task/render.ts` (`renderSubagentUserPrompt()`). Renders isolated task instructions without leaking parent system transcript.

### 1.4 Capture & Workspace Isolation Routes
- **Worktree Isolation Backend:** `packages/coding-agent/src/task/worktree.ts` (`ensureIsolation()`).
  - Allocates clean git worktree (`git worktree add`).
  - Captures baseline state via `captureBaseline()`.
- **Delta Capture:** `packages/coding-agent/src/task/worktree.ts` (`captureDeltaPatch()`).
  - Computes `rootPatch` and `nestedPatches` via git diff against the baseline.
  - Retains patch artifact at `${agentId}.patch` in `effectiveArtifactsDir`.

### 1.5 Publication & Integration Routes
- **Task Result Integration:** `packages/coding-agent/src/task/integration.ts` (`integrateTaskResult()`).
  - Checks child exit code and errors; aborts integration on error while retaining recovery artifacts.
  - Checks patch applicability against live worktree via `git.patch.canApplyText()`.
  - Mode `"patch"`: Applies patch via `git.patch.applyText()`.
  - Mode `"branch"`: Merges task branch via `mergeTaskBranches()`.
  - Cleans up task branch only upon successful merge via `cleanupTaskBranches()`.
  - Sets `changesApplied = true` and generates descriptive `mergeSummary`.

### 1.6 Resume & Recovery Routes
- **Operational Resume:** `packages/coding-agent/src/operational/runner.ts` (`DurableRunner.resume()`, `runPending()`, `runJobById()`) and `store.ts` (`OperationalStore.getLatestCheckpoint()`, `getJob()`).
- **Persisted Profile Revive:** `packages/coding-agent/src/task/persisted-revive.ts`. Revives agent profile and execution parameters from durable checkpoints.
- **Recovery Policy:** `packages/coding-agent/src/task/recovery-policy.ts`. Decides retry eligibility, tier escalation, and backoff.

### 1.7 Eval Launch & Programmatic Bridge Routes
- **Eval Agent Launch:** `packages/coding-agent/src/eval/` (`runEvalAgent()`). Spawns programmatic subagents within persistent Python/JS runtime sessions.
- **Bridge Context:** Cross-language tools invoke host bridge callbacks without going through the standard user CLI loop; requires strict capability wrapping.
---

 ## 2. Classification of Acceptance Suite Requirements (22 Invariants) — all Unverified pending live-route receipts

 Prior Incomplete/Missing/Present labels preserved in Current State column as static scope only. Gate taxonomy: verified | failed | unverified | not applicable + reason. No live-route Pass claimed here.

 | ID | Invariant Name | Classification | Current State in Repository |
|---|---|---|---|
| 1 | Default selection | Incomplete | Direct CLI and legacy task tools exist; default hierarchical promotion vs explicit legacy flag requires unified policy in `spawn-plan.ts` and config. |
| 2 | Historical resume | Incomplete | Store checkpoints exist; retaining exact recorded topology and authority policy across version upgrades needs formal schema pinning. |
| 3 | Recursive ownership | Incomplete | `taskDepth` is tracked; explicit single logical owner with strict subset budget/capability grants is not yet enforced at child admission. |
| 4 | Leaf denial | Incomplete | Read-only agents are restricted, but general leaf workers can still access the `task` tool if exposed in harness profiles. |
| 5 | Indirect denial | Missing | Denials through programmatic bridges, eval tools, and restored sessions need systematic capability interception. |
| 6 | Declared isolation | Present-and-tested | `task.isolation.mode` blocks on non-git repository (`ensureIsolation()`); does not silently downgrade when isolation is requested. |
| 7 | Context canary | Missing | No synthetic marker verification tests ensuring internal operational tokens never leak into child prompt context. |
| 8 | Useful-context sufficiency | Incomplete | `task-contract.ts` and prefetch evidence exist, but formal missing-required-input gap detection is not fully wired. |
| 9 | Early completion | Present-but-unproven | AsyncJobManager allows concurrent jobs; early delivery of fast child to waiting parent requires exact outbox/inbox wiring. |
| 10 | Capacity conservation | Missing | Run-wide recursive admission concurrency limits are absent; semaphore is local per-session. |
| 11 | Task failure isolation | Present-and-tested | In batch/async task execution, one child failing records `progress.status = 'failed'` without cancelling unrelated sibling executions. |
| 12 | Durable delivery | Present-but-unproven | `OperationalStore` records job completion; exact idempotent delivery across parent restart requires outbox mechanism. |
| 13 | Stale attempt | Incomplete | Checkpoints record attempt numbers; rejecting late publications from cancelled/expired attempts needs run-level epoch fencing. |
| 14 | Artifact retention | Present-and-tested | `task/integration.ts` explicitly preserves `.patch` and branch references when integration fails or child execution errors. |
| 15 | Dirty baseline / conflict | Present-and-tested | `canApplyText()` prevents applying patches over conflicting worktree state; conflict fails safely without claiming success. |
| 16 | Mutation contracts | Present-and-tested | `codeWrite` strictly verifies target boundaries via `assertCodeWriteTarget()`; no git commits/pushes performed without explicit configuration. |
| 17 | Partial nested publication | Missing | Nested subagent partial failures can be masked if parent marks overall step completed; requires atomic multi-level settlement. |
| 18 | Snapshot verification | Missing | No git tree hash / snapshot fingerprint binding verification receipts to an immutable repository state. |
| 19 | Blocker semantics | Present-and-tested | `task-contract.ts` and `completion-gate.ts` prevent narrative-only resolution when targeted verification checks are required. |
| 20 | Reducer integrity | Incomplete | MapReduce worker/reducer exists; strict cryptographic receipt verification for invalid hashes or exit codes needs tests. |
| 21 | Research boundary | Missing | Research lab and evaluation environments are not yet fenced from production acceptance policies. |
| 22 | Rollback | Incomplete | Operational store migrations and config settings can be disabled, but complete rollback tests for persisted runs are unproven. |

---

 ## 3. Baseline & Release Protection Status (B01–B06) — all Unverified pending Gate A receipts

 - **B01: Store transaction discipline and contention — Unverified (helper: 99 pass)**
   - *Helper:* `packages/coding-agent/src/operational/store.ts` uses `BEGIN IMMEDIATE` (`#withImmediateTransaction`). `bun test test/operational/` 99 pass helper scope.
   - *Required:* real child-process lock contender in `test/operational/native-task-executor.test.ts`, independent-process contention, outer timeout >=180s. Source/candidate/command/env/exit/artifacts/owner still to record.
 - **B02: Watcher failure taxonomy — Unverified (helper: 3 pass)**
   - *Helper:* `scripts/release-query.ts` bounded backoff, non-retryable auth/syntax classification. `scripts/release-query.test.ts` 3 pass.
   - *Required:* bounded recovery/failure taxonomy preservation receipt on candidate.
 - **B03: Source/native version consistency — Unverified (helper: 1 pass)**
   - *Helper:* CI run `35486664824` artifact `pi_natives.win32-x64-baseline.node` sentinel `__piNativesV16_4_24`; `.verify/native-mismatch.test.ts` 1 pass.
   - *Required:* inspect carried `.verify` fixture + CI addon identity before executing; matching native passes + explicit mismatch failure.
 - **B04: Independent release channel states — Unverified (stale npm-pending superseded)**
   - *Prior (preserved):* GitHub 5 assets; hosted `v16.4.24`; npm blocked ENEEDAUTH.
   - *Current receipts:* CI `35487868418` attempt 2 success; all 18 npm at 16.4.24; 5 domain binaries match GitHub SHA-256 (verified 14:59:39Z). Requires verified per-channel receipts + NEGATIVE fixture (CI-pass/npm-pending → incomplete, not pass).
 - **B05: Readiness/preflight and ownership — Unverified**
   - *Helper:* isolated worktree `.worktrees/revamp-v16.4.24`; clean-clone release discipline preserved.
   - *Required:* preflight/ownership/reconciliation tests + vault-tracked lane ownership (`oh-my-pk-revamp-completion-v16.4.24.md`).
 - **B06: Installed-product contract — Blocked (partial smoke; prior hang claim superseded)**
   - *Prior (preserved):* `v16.4.23`/`v16.4.24` hang under captured stdout, PTY ok; source `runCli` clean.
   - *Current:* hosted Windows version succeeds; former capture hang NOT reproduced (`historicalHangReproduced:false`). Remaining: npm-to-npm upgrade, real updater rollback, installer/profile handling, captured-vs-PTY comparison, binary smoke/upgrade, macOS/Linux execution. Risk seam preserved: `src/cli/update-cli.ts` `verifyInstalledVersion()` uses quiet capture.
