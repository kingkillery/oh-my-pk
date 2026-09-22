 # OMPK Revamp — Requirement Matrix (candidate: `.worktrees/revamp-v16.4.24`)

 Reconciliation 2026-09-20: prior broad Pass labels below are preserved as helper-test evidence only, NOT live-route acceptance. Live B01–B06 + C01–C22 acceptance requires runtime receipts on one content-addressed candidate per plan §Verification. No new test passes claimed by this reconciliation edit.

Reconciliation outcome (2026-09-22): implementation completed on the same HEAD `675b05cb5568ebd96c694bb07a280d3340150404` (`revamp/lifecycle-w1`). The corrected candidate identity is the regenerated freeze manifest: `sha256:31589601d0ff7e8db76c6bed12d96c1162a20c17f366cd227d0dee7e21a11230` (2,533 files), `docs/revamp/contract-freeze.json` reporting 41/41 shapes frozen, 0 pending, `complete:true`. **Final union receipt on this candidate: 1090 pass / 0 fail / 1090 tests across 106 files (165.56s)** — the exact plan union (`test/task/ test/orchestration/ test/operational/ test/revamp/` plus the §14.6 caller-regression files). The prior failed union (1035/2) and its two historical green checkpoints remain earlier-candidate evidence. `bun check` (biome + tsgo types) passes on this candidate. Root causes fixed this pass: `journal_mode` demotion on store close corrupted concurrent cross-process holders (races now single-effect clean); publication-path inline prepared statements cached and finalized on close plus widened fixture disposal window (EBUSY cleanups); capture artifact URIs now real `file:///` URLs and nested-repo targets no longer fail the root before-image clean check (D-gate real root+nested Git publication green); receipt parser errors follow the `unknown_field` convention.

Ledger rule: **Implemented source**, **focused verification**, and **wave acceptance** are independent states. A passing earlier receipt remains historical evidence for its exact candidate; it does not certify this dirty overlay. Isolated reruns diagnose failures but cannot convert a failed union into a pass.
 Vault ownership: `C:/dev/Vaults/Design-and-Building/Daily Todos/Open/oh-my-pk-revamp-completion-v16.4.24.md` (Linear bypass per operator override).
Historical production baseline: `dadcd517e52d957e52282697550e309b62145c5a` (`main` / `v16.4.24`). This worktree has since advanced through revamp-only commits to the current HEAD recorded above; neither donor history nor the dirty overlay is merged or released.
Historical package gate: `bun run check` passed at an earlier checkpoint — scoped helper evidence only, not a check of the current dirty candidate or live-path acceptance.
Lifecycle suites listed below are helper/unit evidence unless a row names the real route and exact candidate. Live provider-wire, independent-process contention, real Git/publication, and installed-channel receipts remain required.
 Baseline differential 2026-09-20: pristine `dadcd51` worktree reproduced the same 2 `test/task/worktree.test.ts` failures (lines 197, 334) — proven baseline EOL defects, NOT draft-caused. Root cause: host `core.autocrlf=true` converts fixture LF to CRLF on checkout. Fix: fixture-local `core.autocrlf=false` + `core.eol=lf` in all 4 test-repo fixtures, binary-byte assertions retained. Verified: pristine disposable 15/15 green, PINNED 15/15 green (`artifact://68`, `artifact://70`), combined with `phase0-entrypaths` 18/18 (`artifact://77`). Operational group 102/102 in 82.65s (`artifact://49`). Lane-A baseline fix complete; W0 candidate still requires Gate A union.

## W1 checkpoint and extension (2026-09-20)

Branch `revamp/lifecycle-w1` (production baseline `dadcd517`; current HEAD recorded above). Revamp foundation is committed through HEAD; the current overlay remains uncommitted, unmerged, and unreleased.

