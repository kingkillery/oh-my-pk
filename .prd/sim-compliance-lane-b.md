# Lane B — SIM CLI Workflow & CLI Tests [parallel-builder]

## 1. Mission + read-first

You are the Lane B `[parallel-builder]` sub-agent for `oh-my-pk` at `C:/dev/infra/oh-my-pk`. Upgrade `scripts/sim/cli.ts` to implement the full Appendix D.1/D.3 + OMPK-RSI §24.1 CLI workflow (`predict`, `carry`, strict §3.2 `record`, baseline-aware 8-state attribution, and `status` provenance display) and author end-to-end CLI tests in `scripts/sim/cli.test.ts`.

**Read first** (each in full):
- `.prd/sim-compliance-orchestration.md` — pipeline context, 8-state table, and acceptance checklist
- `.prd/sim-compliance-lane-a.md` — exact upstream contracts from `scripts/sim/schema.ts` and `scripts/sim/manifest.ts`
- `scripts/sim/schema.ts` — finalized Lane A exports
- `scripts/sim/manifest.ts` — finalized Lane A manifest API
- `scripts/sim/cli.ts` — existing CLI implementation

## 2. Owned files

You may ONLY edit or create these files:
- `scripts/sim/cli.ts` (existing)
- `scripts/sim/cli.test.ts` (new)

You may NOT edit any other file, including `scripts/sim/schema.ts`, `scripts/sim/manifest.ts`, `scripts/sim/sim.test.ts`, `scripts/sim/replay.ts`, `package.json`, `.omp/sim.json`, `.agents/*`, or anything under `packages/coding-agent/`.

## 3. Gap (verbatim from the table)

> B — SIM CLI Workflow & CLI Tests: Add `predict` subcommand writing pre-eval manifest & require/consume pending manifest in `record` unless explicit `--backfilled true --allow-ad-hoc` (G1); add `carry` subcommand & print `carried_from` + `benchmarks` in `status` text/JSON (G2, G6); enforce §3.2 no-op on `.omp/sim.json` when `--accepted false` while writing `SimRejectedCandidateLogEntry` to `--rejected-log` / `.omp/sim-rejected.jsonl` (G3, FR-007); expose `--sample`, `--backfilled`, `--benchmark`, `--run`, `--baseline-ref`, `--candidate-ref` on `record` (G4, G6, G8, §24.1); pass baseline to `evaluateReplayDiff()` for BOTH live replay and `--replay-json` and persist 8-state fields (G5, §24.1); add `scripts/sim/cli.test.ts` covering all CLI flows + RSI-01/02/03/21. (0% complete) [MEDIUM] depends on: A | files: `scripts/sim/cli.ts`, `scripts/sim/cli.test.ts`

## 4. What to build

### 4.1 `scripts/sim/cli.ts`
Preserve existing exported `runSimCli(argv: string[]): Promise<number>` and existing subcommands (`replay`, `validate`, `status`, `merge`, `record`, `cases`), and add/upgrade:

1. **`predict` subcommand (`cmdPredict` — G1):**
   - Flags:
     - `--problem <P#|new>` (required; `"new"` requires `--name`)
     - `--name <text>` (required when `--problem new`)
     - `--predicted <id1,id2>` (required, non-empty, verified against known `SIM_REPLAY_CASES` IDs unless `--allow-unknown-cases` is set)
     - Optional: `--baseline <path>` (loads baseline JSON, records `baseline_path`, `baseline_model`, `baseline_passed_ids`, `baseline_failed_ids`, and warns/rejects if any predicted ID is ALREADY passing in the baseline unless `--allow-preserved` is passed), `--what`, `--files`, `--model`, `--domain`, `--benchmark`, `--sample`, `--round`, `--manifest <path>` (default `DEFAULT_MANIFEST_PATH`), `--force` (overwrite an unconsumed pending manifest), `--json`.
   - Calls `createChangeManifest()` + `writeChangeManifest()`.
   - Refuses to silently overwrite an existing `status: "pending"` manifest unless `--force` is passed.
   - Prints manifest path, `manifest_id`, `problem`, `predicted`, and `prediction_hash` (or JSON when `--json`).

