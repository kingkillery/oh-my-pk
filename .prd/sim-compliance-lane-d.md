# Lane D — Paper-Invariant, RSI PR-01 & Contract Verifier [parallel-verifier]

## 1. Mission + read-first

You are the Lane D `[parallel-verifier]` sub-agent for `oh-my-pk` at `C:/dev/infra/oh-my-pk`. Independently verify Lane A's contracts (`.omp/sim.schema.json`, `.omp/sim.json`, `scripts/sim/schema.ts`, `scripts/sim/manifest.ts`, `scripts/sim/replay.ts`) against every arXiv:2611.18856v1 invariant (`G1`–`G8`) and OMPK-RSI PR-01 requirement (`§24.1`, `RSI-01`, `RSI-02`, `RSI-03`, `RSI-21`) by expanding `scripts/sim/sim.test.ts` and emitting a concise scratch report in `.prd/findings-D.md`.

**Read first** (each in full):
- `.prd/sim-compliance-orchestration.md` — pipeline context, 8-state matrix, and acceptance checklist
- `.prd/sim-compliance-lane-a.md` — finalized Lane A contracts to verify
- `.omp/sim.schema.json` — canonical JSON Schema
- `.omp/sim.json` — upgraded seeded ledger (`P1`–`P6`)
- `scripts/sim/schema.ts` — Lane A implementation under verification
- `scripts/sim/manifest.ts` — Lane A manifest module under verification
- `scripts/sim/sim.test.ts` — existing test suite

## 2. Owned files

You may ONLY edit or create these files:
- `scripts/sim/sim.test.ts` (existing)
- `.prd/findings-D.md` (new — temporary scratch fragment ≤80 lines, folded and deleted by Lane E)

You may NOT edit any production or sibling-lane file (`scripts/sim/schema.ts`, `scripts/sim/manifest.ts`, `scripts/sim/cli.ts`, `scripts/sim/cli.test.ts`, `scripts/sim/replay.ts`, `.omp/*`, `packages/*`, `.agents/*`, `package.json`). If you find a defect in Lane A's code, record it in `.prd/findings-D.md` with a failing test assertion — do NOT patch Lane A's files.

## 3. Gap (verbatim from the table)