| Item | Status | Evidence |
|---|---|---|
| W1 checkpoint: v3 snapshot read repair | Done | `getLifecycleRunSnapshot` rewritten against real v3 DDL; `test/operational/lifecycle-run-snapshot.test.ts` 8 pass on real temp SQLite |
| W1 checkpoint: strict wire parsers | Done | `test/task/lifecycle-schema-roundtrip.test.ts` 11 pass covering every frozen shape × missing/wrong-type/unknown-field/bad-version/non-integral/tampered-hash/null-vs-absent |
| W1 checkpoint: fixture migration | Done | Invalid local fixtures migrated to shared helpers; scenario budgets preserved |
| W1 checkpoint: package gate | Done | `bun run check` passes; `test/task/` 365, `test/orchestration/` 303, `test/operational/`+`test/revamp/` 123 — all 0 fail |
| W1 checkpoint: freeze manifest | Done | `docs/revamp/contract-freeze.json` — 21 shapes, 0 unresolved, digest recorded |
| W1 extension: authority dictionary | **Closed on union candidate** | All declared §14.2 records (AuthorityEnvelopeV1, LaunchAuthorizationSnapshotV1, GrantEventV1, DeliveryRecordV1, DeliveryEventV1, LaunchAuthorityRefV1, …) frozen with real parsers; 0 pending; round-trip + negative tests in schema-roundtrip suite |
| W1 extension: envelope/binding/operation records | **Closed on union candidate** | Runtime `LaunchContract = {schemaVersion:2, compiled, binding}` cutover complete; `bindLaunchContract` verifies identity/digest/principal coherence against the persisted binding; archival v1 isolated to explicit reauthorization paths |
| W1 extension: authority parsers | **Closed on union candidate** | Strict round trips for the full runtime dictionary pass in the union (schema-roundtrip file included) |
| W1 extension: authority compilation | **Closed on union candidate** | Non-expansion intersects `parentDelegable.delegableCapabilities`; invoke-without-delegate and delegate-without-invoke both tested in `launch-authority-policy.test.ts` |
| W1 extension: v2 `CompiledLaunchContract` cutover | **Closed on union candidate** | Store admission persists compiled contract + principals + one `launch_bindings` row in-transaction; activation binds the re-read row; `LifecycleFence` carries `launchAuthority: LaunchAuthorityRefV1` |
| W1 extension: authority shapes in freeze manifest | Done | 41/41 shapes frozen, `complete:true`, candidate manifest `sha256:31589601…` (2,533 files) |

## W2 — durable authority (2026-09-20)

| Item | Status | Evidence |
|---|---|---|
| **W2 wave acceptance** | **Closed on union candidate** | Actor authentication (`#authenticateActor` against durable registrations), root/recipient lineage + policy-epoch checks, in-transaction canonical digest recomputation, idempotent `terminateLaunchBinding`, use-time live-binding revocation predicate — all exercised by the 106-file union incl. forged-actor/stale-epoch/wrong-root/tampered-digest/abort-after-admission coverage |
| v4 migration with authority tables | Done | 13 `launch_*` tables added additively; v1–v3 rows untouched |
| Schema-enforced invariants | Done | contract digest UNIQUE, one binding per attempt, CHECK on state/event kind, non-negative channel budgets, inbox keyed by context generation, revision/release idempotency |
| Admission + activation protocol | Done | `admitLaunchAuthority` commits `authorized` (not live); `activateLaunchBinding` walks authorized→bound→active with CAS on state and epoch |
| Guarantee enforcement at activation | Done | Activation refuses when measured guarantees fall short on any dimension, reporting every shortfall; makes `compareRuntimeGuarantees` load-bearing |
| Real-store tests | Done | `test/operational/launch-authority-store.test.ts` 31 pass, real temp SQLite |
| Cross-process contention | Done | 4 independent Bun processes via a standalone readiness-barrier runner; caught TWO real bugs — deferred transactions ignore `busy_timeout` on write-lock upgrade (fixed with `.immediate()`), and 5s `busy_timeout` is too short under load (now 30s + bounded idempotent-safe retry). Host quirks documented: Windows spawn pid ≠ child pid; `Bun.write` ignores `{append:true}` |
| Grant issuance / revocation / lineage methods | Done | `appendLaunchGrant` (source liveness + strict depth narrowing, content-derived idempotency), `revokeLaunchGrant` (transitive BFS over lineage edges, double-revoke no-op), `getLaunchGrant` (strict parse) |
| Channel + delivery admission methods | Done | `admitLaunchDelivery` (atomic delivery+event+inbox+budget commit; digest computed in-store, never caller-supplied; per-message/count/total budget axes; revoked-binding denial), `recordLaunchProviderOutcome` (provider-unknown records, never refunds). Channel PINNING into contracts and `advanceLaunchDisclosurePhase` remain W3 |

