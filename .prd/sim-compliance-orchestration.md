# SIM Paper Compliance & OMPK-RSI PR-01 — Orchestration Overview

## 1. Purpose

Close all 8 [arXiv:2611.18856v1](https://arxiv.org/html/2611.18856v1) Self-Improvement Memory (SIM) compliance gaps (`G1`–`G8`, audited against baseline commit `79d58ae68d`) **and** deliver **OMPK-RSI PR-01 (§24.1 Evidence Integrity + §24.2 Hardened SIM Context Injection)** in a single coordinated 5-lane dispatch.

Unifying both scopes prevents touching `scripts/sim/*`, `.omp/sim.*`, and `packages/coding-agent/src/utils/sim-ledger.ts` twice:
- **G1 (Pre-eval prediction manifest):** Two-phase `sim:predict` -> `sim:replay` -> `sim:record` flow backed by a SHA-256 hashed change manifest (`scripts/sim/manifest.ts`).
- **G2 & G8 (Carry-forward & per-run rounds):** `sim:carry` subcommand populating `carried_from` and scoping `computeNextRound()` per `run` across carry-forward boundaries.
- **G3 (§3.2 vs OMPK-RSI P5/FR-007 reconciliation):** Keep `.omp/sim.json` strictly §3.2-compliant (only chosen edits `accepted: true` mutate `.omp/sim.json`; `e_t = ∅ => U(M_t, ∅) = M_t`), while writing rejected candidates (`accepted: false`) as structured JSONL records to `.omp/sim-rejected.jsonl` so negative experience is preserved without polluting SIM prompt context.
- **G4 & G6 (Provenance completeness):** Expose `--sample`, `--backfilled`, `--benchmark`, `--run` in the CLI, require `benchmark` on every attempt, restore Appendix D.2 rules 2 & 8 to `domain + benchmark + model`, and upgrade seeded `P1`–`P6`.
- **G5 + OMPK-RSI §24.1 (8-state baseline-to-candidate attribution + schema versioning):** Bump ledger `schema_version: 2`, implement the full 8-state matrix (`fixed`, `preserved`, `regressed`, `unresolved`, `unproven`, `incomplete`), never classify already-passing or baseline-missing cases as `fixed`, and preserve legacy `backfilled: true` records without inventing fake baselines.
- **G7 + OMPK-RSI §24.2 + Principle P9 (Hardened context injection & freedom within constraints):** Strict schema allowlist validation in both `scripts/sim/schema.ts` and `packages/coding-agent/src/utils/sim-ledger.ts`, explicit untrusted-data framing in `sim-context.md` (ledger entries are experiential data, not authorization/policy authority), configurable deterministic context-budget pruning (no vector DB), and rules that constrain experimental contracts/evidence without over-prescribing the agent's internal discovery algorithm.

Parallel dispatch is justified because work spans 16 files across 3 independent subsystems (SIM CLI, `packages/coding-agent` runtime/prompts/rules, and read-only contract verification) with a clean `[pre-phase]` contract layer and a clean `[acceptance-gate]` binary-rebuild/integration layer.

---

## 2. Letter-group dispatch table

| Letter | Lane | Archetype | Effort | Depends on | File |
|---|---|---|---|---|---|
| A | Schema, Manifest, 8-State Attribution & Seed Foundation | `[pre-phase]` | MEDIUM | none | `.prd/sim-compliance-lane-a.md` |
| B | SIM CLI Workflow (`predict`, `carry`, strict `record`, `status`) & CLI Tests | `[parallel-builder]` | MEDIUM | A | `.prd/sim-compliance-lane-b.md` |
| C | Runtime Loader Hardening, Prompt Template & Maintenance Rules | `[parallel-builder]` | MEDIUM | A | `.prd/sim-compliance-lane-c.md` |
| D | Paper-Invariant, RSI PR-01 & Contract Verifier | `[parallel-verifier]` | SMALL | A | `.prd/sim-compliance-lane-d.md` |
| E | Package Wiring, Docs, Binary Rebuild & Acceptance Gate | `[acceptance-gate]` | MEDIUM | A, B, C, D | `.prd/sim-compliance-lane-e.md` |

### `[A to Z Gaps]` (Verbatim)

| Letter | Name | Archetype | Remaining Work & Gap Mapping (G1–G8 + RSI PR-01) | Effort | Depends On | Files |
|---|---|---|---|---|---|---|
| A | Schema, Manifest, 8-State Attribution & Seed Foundation | `[pre-phase]` | Add `schema_version: 2` + `benchmark`, `regressed`, `preserved`, `unresolved`, `unproven`, `incomplete`, `baseline_ref`, `candidate_ref`, `run` to `.omp/sim.schema.json` & `scripts/sim/schema.ts` (G5, G6, G7, G8, §24.1); add `scripts/sim/manifest.ts` pre-eval change manifest (G1); add `carryForwardSimLedger()` & per-run `computeNextRound()` (G2, G8); enforce §3.2 `accepted: false` no-op in `appendSimAttempt` & `validateSimLedger` + export `SimRejectedCandidateLogEntry` (G3, P5); implement 8-state baseline-to-candidate `evaluateReplayDiff()` (G5, §24.1); tighten `validateSimLedger()` to full allowlist + optional-type parity with `.omp/sim.schema.json` (G7); upgrade `.omp/sim.json` `P1`–`P6` with `schema_version: 2`, `benchmark`, `sample`, `regressed: []` (G4, G5, G6); fix inline `attempts: []` fixture in `scripts/sim/replay.ts:365-376`. (0% complete) | MEDIUM | none | `.omp/sim.schema.json`, `.omp/sim.json`, `scripts/sim/schema.ts`, `scripts/sim/manifest.ts`, `scripts/sim/replay.ts` |
| B | SIM CLI Workflow & CLI Tests | `[parallel-builder]` | Add `predict` subcommand writing pre-eval manifest & require/consume pending manifest in `record` unless explicit `--backfilled true --allow-ad-hoc` (G1); add `carry` subcommand & print `carried_from` + `benchmarks` in `status` text/JSON (G2, G6); enforce §3.2 no-op on `.omp/sim.json` when `--accepted false` while writing `SimRejectedCandidateLogEntry` to `--rejected-log` / `.omp/sim-rejected.jsonl` (G3, FR-007); expose `--sample`, `--backfilled`, `--benchmark`, `--run`, `--baseline-ref`, `--candidate-ref` on `record` (G4, G6, G8, §24.1); pass baseline to `evaluateReplayDiff()` for BOTH live replay and `--replay-json` and persist 8-state fields (G5, §24.1); add `scripts/sim/cli.test.ts` covering all CLI flows + RSI-01/02/03/21. (0% complete) | MEDIUM | A | `scripts/sim/cli.ts`, `scripts/sim/cli.test.ts` |
| C | Runtime Loader Hardening, System Prompt & Harness Rules | `[parallel-builder]` | Replace shallow `isSimLedgerShape()` in `packages/coding-agent/src/utils/sim-ledger.ts` with strict self-contained Appendix D.3 validator (zero `as` member casts, zero root `scripts/` imports) + configurable context budget (`maxChars`) with deterministic provenance-preserving fallback pruning (G6, G7, §24.2); update `packages/coding-agent/src/prompts/system/sim-context.md` with D.2 rules 2 & 8 (`domain + benchmark + model`), explicit untrusted-data framing (SEC-007), Principle P9 framing (constraints without prescribing reasoning), and `predict`/`record`/`carry` commands (G1, G2, G3, G6, §24.2); update `.agents/rules/harness-sim.md` identically; expand `packages/coding-agent/test/system-prompt-sim.test.ts` with strict validation, untrusted-data framing, and budget-pruning tests. (0% complete) | MEDIUM | A | `packages/coding-agent/src/utils/sim-ledger.ts`, `packages/coding-agent/src/prompts/system/sim-context.md`, `.agents/rules/harness-sim.md`, `packages/coding-agent/test/system-prompt-sim.test.ts` |
| D | Paper-Invariant, RSI PR-01 & Contract Verifier | `[parallel-verifier]` | Read-only verification of Lane A contracts & invariants in `scripts/sim/sim.test.ts`: 8-state attribution matrix (RSI-01, RSI-02, RSI-03, RSI-21 + FAIL->FAIL, PASS->FAIL, UNKNOWN->FAIL, PASS/FAIL->UNKNOWN), strict schema allowlist & optional-field parity vs `.omp/sim.schema.json` (G7), manifest creation/hash-tamper/consumption (G1), `carryForwardSimLedger` & per-run `computeNextRound` (G2, G8), §3.2 `accepted: false` refusal (G3), legacy `backfilled: true` compatibility & `.omp/sim.json` `P1`–`P6` checks (G4, G6); remove legacy `runSimCli` block from `sim.test.ts` (moved to B's `cli.test.ts`); emit `.prd/findings-D.md`. (0% complete) | SMALL | A | `scripts/sim/sim.test.ts`, `.prd/findings-D.md` |
| E | Package Wiring, Docs, Binary Rebuild & Acceptance Gate | `[acceptance-gate]` | Add `sim:predict`, `sim:carry`, and `scripts/sim/cli.test.ts` (in `test:scripts`) to `package.json` (G1, G2); update `## Self-Improvement Memory (SIM)` in `.agents/instructions.md` (G1–G3, G6, §24.1); fold any actionable findings from `.prd/findings-D.md` and delete `.prd/findings-D.md`; rebuild `packages/coding-agent` binaries & manifest (`build` + `check:dist`); run full repo verification suite and commit `.prd/sim-compliance-report.md`. (0% complete) | MEDIUM | A, B, C, D | `package.json`, `.agents/instructions.md`, `packages/coding-agent/build-manifest.json`, `packages/coding-agent/dist/{oh-my-pk,omp,ompk}.exe`, `packages/coding-agent/src/extensibility/plugins/legacy-pi-bundled-{keys,registry}.ts`, `.prd/sim-compliance-report.md` |

---

## 3. 5-row dispatch table (operational form)

| Lane | Gap letters | Owned files | Effort | Model | Subagent | Isolation | Depends on | Verify commands |
|---|---|---|---|---|---|---|---|---|
| A | A (G1–G8, §24.1 contracts) | `.omp/sim.schema.json`, `.omp/sim.json`, `scripts/sim/schema.ts`, `scripts/sim/manifest.ts`, `scripts/sim/replay.ts` | MEDIUM | slow / high | `task` | main checkout (solo pre-phase) | none | `bun run sim:validate`, `bun run sim:replay --json`, `biome check` |
| B | B (G1–G6, G8, §24.1 CLI) | `scripts/sim/cli.ts`, `scripts/sim/cli.test.ts` | MEDIUM | task / medium | `task` | worktree (defer `bun` if no `node_modules`) | A | `git diff --name-only` (+ `bun test scripts/sim/cli.test.ts` post-merge) |
| C | C (G1–G3, G6, G7, §24.2) | `packages/coding-agent/src/utils/sim-ledger.ts`, `packages/coding-agent/src/prompts/system/sim-context.md`, `.agents/rules/harness-sim.md`, `packages/coding-agent/test/system-prompt-sim.test.ts` | MEDIUM | slow / high | `task` | worktree (defer `bun` if no `node_modules`) | A | `git diff --name-only` (+ `bun test`, `format-prompts`, `check:types` post-merge) |
| D | D (G1–G8, RSI-01/02/03/21 verify) | `scripts/sim/sim.test.ts`, `.prd/findings-D.md` | SMALL | task / medium | `oracle` or `task` (`role: "Paper-invariant verifier"`) | worktree (read-only on src; defer `bun` if no `node_modules`) | A | `git diff --name-only` (+ `bun test scripts/sim/sim.test.ts` post-merge) |
| E | E (Integration & Gate) | `package.json`, `.agents/instructions.md`, `packages/coding-agent/build-manifest.json`, `packages/coding-agent/dist/*.exe`, `packages/coding-agent/src/extensibility/plugins/legacy-pi-bundled-{keys,registry}.ts`, `.prd/sim-compliance-report.md` | MEDIUM | slow / high | `task` (`role: "Acceptance verifier"`) | main checkout (solo post-merge) | A, B, C, D | `build`, `check:dist`, `sim:validate`, `sim:replay`, `test:scripts`, `system-prompt-sim.test.ts`, `format-prompts --check`, `check:types`, `biome check` |

---

## 4. File-ownership matrix

| File | Lane A | Lane B | Lane C | Lane D | Lane E |
|---|---|---|---|---|---|
| `.omp/sim.schema.json` | own | – | – | – | – |
| `.omp/sim.json` | own | – | – | – | – |
| `scripts/sim/schema.ts` | own | – | – | – | – |
| `scripts/sim/manifest.ts` (new) | own | – | – | – | – |
| `scripts/sim/replay.ts` | own | – | – | – | – |
| `scripts/sim/cli.ts` | – | own | – | – | – |
| `scripts/sim/cli.test.ts` (new) | – | own | – | – | – |
| `packages/coding-agent/src/utils/sim-ledger.ts` | – | – | own | – | – |
| `packages/coding-agent/src/prompts/system/sim-context.md` | – | – | own | – | – |
| `.agents/rules/harness-sim.md` | – | – | own | – | – |
| `packages/coding-agent/test/system-prompt-sim.test.ts` | – | – | own | – | – |
| `scripts/sim/sim.test.ts` | – | – | – | own | – |
| `.prd/findings-D.md` (scratch) | – | – | – | own (create) | own (fold & delete) |
| `package.json` | – | – | – | – | own |
| `.agents/instructions.md` | – | – | – | – | own |
| `packages/coding-agent/build-manifest.json` | – | – | – | – | own (generated) |
| `packages/coding-agent/dist/{oh-my-pk,omp,ompk}.exe` | – | – | – | – | own (generated) |
| `packages/coding-agent/src/extensibility/plugins/legacy-pi-bundled-{keys,registry}.ts` | – | – | – | – | own (generated) |
| `.prd/sim-compliance-report.md` (new) | – | – | – | – | own |

**Disjointness proof:** `B ∩ C = ∅`, `B ∩ D = ∅`, `C ∩ D = ∅`. Zero `@ts-expect-error` bridges required because Lane A lands every shared type and helper before parallel dispatch begins.

**Git preflight (verified on baseline `79d58ae68d`):**
- `git config core.longpaths` is `true`.
- All 12 existing owned files are tracked in `git ls-files`.
- External worktrees MUST be created outside nested artifact directories (e.g., `../_wt-sim-lane-{b,c,d}`). Because fresh worktrees do not have `node_modules`, Lanes B, C, and D defer `bun` commands to post-merge orchestrator verification unless the orchestrator explicitly binds `node_modules`.

---

## 5. Execution sequence

1. **Pre-phase (Lane A solo):** Dispatch Lane A against the main checkout (or dedicated branch). Wait for completion, verify `bun run sim:validate`, `bun run sim:replay --json`, and `biome check` on Lane A files, then commit and fast-forward into the base branch before creating parallel worktrees.
2. **Parallel fan-out (Lanes B, C, D in one message):** Create three worktrees (`../_wt-sim-lane-b`, `../_wt-sim-lane-c`, `../_wt-sim-lane-d`) from the post-A commit. Launch Lanes B, C, and D in **one assistant turn** as three parallel `task` calls. Wait for all three to complete.
3. **Sequential merge & cleanup:** Merge `lane-b`, `lane-c`, and `lane-d` sequentially (`git merge --no-ff`) into the integration branch (conflict-free by empty file-ownership intersection). Remove worktrees. Run intermediate smoke checks (`bun test scripts/sim/sim.test.ts scripts/sim/cli.test.ts packages/coding-agent/test/system-prompt-sim.test.ts`) and resolve any drift flagged in `.prd/findings-D.md`.
4. **Acceptance gate (Lane E solo):** Dispatch Lane E against the merged checkout. Lane E updates `package.json` and `.agents/instructions.md`, folds and deletes `.prd/findings-D.md`, rebuilds `packages/coding-agent` binaries & manifest, runs the full verification suite, and writes `.prd/sim-compliance-report.md`.

---

## 6. Acceptance criteria checklist

- [ ] **G1 (Pre-eval prediction manifest):** `scripts/sim/manifest.ts` computes SHA-256 `prediction_hash` over `{ problem, name, predicted }`; `scripts/sim/cli.test.ts` proves `predict` -> `replay` -> `record` succeeds while missing, already-consumed, or tampered manifests fail.
- [ ] **G2 & G8 (Carry-forward & per-run rounds):** `scripts/sim/schema.ts` (`carryForwardSimLedger`, `computeNextRound`) and `scripts/sim/cli.test.ts` prove `sim:carry` populates `carried_from`, `sim:status` displays it, and rounds restart at `1` for the new `run` even on same-domain cross-model transitions.
- [ ] **G3 + OMPK-RSI P5/FR-007 (Strict §3.2 ledger + negative-experience log):** `scripts/sim/sim.test.ts` and `scripts/sim/cli.test.ts` prove `--accepted false` leaves `.omp/sim.json` byte-identical (`recorded: false`) while appending a structured `SimRejectedCandidateLogEntry` to `--rejected-log` / `.omp/sim-rejected.jsonl`, and `validateSimLedger()` rejects `accepted: false` inside `.omp/sim.json`.
- [ ] **G4 & G6 (Complete provenance):** `.omp/sim.json` (`P1`–`P6`) includes `schema_version: 2`, non-empty `benchmark`, `sample`, `regressed: []`, and `backfilled: true`; `scripts/sim/cli.test.ts` verifies `--benchmark`, `--sample`, `--backfilled`, and `--run`.
- [ ] **G5 + OMPK-RSI §24.1 (8-state attribution & RSI-01/02/03/21):** `scripts/sim/sim.test.ts` and `scripts/sim/cli.test.ts` verify every row of the 8-state table (`fixed`, `preserved`, `regressed`, `unresolved`, `unproven`, `incomplete`), prove already-passing and missing-baseline cases are never classified as `fixed`, prove baseline/candidate model mismatch invalidates comparison (RSI-21), and preserve `backfilled: true` legacy entries without inventing baselines.
- [ ] **G7 + OMPK-RSI §24.2 (Strict validation & hardened context injection):** `packages/coding-agent/test/system-prompt-sim.test.ts` proves `loadSimLedger()` rejects unknown keys, invalid optional field types, `accepted: false`, missing `benchmark`/`regressed`, and broken aliases (with zero inline `as` member casts), frames ledger text as untrusted experiential data (SEC-007), enforces deterministic budget pruning when `maxChars` is exceeded, and preserves block-0 prompt caching and terminal Fusion placement.
- [ ] **D.2 & Principle P9 prompts/rules:** `packages/coding-agent/src/prompts/system/sim-context.md` and `.agents/rules/harness-sim.md` encode `domain + benchmark + model` in rules 2 & 8, document `predict`/`carry`/`record` and §3.2 rejection handling, and enforce experimental/evidence constraints without prescribing internal discovery heuristics.
- [ ] **Repo gates & artifacts:** `bun run sim:validate`, `bun run sim:replay --json` (16/16), `bun run test:scripts`, `bun test packages/coding-agent/test/system-prompt-sim.test.ts`, `bun --cwd=packages/coding-agent run format-prompts -- --check`, `bun --cwd=packages/coding-agent run check:types`, `bun --cwd=packages/coding-agent run check:dist`, and `biome check` on all touched files exit `0`; `.prd/findings-D.md` is deleted; `.prd/sim-compliance-report.md` is committed.