> D — Paper-Invariant, RSI PR-01 & Contract Verifier: Read-only verification of Lane A contracts & invariants in `scripts/sim/sim.test.ts`: 8-state attribution matrix (RSI-01, RSI-02, RSI-03, RSI-21 + FAIL->FAIL, PASS->FAIL, UNKNOWN->FAIL, PASS/FAIL->UNKNOWN), strict schema allowlist & optional-field parity vs `.omp/sim.schema.json` (G7), manifest creation/hash-tamper/consumption (G1), `carryForwardSimLedger` & per-run `computeNextRound` (G2, G8), §3.2 `accepted: false` refusal (G3), legacy `backfilled: true` compatibility & `.omp/sim.json` `P1`–`P6` checks (G4, G6); remove legacy `runSimCli` block from `sim.test.ts` (moved to B's `cli.test.ts`); emit `.prd/findings-D.md`. (0% complete) [SMALL] depends on: A | files: `scripts/sim/sim.test.ts`, `.prd/findings-D.md`

## 4. What to build

### 4.1 `scripts/sim/sim.test.ts`
First, remove the legacy `runSimCli(["record", ...])` test block so Lane B (`scripts/sim/cli.test.ts`) owns all CLI coverage cleanly without colliding with G1 manifest enforcement.

Then ensure focused, deterministic tests cover every contract invariant below:
1. **Seeded `.omp/sim.json` compliance (G4, G5, G6):**
   - Validates cleanly via `validateSimLedger()`.
   - Has `schema_version: 2`, 6 problems (`P1`–`P6`), and every attempt has non-empty `benchmark`, non-empty `sample`, `regressed: []`, `accepted: true`, and `backfilled: true`.
2. **Strict schema allowlist & parity vs `.omp/sim.schema.json` (G7):**
   - Parse `.omp/sim.schema.json` directly and verify its `required` and `properties` keys for root, `carried_from`, `problem`, and `attempt` match `validateSimLedger()`.
   - Reject unknown keys at every nesting level (root, `carried_from`, `problem`, `attempt`).
   - Reject invalid optional field types (`schema_version: 99`, `backfilled: "yes"`, `sample: 123`, `commit: ""`, `preserved: [42]`, `carried_from.model: ""`).
   - Reject `accepted: false` inside a ledger (G3).
   - Reject `passed > total`, broken alias target, cyclic alias, and `predicted` partition violations.
3. **8-state baseline-to-candidate attribution matrix (G5, §24.1, RSI-01/02/03/21):**
   - Explicitly assert all 8 rows of the OMPK-RSI §24.1 table on `evaluateReplayDiff()`:
     - `FAIL -> PASS` => `fixed` + `newly_passing` (RSI-01)
     - `PASS -> PASS` => `preserved`, NEVER `fixed` (RSI-02)
     - `PASS -> FAIL` => `regressed` (+ `missed` if predicted)
     - `FAIL -> FAIL` => `unresolved` (+ `missed` if predicted)
     - `UNKNOWN -> PASS` => `unproven`, NEVER `fixed`
     - `UNKNOWN -> FAIL` => `unproven`
     - `PASS -> UNKNOWN` & `FAIL -> UNKNOWN` => `incomplete`
   - Assert missing `baseline === undefined` puts all predicted IDs in `unproven` with `fixed: []` (RSI-03).
   - Assert `baseline.model !== candidateModel` sets `model_mismatch` and puts all predicted IDs in `unproven` with `fixed: []` (RSI-21).
   - Assert exact disjoint partition: `fixed ⊔ missed ⊔ preserved ⊔ unproven ⊔ incomplete === predicted`.
4. **Pre-eval manifest integrity (G1):**
   - `createChangeManifest()` rejects empty `predicted`, duplicate `predicted`, and `problem: "new"` without `name`.
   - `validateChangeManifest()` passes fresh manifests and rejects any post-hoc edit to `predicted`, `problem`, or `name` (hash mismatch), unknown keys, or invalid status.
   - `markManifestConsumed()` transitions `pending -> consumed` and records `consumed_at`.
5. **§3.2 chosen-candidate recording (G3):**
   - `appendSimAttempt()` with `accepted: false` returns `{ recorded: false }`, leaves input ledger unmodified, and creates no new problem or ID bump.
6. **Carry-forward & per-run round scoping (G2, G8):**
   - `carryForwardSimLedger()` sets `carried_from` while preserving existing problems/aliases/`next_id`.
   - `computeNextRound()` restarts at `1` for the new `into` run even when domain and benchmark match source attempts, then increments `2, 3, ...` within that run while stamping `attempt.run = carried_from.into`.
7. **Deterministic exact-text merging & alias resolution (Appendix D.1):**
   - Keep existing exact-text duplicate merging and alias-chain tests green under `schema_version: 2`.
8. **Live 16-case replay smoke (`runSimReplay()`):**
   - Keep assertion that `runSimReplay()` passes all 16 cases (including updated `system-prompt-sim-and-prefix-stability` fixture).

### 4.2 `.prd/findings-D.md` (new, ≤80 lines)
Write a concise fixed-structure verification fragment for Lane E:
- `## Scope verified` (exact Lane A files inspected)
- `## Invariant checklist` (G1–G8 + RSI-01/02/03/21: PASS / FAIL / DEFERRED-NO-NODE-MODULES)
- `## Defects or edge cases found` (exact `file:line`, or "None — all invariants hold")
- `## Ready for Lane E fold & delete` (`yes` / `blocked`)

## 5. Hard constraints

1. Read-only on all production source files — NEVER edit `scripts/sim/schema.ts`, `scripts/sim/manifest.ts`, `scripts/sim/replay.ts`, or `packages/*`.
2. No new npm dependencies. Zero inline type-cast member access.
3. No edits outside `scripts/sim/sim.test.ts` and `.prd/findings-D.md`. Verify via `git diff --name-only`.
4. **Worktree `node_modules` rule:** If running in a fresh git worktree where `node_modules` does not exist, do **NOT** run `bun install` or `bun test` inside the worktree — author the tests and record `DEFERRED (no node_modules in worktree)` in `.prd/findings-D.md` and Section 8 so the orchestrator runs them post-merge. If `node_modules` IS present, run Section 6 commands.
5. Keep `.prd/findings-D.md` ≤80 lines.

## 6. Verification

If `node_modules` is available in your checkout (otherwise defer to post-merge orchestrator and verify `git diff --name-only` only):
```bash
bun test scripts/sim/sim.test.ts
bunx biome check scripts/sim/sim.test.ts
git diff --name-only
```

Expected:
- `bun test scripts/sim/sim.test.ts` exits `0`.
- `biome check` exits `0`.
- `git diff --name-only` + `git status --short` list ONLY `scripts/sim/sim.test.ts` and `.prd/findings-D.md`.

## 7. Commit message

`test(sim): verify schema v2, 8-state diff, manifest, and paper invariants (Gap D)`

## 8. Final report

Fill in and return at the end of your response:
```
### Lane D final report
- Worktree path / branch:
- Files modified / created:
- Public exports added (signatures): none
- @ts-expect-error suppressors added (count + which imports): none
- Lines added / removed:
- Verification:
  - bun test scripts/sim/sim.test.ts exit: ___ (or deferred — no node_modules)
  - biome check exit: ___ (or deferred — no node_modules)
  - git diff --name-only: ___
- Flags / blockers:
```