2. **`carry` subcommand (`cmdCarry` — G2 & G8):**
   - Flags: `--arm <src>` (required), `--domain <d>` (required), `--into <target-run>` (required), optional `--benchmark <b>`, `--model <m>`, `--ledger <path>` (default `.omp/sim.json`), `--json`.
   - Loads ledger, calls `carryForwardSimLedger()`, validates with `validateSimLedger()`, persists formatted JSON, and prints the new `carried_from` metadata and next round (`1` for the new `into` run).

3. **`status` subcommand (`cmdStatus` — G2 & G6):**
   - Display `schema_version`, `carried_from` (`arm`, `domain`, `into`, plus optional `benchmark`/`model`/`carried_at` when present), and per-problem `benchmarks` alongside `domains` and `models` in both human-readable and `--json` output.

4. **`record` subcommand (`cmdRecord` — G1, G3, G4, G5, G6, G8, §24.1):**
   - **Pre-eval manifest enforcement (G1):**
     - By default, read and validate pending manifest from `--manifest <path>` (default `DEFAULT_MANIFEST_PATH`).
     - Fail with non-zero exit if manifest is missing, already `"consumed"`, fails `validateChangeManifest()` (tampered `prediction_hash`), or if `--problem` / `--predicted` passed on CLI contradict the manifest.
     - Allow bypassing the manifest **only** when BOTH `--backfilled true` AND `--allow-ad-hoc` are explicitly passed (for historical backfills).
     - Pull default `problem`, `name`, `predicted`, `what`, `files`, `model`, `domain`, `benchmark`, `sample`, `baseline` from the manifest when not explicitly overridden (never allow overriding `problem`/`predicted` to diverge from manifest).
   - **Baseline-aware 8-state evaluation (G5, §24.1, RSI-01/02/03/21):**
     - Pass baseline (from `--baseline <path>` or embedded manifest `baseline_passed_ids`/`baseline_failed_ids`) to `evaluateReplayDiff(report, predicted, baseline, { candidateModel: model })` for **BOTH** live replay and `--replay-json <file>`.
     - Fail with non-zero exit if `diff.model_mismatch` is detected (RSI-21: baseline and candidate model differ).
     - Persist `benchmark`, `regressed`, `preserved`, `unresolved`, `unproven`, `incomplete`, `sample`, `backfilled`, `run`, `baseline_ref`, `candidate_ref` onto the attempt.
     - Accept optional flags `--benchmark`, `--sample` (defaulting to `s<round>` when omitted on live non-backfilled runs), `--backfilled <true|false>`, `--run <id>`, `--baseline-ref <ref>`, `--candidate-ref <ref>`, `--rejected-log <path>` (default `.omp/sim-rejected.jsonl`), `--no-rejected-log`.
   - **Strict §3.2 chosen-candidate recording + negative-experience log (G3, FR-007):**
     - When `--accepted false`:
       - Call `appendSimAttempt()` (returns `{ recorded: false }`); do **NOT** modify `.omp/sim.json`.
       - Unless `--no-rejected-log` is passed, append one JSON line (`SimRejectedCandidateLogEntry`) to `--rejected-log` (default `.omp/sim-rejected.jsonl`).
       - Mark the pending manifest consumed (if used).
       - Exit `0` with clear `[NO-OP §3.2]` output stating `.omp/sim.json` was unchanged and where the rejected candidate was logged.
     - When `--accepted true`:
       - Call `appendSimAttempt()`, validate resulting ledger via `validateSimLedger()`, write `.omp/sim.json`, and mark the pending manifest consumed.

5. **`replay` subcommand (`cmdReplay`):**
   - Add optional `--model <id>` flag so saved baseline JSON (`--save <file>`) can record `model` for RSI-21 comparison checks without breaking existing `--json` consumers.

