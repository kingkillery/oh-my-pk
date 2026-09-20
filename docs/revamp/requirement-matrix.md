 # OMPK Revamp — Requirement Matrix (candidate: `.worktrees/revamp-v16.4.24`)

 Reconciliation 2026-09-20: prior broad Pass labels below are preserved as helper-test evidence only, NOT live-route acceptance. Live B01–B06 + C01–C22 acceptance requires runtime receipts on one content-addressed candidate per plan §Verification. No new test passes claimed by this reconciliation edit.
 Vault ownership: `C:/dev/Vaults/Design-and-Building/Daily Todos/Open/oh-my-pk-revamp-completion-v16.4.24.md` (Linear bypass per operator override).
 Target pin: `dadcd517e52d957e52282697550e309b62145c5a` (`main` / `v16.4.24`). Primary main has advanced to `b0bdac8310b4316c7e1554fafee1eebb93b6ab50` — compare touched seams only, never replay donor history.
 Package gate: `bun run check` in `packages/coding-agent` passes (Biome + tsgo) — scoped helper evidence, not live-path acceptance.
 New lifecycle suites: helper/unit scope only; live provider-wire, independent-process contention, and installed-channel receipts still required.
 Baseline differential 2026-09-20: pristine `dadcd51` worktree reproduced the same 2 `test/task/worktree.test.ts` failures (lines 197, 334) — proven baseline EOL defects, NOT draft-caused. Root cause: host `core.autocrlf=true` converts fixture LF to CRLF on checkout. Fix: fixture-local `core.autocrlf=false` + `core.eol=lf` in all 4 test-repo fixtures, binary-byte assertions retained. Verified: pristine disposable 15/15 green, PINNED 15/15 green (`artifact://68`, `artifact://70`), combined with `phase0-entrypaths` 18/18 (`artifact://77`). Operational group 102/102 in 82.65s (`artifact://49`). Lane-A baseline fix complete; W0 candidate still requires Gate A union.

## W1 checkpoint and extension (2026-09-20)

Branch `revamp/lifecycle-w1` (base `dadcd517`). Committed, NOT merged, NOT released.

| Item | Status | Evidence |
|---|---|---|
| W1 checkpoint: v3 snapshot read repair | Done | `getLifecycleRunSnapshot` rewritten against real v3 DDL; `test/operational/lifecycle-run-snapshot.test.ts` 8 pass on real temp SQLite |
| W1 checkpoint: strict wire parsers | Done | `test/task/lifecycle-schema-roundtrip.test.ts` 11 pass covering every frozen shape × missing/wrong-type/unknown-field/bad-version/non-integral/tampered-hash/null-vs-absent |
| W1 checkpoint: fixture migration | Done | Invalid local fixtures migrated to shared helpers; scenario budgets preserved |
| W1 checkpoint: package gate | Done | `bun run check` passes; `test/task/` 365, `test/orchestration/` 303, `test/operational/`+`test/revamp/` 123 — all 0 fail |
| W1 checkpoint: freeze manifest | Done | `docs/revamp/contract-freeze.json` — 21 shapes, 0 unresolved, digest recorded |
| W1 extension: authority dictionary | Done | §14.2 record vocabulary + per-dimension `compareRuntimeGuarantees` |
| W1 extension: envelope/binding/operation records | Done | §14.2/§14.5 persisted records and operation inputs; precursor `LaunchBinding` renamed `LaunchBindingInput` |
| W1 extension: authority parsers | Done | `parseResourceSelectorV1`, `parseGrantRecordV1`, `validateLaunchBindingGuarantees`, `computeLaunchContractDigest`; `test/task/launch-authority-policy.test.ts` 27 pass |
| W1 extension: authority compilation | Done | `compileLaunchAuthority` §14.3 intersections, spawn/budget/fork/result coherence; 41 pass in `launch-authority-policy.test.ts` |
| W1 extension: v2 `CompiledLaunchContract` cutover | Done | schemaVersion 2 with contractId/revision/digest/principals/authority/provenance; `LaunchCompileInput.authorization`; `bindLaunchContract` verifies the contract digest |
| W1 extension: authority shapes in freeze manifest | Partial | `ResourceSelectorV1` and `GrantRecordV1` frozen (23 shapes); 16 declared authority shapes listed in `pendingShapes`, manifest reports `complete:false` |

## W2 — durable authority (2026-09-20)

| Item | Status | Evidence |
|---|---|---|
| v4 migration with authority tables | Done | 13 `launch_*` tables added additively; v1–v3 rows untouched |
| Schema-enforced invariants | Done | contract digest UNIQUE, one binding per attempt, CHECK on state/event kind, non-negative channel budgets, inbox keyed by context generation, revision/release idempotency |
| Admission + activation protocol | Done | `admitLaunchAuthority` commits `authorized` (not live); `activateLaunchBinding` walks authorized→bound→active with CAS on state and epoch |
| Guarantee enforcement at activation | Done | Activation refuses when measured guarantees fall short on any dimension, reporting every shortfall; makes `compareRuntimeGuarantees` load-bearing |
| Real-store tests | Done | `test/operational/launch-authority-store.test.ts` 20 pass, real temp SQLite |
| Cross-process contention | Done | 4 independent Bun processes via a standalone readiness-barrier runner; caught TWO real bugs — deferred transactions ignore `busy_timeout` on write-lock upgrade (fixed with `.immediate()`), and 5s `busy_timeout` is too short under load (now 30s + bounded idempotent-safe retry). Host quirks documented: Windows spawn pid ≠ child pid; `Bun.write` ignores `{append:true}` |
| Grant issuance / revocation / lineage methods | **Not started** | Tables exist; `appendLaunchGrant`, `revokeLaunchGrant`, `getLaunchGrant` not implemented |
| Channel + delivery admission methods | **Not started** | Tables exist; `admitLaunchDelivery`, `advanceLaunchDisclosurePhase`, inclusion/provider-outcome recording not implemented |

## W3 — runtime enforcement (2026-09-20)

| Item | Status | Evidence |
|---|---|---|
| Opaque runtime-registered context | Done | Branded handle + host-private WeakMap; forged literal, revoked context and missing identity all denied `missing_lifecycle_binding` |
| Authorizer repair | Done | Legacy blanket allow removed; source-qualified alias-resolved tool check, read/write root separation, traversal denial, external-write gating; 11 pass |
| Adapter cutover per §14.6 caller matrix | **Not started** | The guard is correct but is NOT yet the choke point: `task/index.ts`, `task/executor.ts`, `sdk.ts`, `tools/index.ts` do not call it yet |
| Scoped services and provider projection | **Not started** | — |
| LC01–LC24 live suite | **Not started** | No live provider-wire or entry-point coverage exists |

All W1–W3 evidence above is unit, schema and cross-process scope. No live
provider-wire test, no entry-point enforcement and no LC row is claimed.
Because the adapter cutover has not happened, the authority system does not
yet constrain any production dispatch path.

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
