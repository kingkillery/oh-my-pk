 # OMPK Revamp — Requirement Matrix (candidate: `.worktrees/revamp-v16.4.24`)

 Reconciliation 2026-09-20: prior broad Pass labels below are preserved as helper-test evidence only, NOT live-route acceptance. Live B01–B06 + C01–C22 acceptance requires runtime receipts on one content-addressed candidate per plan §Verification. No new test passes claimed by this reconciliation edit.
 Vault ownership: `C:/dev/Vaults/Design-and-Building/Daily Todos/Open/oh-my-pk-revamp-completion-v16.4.24.md` (Linear bypass per operator override).
 Target pin: `dadcd517e52d957e52282697550e309b62145c5a` (`main` / `v16.4.24`). Primary main has advanced to `b0bdac8310b4316c7e1554fafee1eebb93b6ab50` — compare touched seams only, never replay donor history.
 Package gate: `bun run check` in `packages/coding-agent` passes (Biome + tsgo) — scoped helper evidence, not live-path acceptance.
 New lifecycle suites: 62 tests across 14 files + 10 revamp acceptance tests pass — helper/unit scope; live provider-wire, independent-process contention, and installed-channel receipts still required.
 Baseline differential 2026-09-20: pristine `dadcd51` worktree reproduced the same 2 `test/task/worktree.test.ts` failures (lines 197, 334) — proven baseline EOL defects, NOT draft-caused. Root cause: host `core.autocrlf=true` converts fixture LF to CRLF on checkout. Fix: fixture-local `core.autocrlf=false` + `core.eol=lf` in all 4 test-repo fixtures, binary-byte assertions retained. Verified: pristine disposable 15/15 green, PINNED 15/15 green (`artifact://68`, `artifact://70`), combined with `phase0-entrypaths` 18/18 (`artifact://77`). Operational group 102/102 in 82.65s (`artifact://49`). Lane-A baseline fix complete; W0 candidate still requires Gate A union.

## Phase 0 gates B01–B06

 | Gate | Status | Evidence |
 |---|---|---|
 | B01 store contention | Unverified (helper: 97 pass) | `bun test test/operational/` helper scope; requires real child-process lock contender + independent-process contention, outer timeout >=180s |
 | B02 watcher taxonomy | Unverified (helper: 18 pass) | `scripts/release-query.test.ts` helper scope; requires bounded recovery/failure taxonomy preservation on candidate |
 | B03 native sentinel | Unverified (helper: 1 pass) | `.verify/native-mismatch.test.ts` fixture must be inspected before executing; requires matching native passes + explicit mismatch failure |
 | B04 channel independence | Unverified (stale: npm pending claim superseded) | GitHub CI 35487868418 + domain 5/5 repaired 14:59:39Z + npm all 18 at 16.4.24 per `release-channel-health.json`; requires verified per-channel receipts + NEGATIVE fixture where CI-pass/npm-pending must read incomplete, not pass |
 | B05 preflight/ownership | Unverified | Isolated worktree discipline noted; requires ownership/reconciliation tests + vault-tracked lane ownership |
 | B06 installed product | Blocked (partial smoke) | npm/bun fresh+upgrade smoke passed; hosted hang NOT reproduced (`historicalHangReproduced:false`); remaining: npm-to-npm upgrade, real updater rollback, installer/profile handling, captured-vs-PTY comparison, binary smoke/upgrade, macOS/Linux execution |