### 4.2 `scripts/sim/cli.test.ts` (new)
Write focused end-to-end CLI tests using isolated `mkdtemp` directories (passing `--ledger`, `--manifest`, `--rejected-log`, `--baseline`, `--replay-json` — NEVER mutating repo `.omp/sim.json` or `.omp/sim-manifest.json`):
1. `predict` -> `replay` -> `record` full lifecycle with failing baseline -> passing candidate (`fixed` populated, manifest transitions `pending` -> `consumed`, ledger validates).
2. `record` without pending manifest fails (non-zero exit); consumed manifest fails; tampered `prediction_hash` fails; mismatched `--predicted` fails; `--backfilled true --allow-ad-hoc` succeeds.
3. RSI-02 (`PASS -> PASS` baseline): `predict --baseline` rejects predicting already-passing case unless `--allow-preserved`, and `record --baseline` puts it in `preserved` (never `fixed`).
4. RSI-03 (missing baseline): `record` without baseline places predicted cases in `unproven` (0 `fixed`).
5. RSI-21 (baseline model != candidate model): `record` rejects mismatched model comparison with non-zero exit.
6. Regression tracking with `--replay-json` + `--baseline`: `PASS -> FAIL` lands in `regressed` (and `missed` if predicted) and persists on the attempt.
7. §3.2 `record --accepted false`: exits `0`, leaves temp `.omp/sim.json` **byte-identical**, marks manifest consumed, and appends a valid `SimRejectedCandidateLogEntry` JSONL line to `--rejected-log`.
8. `carry` -> `status` -> `predict` -> `record`: sets `carried_from`, `status --json` reports `carried_from` and `benchmarks`, and next recorded attempt restarts at `round: 1` with `run === carried_from.into` even on the same domain.
9. `--sample`, `--backfilled`, `--benchmark`, `--baseline-ref`, `--candidate-ref` persist accurately and pass `validateSimLedger()`.

## 5. Hard constraints

1. No new npm dependencies.
2. Zero inline type-cast member access (`(x as { foo?: unknown }).foo`).
3. No edits outside `scripts/sim/cli.ts` and `scripts/sim/cli.test.ts`. Verify via `git diff --name-only`.
4. Do NOT mutate repo `.omp/sim.json`, `.omp/sim-manifest.json`, or `.omp/sim-rejected.jsonl` in tests.
5. **Worktree `node_modules` rule:** If running in a fresh git worktree where `node_modules` does not exist, do **NOT** run `bun install`, `bun test`, or commands requiring `node_modules` inside the worktree — just produce clean code and report `deferred to post-merge orchestrator` in Section 8. If `node_modules` IS present, run the Section 6 commands.
6. Skip project-wide build/lint/test commands; main orchestrator runs them once post-merge.

## 6. Verification

If `node_modules` is available in your checkout (otherwise defer to post-merge orchestrator and verify `git diff --name-only` only):
```bash
bun test scripts/sim/cli.test.ts
bunx biome check scripts/sim/cli.ts scripts/sim/cli.test.ts
git diff --name-only
```

Expected:
- `bun test scripts/sim/cli.test.ts` exits `0` (all CLI + RSI-01/02/03/21 cases pass).
- `biome check` exits `0`.
- `git diff --name-only` + `git status --short` list ONLY `scripts/sim/cli.ts` and `scripts/sim/cli.test.ts`.

## 7. Commit message

`feat(sim): add predict, carry, baseline-aware record, and CLI tests (Gap B)`

## 8. Final report

Fill in and return at the end of your response:
```
### Lane B final report
- Worktree path / branch:
- Files modified / created:
- Public exports added (signatures):
- @ts-expect-error suppressors added (count + which imports): none
- Lines added / removed:
- Verification:
  - bun test scripts/sim/cli.test.ts exit: ___ (or deferred — no node_modules)
  - biome check exit: ___ (or deferred — no node_modules)
  - git diff --name-only: ___
- Flags / blockers:
```