## W3 — runtime enforcement (2026-09-20)

| Item | Status | Evidence |
|---|---|---|
| **W3 wave acceptance** | **Closed on union candidate** | `schedulerTick` implements reconcile→relay→deterministic dependency-ready claim→start-outside-transaction on the existing store/queue (slow-sibling/fast-handoff proven); persisted immutable admission inputs (baseline/template/probe bytes with UTF-8 counts via `persistLaunchEvidence`); positive Git-vs-non-Git baseline detection (no failure-as-empty-workspace); issuer spawn ceilings (`maySpawn`/`maxDepth`) enforced pre-compilation; host-issued provenance with fail-closed `untrusted_context` for self-certified fragments. LC01–LC24 live provider-wire acceptance remains a separate future gate |
| Opaque runtime-registered context | Done | Branded handle + host-private WeakMap; forged literal, revoked context and missing identity all denied `missing_lifecycle_binding`. Working-tree hardening copies and freezes nested capabilities and roots; caller mutation and host readback cannot rewrite the registration. |
| Authorizer repair | Done | Legacy blanket allow removed; source-qualified alias-resolved tool check, read/write root separation, traversal denial, external-write gating; 14 authority tests pass. Two mutation regressions and revoked-parent child derivation were reproduced failing before their fixes. Derivation now throws rather than returning an absent context that could select legacy execution. |
| Adapter cutover per §14.6 caller matrix | **Done for the spawn/dispatch surface (durable admission unified; bound helper calls, session replacement, hierarchical fork remain)** | Dispatch semantics landed: `authorizeToolInvocation` derives action/effect from the tool's declared `approval` tier and targets from `matcherPaths` then a bounded builtin adapter; undeclared semantics fail closed `undeclared_tool_semantics`. Guard runs before approval/`tool_call` and again after `tool_call` before the try. **Durable admission unified:** `LifecycleAuthorityRegistration.authority: LaunchAuthorityRefV1 | null` makes a bound context carry its durable identity; `createHostRootExecutionContext` mints the root issuer (principal, not binding); `ensureLaunchPrincipal` writes `launch_principals` inside `admitLaunchAuthority`; `admitBoundChildLaunch` (spawn-admission.ts) is the shared caller seam running issuer→`prepareLifecycleLaunch`→`activateBoundSessionAuthority`. Every spawn caller admits durably: TaskTool, eval `runEvalAgent`/`agent-bridge`, slash `subagent.ts`, `fusion-sidekick.ts`; `isolation-runner` pass-through; `deriveChildLifecycleContext` retired from all production callers. Revive/replay resolve existing authority + bind projection via `activateBoundSessionAuthority`. Still pending: bound helper calls, session replacement, hierarchical fork. |
| Scoped services and provider projection | **Done for the projection path (bound children now project; compaction/eval-completion seams remain)** | `projectLifecycleContext` emits a real provider `Context` from authorized fragments; `projectLifecycleSideRequest` wired into `transformProviderContext` (main-turn), `runEphemeralTurn`, advisor transform, `prepareSimpleStreamOptions`/`onPayload` (`unprojectable_provider_hook` strict rejection). `bindLifecycleProjection` now has production callers via `activateBoundSessionAuthority` — bound sessions carry a real `bindingId` and project instead of failing `untrusted_context`. Scoped eval kernel: bound children omit `parentEvalSessionId` → own session-file-scoped kernel. Remaining: compaction (`packages/agent` shared seam), eval-completion projection, harness `maxTools` re-pin on revive. |
| LC01–LC24 live suite | **Not started as a complete acceptance suite** | Partial entry-point/bridge seam regressions exist; no full route matrix or live provider-wire acceptance is claimed |

All W1–W3 evidence above is unit, schema, cross-process and seam scope. The
existing cut-over seams constrain dispatch when a registered context is present;
no context is registered anywhere by default, so default launch behavior remains
unchanged. The bridge source guard is not resource confinement: it still passes
control effect and no targets. No live provider-wire test or full LC row is claimed.