## Architecture acceptance (22)

 | # | Case | Status | Test |
 |---|---|---|---|
 | 1 | Default selection | Unverified (helper) | `test/revamp/launch-compatibility.test.ts` — requires live TaskTool sync+async + eval + native + restored session routes |
 | 2 | Historical resume | Unverified (helper) | `test/revamp/launch-compatibility.test.ts` — requires policy/harness pin + missing-manifest block + v1 legacy view |
 | 3 | Recursive ownership | Unverified (helper) | `test/revamp/admission-contention.test.ts` — requires two-planner race, subtree conservation, independent processes |
 | 4 | Leaf denial | Unverified (helper) | `test/orchestration/lifecycle-authority.test.ts` — requires high-tier worker denial before side effect + owner escalation |
 | 5 | Indirect denial | Unverified (helper) | `test/orchestration/lifecycle-authority.test.ts` — requires JS/Python bridge, aliases, hidden/custom/MCP, restored session |
 | 6 | Declared confinement | Unverified (helper) | `test/revamp/publication-recovery.test.ts` — requires zero provisioned resources on worktree-only backend |
 | 7 | Context canary | Unverified (unit) | `test/orchestration/context-projector.test.ts` — requires all phases + both tool formats on provider wire + child kernel isolation |
 | 8 | Useful evidence | Unverified (unit) | `test/orchestration/context-projector.test.ts` — requires granted read visible + revoked grant visible gap |
 | 9 | Early completion | Unverified (helper) | `test/operational/scheduler-delivery.test.ts` — requires slow/fast barrier + exact owner consume before slow release |
 | 10 | Capacity | Unverified (helper nodes) | `test/revamp/admission-contention.test.ts` — requires 4-dimension conservation across independent processes; token/compute/cost still missing |
 | 11 | Failure isolation | Unverified (helper) | `test/operational/scheduler-delivery.test.ts` — requires timeout/malformed-packet/tool-error typed failure + sibling artifacts preserved |
 | 12 | Durable delivery | Unverified (helper) | kill-after-settlement-before-delivery + reopen + duplicate → one inbox/plan effect still required |
 | 13 | Stale attempt | Unverified (helper) | `test/revamp/publication-recovery.test.ts` — requires cancel/expire/supersede + late worker artifacts retained, publish denied |
 | 14 | Artifact retention | Unverified (helper) | `test/task/lifecycle-capture.test.ts` — requires root+nested dirty/untracked + cancel/crash → durable hashes or quarantined failure |
 | 15 | Dirty conflict | Unverified (unit) | `test/task/lifecycle-publisher.test.ts` — requires human-edit-between-prepare-apply → conflict/pending, both retained |
 | 16 | Mutation contract | Unverified (helper) | `test/task/lifecycle-publisher.test.ts` — requires apply=false/no-commit/no-push/no-merge across sync/async/eval/native/resume/dispatcher |
 | 17 | Partial nested | Unverified (unit) | `test/task/lifecycle-publisher.test.ts` — requires root-applied+nested-fail → partial + blocked acceptance + recovery refs |
 | 18 | Snapshot evidence | Unverified (helper) | `test/orchestration/snapshot-completion.test.ts` — requires 1-byte tracked/untracked/nested/config mutation → stale |
 | 19 | Blocker semantics | Unverified (helper) | `test/orchestration/snapshot-completion.test.ts` — requires open+acknowledged → blocked; waiver listed never passing |
 | 20 | Reducer integrity | Unverified (helper) | `test/orchestration/observation-receipts.test.ts` — requires corrupt hash/quote/span/source/exit → reject + raw retained |
 | 21 | Research boundary | Unverified (controller) | real OCI escape/read-denial fixture required before enabling lab execution; fake-model controller does NOT certify isolation |
 | 22 | Rollback | Unverified (helper) | `test/revamp/rollout-replay.test.ts` — requires active hierarchical + legacy retain policy, new-run legacy/direct, future DB non-destructive block |

 ## Explicit follow-ups (not claimed)

 - Live provider-wire projection tests across all phases and both tool formats.
 - Real eval kernel isolation regression (parent canary vs child).
 - Token/compute-runtime/cost budget conservation beyond node caps.
 - Dispatcher identity mapping: Linear bypassed per operator override; vault-tracked ownership only. No live external dispatcher deployment implied.
 - npm 16.4.24 publication: RECOVERED per `release-channel-health.json` (all 18 at 16.4.24, CI 35487868418 attempt 2). Do NOT republish or downgrade on later `latest`.
 - Default flip (`task.lifecycle.enabled` / `task.topology`): waits for installed-product gate and operator sign-off.
 - a01/a02/a03/B06 closure reopened pending Gate A; 18 and 22 IDs intact.