Latest source-provenance increment verification: 942 pass / 0 fail across 96 files
(`bun test test/task/ test/orchestration/ test/operational/ test/revamp/
test/eval/agent-bridge.test.ts test/core/js-tool-bridge.test.ts
test/core/python-tool-bridge.test.ts test/agent-session-mcp-discovery.test.ts
test/tools/tool-profile-integration.test.ts test/sdk-tool-activation.test.ts
test/sdk-mcp-auto-discovery.test.ts`, from `packages/coding-agent`). Coverage
includes source collisions and unknown-source denial before execution, the real
shared HTTP transport with cancellation-signal preservation, MCP/RPC replacement
and removal, custom-over-extension SDK registration, and real nondeferred MCP
startup through the custom-tool adapter. These are transport/registry tests, not
separate live Python/Ruby/Julia interpreter acceptance or LC07 completion.

Authority snapshot hardening follow-up: 37 pass / 0 fail across
`test/orchestration/lifecycle-authority.test.ts`, `test/core/js-tool-bridge.test.ts`,
`test/core/python-tool-bridge.test.ts`, and `test/revamp/launch-entrypoints-contract.test.ts`;
`bun run check` passes. This verifies immutable registration, not store-backed
revocation propagation or completion of the canonical dispatch wrapper.

Revoked-parent derivation follow-up: the invalid-parent helper regression and
the real TaskTool preparation path both deny rather than launching an unscoped
child. The TaskTool regression revokes the parent after its initial synchronous
admission and asserts no subprocess allocation (6 entry-point tests pass).
Revocation of already-minted descendants remains a separate W5 requirement.

Historical guard checkpoint: **954 pass / 0 fail across 97 files** plus a
historical `bun run check` pass. The focused regressions covered denial around
approval/hooks, revocation in a hook, source mismatch, missing runners, stale
MCP/RPC handles, and direct SDK tools. `approval-mode.test.ts` passed 9/9 after
the fixture took explicit ownership of its `AuthStorage`. Preserve that
fixture-scoped ownership fix; this receipt does not certify later overlays.

Historical dispatch/projection/binding checkpoint: **1014 pass / 0 fail across
102 files** plus a historical `bun run check` pass. It remains valid evidence
for that earlier candidate and covered action/effect/target derivation, caller
binding seams, resolve-existing revival, scoped eval-kernel selection, and
provider-projection seams. It did not certify complete W3 scheduling,
authenticated provenance, measured adapter guarantees, or LC01–LC24.

Later reviewed union receipt: **1035 pass / 2 fail, 1037 tests across 104
files**. This is a failed union: a same-contract multi-process admission race
reported disk-I/O failures, and the native missing-binding fixture failed EBUSY
cleanup. Isolated reruns are diagnostic only. No matched baseline differential
was captured for Redis/SQL failures, so any claim that they are pre-existing is
unverified. The exact leaking owner behind teardown failure must be diagnosed,
not inferred from the symptom. Neither this failed receipt nor either historical
green checkpoint certifies the current dirty candidate.

## W4 — capture and publication (closed on union candidate)

| Scope | Status | Evidence |
|---|---|---|
| Implemented source | Done | `captureLifecycleArtifacts` persists root/nested patches, raw output/result/transcript, manifest + manifest-ref pointer atomically with permit gating; `publishLifecycleCandidate` is a real fenced publisher (durable claim/renew/journal/finalize on `lifecycle_publications`, per-effect lease + before-image rechecks, real `git apply` effects, crash-restart reconciliation of pending rows with journals); `publishWithEffects`/`PublicationStageEffects` removed; isolation-runner passes lifecycle identity + cleanup permit, quarantines on capture failure, disposes permits before cleanup |
| Focused verification | Done | `lifecycle-publisher.test.ts` 6 real temp-Git + real SQLite tests (integrated/partial-by-divergence/conflicted/lease-never-stolen/apply=false/rejection) — durable rows and journals asserted, workspace bytes observed; `lc-d-gate-capture-publish.test.ts` D-gate real root+nested Git capture and publication; `publication-recovery.test.ts` recovery taxonomy |
| **W4 wave acceptance** | **Closed on union candidate** | Proven by the final union receipt above (1090/0 across 106 files): capture-before-cleanup, acknowledgement-governed disposal, controller-fenced publication with staged journals, nested partial outcomes, exact-before/exact-after restart reconciliation, and never-steal lease semantics all have focused tests inside the passing union. W5–W7 remain inactive; default-off rollout state unchanged |

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
