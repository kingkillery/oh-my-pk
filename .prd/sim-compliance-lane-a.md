# Lane A — Schema, Manifest, 8-State Attribution & Seed Foundation [pre-phase]

## 1. Mission + read-first

You are the `[pre-phase]` sub-agent for `oh-my-pk` at `C:/dev/infra/oh-my-pk`. Establish all shared SIM compliance (`G1`–`G8`) and OMPK-RSI PR-01 (`§24.1`) contracts—JSON Schema, strict TypeScript schema/validator/8-state diff engine, pre-evaluation change manifest module, upgraded `.omp/sim.json` seed, and the `scripts/sim/replay.ts` inline fixture fix—so parallel Lanes B, C, and D execute with zero overlap and zero `@ts-expect-error` bridges.

**Read first** (each in full):
- `.prd/sim-compliance-orchestration.md` — pipeline context, 8-state matrix, and acceptance criteria
- `.omp/sim.schema.json` — current draft 2020-12 JSON Schema
- `.omp/sim.json` — current seeded ledger (`P1`–`P6`)
- `scripts/sim/schema.ts` — current TypeScript types, validator, merge, and `evaluateReplayDiff`
- `scripts/sim/replay.ts:355-395` — `system-prompt-sim-and-prefix-stability` inline sample ledger fixture

## 2. Owned files

You may ONLY edit or create these files:
- `.omp/sim.schema.json` (existing)
- `.omp/sim.json` (existing)
- `scripts/sim/schema.ts` (existing)
- `scripts/sim/manifest.ts` (new)
- `scripts/sim/replay.ts` (existing — ONLY lines ~360–380 inline `sampleLedger` fixture)

You may NOT edit any other file, including `scripts/sim/cli.ts`, `scripts/sim/sim.test.ts`, `package.json`, `.agents/*`, or anything under `packages/coding-agent/`.

## 3. Gap (verbatim from the table)

> A — Schema, Manifest, 8-State Attribution & Seed Foundation: Add `schema_version: 2` + `benchmark`, `regressed`, `preserved`, `unresolved`, `unproven`, `incomplete`, `baseline_ref`, `candidate_ref`, `run` to `.omp/sim.schema.json` & `scripts/sim/schema.ts` (G5, G6, G7, G8, §24.1); add `scripts/sim/manifest.ts` pre-eval change manifest (G1); add `carryForwardSimLedger()` & per-run `computeNextRound()` (G2, G8); enforce §3.2 `accepted: false` no-op in `appendSimAttempt` & `validateSimLedger` + export `SimRejectedCandidateLogEntry` (G3, P5); implement 8-state baseline-to-candidate `evaluateReplayDiff()` (G5, §24.1); tighten `validateSimLedger()` to full allowlist + optional-type parity with `.omp/sim.schema.json` (G7); upgrade `.omp/sim.json` `P1`–`P6` with `schema_version: 2`, `benchmark`, `sample`, `regressed: []` (G4, G5, G6); fix inline `attempts: []` fixture in `scripts/sim/replay.ts:365-376`. (0% complete) [MEDIUM] depends on: none | files: `.omp/sim.schema.json`, `.omp/sim.json`, `scripts/sim/schema.ts`, `scripts/sim/manifest.ts`, `scripts/sim/replay.ts`

## 4. What to build

### 4.1 `.omp/sim.schema.json`
Upgrade the draft 2020-12 schema while preserving `additionalProperties: false` on root, `carried_from`, `problem`, and `attempt`:
- Root properties: add optional `"schema_version": { "type": "integer", "enum": [1, 2] }` (v2 is canonical; v1 allowed for legacy read compatibility).
- `carried_from.properties`: keep `required: ["arm", "domain", "into"]`, add optional non-empty strings `benchmark`, `model`, `carried_at`.
- `$defs.attempt`:
  - `required`: `["round", "accepted", "what", "files", "model", "domain", "benchmark", "predicted", "fixed", "missed", "regressed", "passed", "total"]`.
  - Set `"accepted": { "const": true }` (canonical `.omp/sim.json` stores only chosen edits per arXiv:2611.18856 §3.2).
  - Add `"benchmark": { "type": "string", "minLength": 1 }`.
  - Add `"regressed": { "type": "array", "items": { "type": "string", "minLength": 1 }, "uniqueItems": true }`.
  - Add optional arrays of unique non-empty strings: `preserved`, `unresolved`, `unproven`, `incomplete`.
  - Add optional provenance/run strings (minLength 1): `sample`, `run`, `baseline_ref`, `candidate_ref`, `commit`, `timestamp`; keep optional `backfilled: boolean`.

### 4.2 `scripts/sim/schema.ts`
Export the exact contracts below so Lanes B, C, and D need zero bridges:

```ts
export const SIM_SCHEMA_VERSION = 2 as const;
export const SIM_PROBLEM_ID_RE = /^P([1-9][0-9]*)$/;

export interface SimCarriedFrom {
	arm: string;
	domain: string;
	into: string;
	benchmark?: string;
	model?: string;
	carried_at?: string;
}

export interface SimAttempt {
	round: number;
	accepted: true;
	what: string;
	files: string[];
	model: string;
	domain: string;
	benchmark: string;
	predicted: string[];
	fixed: string[];
	missed: string[];
	regressed: string[];
	preserved?: string[];
	unresolved?: string[];
	unproven?: string[];
	incomplete?: string[];
	passed: number;
	total: number;
	sample?: string;
	backfilled?: boolean;
	run?: string;
	baseline_ref?: string;
	candidate_ref?: string;
	commit?: string;
	timestamp?: string;
}

export interface SimProblem {
	id: string;
	name: string;
	opened_round: number;
	attempts: SimAttempt[];
}

export interface SimLedger {
	$schema?: string;
	schema_version?: 1 | 2;
	next_id: number;
	carried_from?: SimCarriedFrom;
	aliases: Record<string, string>;
	problems: SimProblem[];
}

export interface SimReplayBaselineMeta {
	passed_ids: string[];
	failed_ids: string[];
	model?: string;
	evaluator_id?: string;
}

export interface SimReplayDiff {
	predicted: string[];
	fixed: string[];        // predicted: FAIL -> PASS
	missed: string[];       // predicted: known baseline & candidate FAIL (unresolved ∪ regressed among predicted)
	preserved: string[];    // predicted: PASS -> PASS (never counted as fixed)
	regressed: string[];    // ALL suite cases: PASS -> FAIL
	unresolved: string[];   // ALL suite cases: FAIL -> FAIL
	unproven: string[];     // predicted: baseline UNKNOWN (or baseline omitted) -> PASS|FAIL
	incomplete: string[];   // predicted: baseline PASS|FAIL -> candidate UNKNOWN
	newly_passing: string[]; // ALL suite cases: FAIL -> PASS
	model_mismatch?: { baselineModel: string; candidateModel: string };
}
```

Implement/update these exported functions and types:
1. **`evaluateReplayDiff(report, predicted, baseline?, options?)`:**
   - Accepts `baseline?: SimReplayBaselineMeta` and optional `options?: { candidateModel?: string }`.
   - If both `baseline?.model` and `options?.candidateModel` are present and differ (RSI-21), set `model_mismatch` and classify every predicted case as `unproven` (never `fixed`).
   - Otherwise enforce the exact OMPK-RSI §24.1 8-state table for every case:
     - `baseline === undefined`: every predicted ID lands in `unproven` (0 `fixed`, 0 `preserved`, 0 `missed`, 0 `incomplete`) — missing baseline cannot demonstrate a fix (RSI-03).
     - `baseline` present:
       - `FAIL -> PASS`: in `newly_passing`; if predicted, in `fixed` (RSI-01).
       - `PASS -> PASS`: if predicted, in `preserved` (RSI-02, NEVER `fixed`).
       - `PASS -> FAIL`: in `regressed`; if predicted, also in `missed`.
       - `FAIL -> FAIL`: in `unresolved`; if predicted, also in `missed`.
       - `UNKNOWN -> PASS|FAIL`: if predicted, in `unproven` (NEVER `fixed`).
       - `PASS|FAIL -> UNKNOWN`: if predicted, in `incomplete`.
     - Partition invariant on `predicted`: every ID in `predicted` appears in **exactly one** of `{ fixed, missed, preserved, unproven, incomplete }`.
2. **`appendSimAttempt(ledger, input): AppendAttemptResult`:**
   - `AppendAttemptInput` accepts `accepted: boolean`, `benchmark: string`, optional `regressed`, `preserved`, `unresolved`, `unproven`, `incomplete`, `sample`, `backfilled`, `run`, `baseline_ref`, `candidate_ref`, `commit`, `timestamp`.
   - `AppendAttemptResult` is a discriminated union:
     - `{ recorded: true; ledger: SimLedger; problemId: string; createdProblem: boolean; mergedFromAlias?: string }`
     - `{ recorded: false; ledger: SimLedger; createdProblem: false; reason: string }`
   - When `input.accepted === false`: do **NOT** mutate `ledger`; return `{ recorded: false, ledger, createdProblem: false, reason: "Rejected candidate not appended to SIM ledger per arXiv:2611.18856 §3.2 (U(M_t, ∅) = M_t)" }`.
   - When `ledger.carried_from?.into` is set and `input.run` is omitted, stamp `run: ledger.carried_from.into` on the recorded attempt.
3. **`SimRejectedCandidateLogEntry`:** Export the structured interface for external negative-experience JSONL logging (`.omp/sim-rejected.jsonl`, OMPK-RSI P5 / FR-007) containing `timestamp`, `problem_id?`, `name?`, `round`, `accepted: false`, `what`, `files`, `model`, `domain`, `benchmark`, `sample?`, `predicted`, `fixed`, `missed`, `regressed`, `preserved?`, `unproven?`, `incomplete?`, `passed`, `total`, `reason`, `manifest_id?`, `baseline_ref?`, `candidate_ref?`.
4. **`carryForwardSimLedger(ledger, input: CarryForwardInput): SimLedger`:**
   - Validates non-empty `arm`, `domain`, `into` (and optional `benchmark`, `model`, `carriedAt`).
   - Returns a new `SimLedger` with `schema_version: SIM_SCHEMA_VERSION` and `carried_from: { arm, domain, into, ...(optional fields) }`, preserving all existing `problems`, `aliases`, and `next_id`.
5. **`computeNextRound(ledger, scope?: RoundScope): number`:**
   - `RoundScope = { run?: string }`.
   - Determine `targetRun = scope?.run ?? ledger.carried_from?.into`.
   - If `targetRun` is defined, compute `maxRound` across attempts where `attempt.run === targetRun`; return `maxRound === 0 ? 1 : maxRound + 1` (so rounds cleanly restart at `1` on carry-forward even across same-domain cross-model transitions).
   - If `targetRun` is undefined, preserve global `maxRound + 1` (or `1` if empty).
6. **`validateSimLedger(raw: unknown): SimValidationResult`:**
   - Enforce exact key allowlists (rejecting unknown keys) at root, `carried_from`, `problem`, and `attempt` — 100% parity with `.omp/sim.schema.json`.
   - Validate all optional field types (`$schema`, `schema_version`, `sample`, `backfilled`, `run`, `baseline_ref`, `candidate_ref`, `commit`, `timestamp`, `preserved`, `unresolved`, `unproven`, `incomplete`, `carried_from.{benchmark,model,carried_at}`).
   - Enforce `attempt.accepted === true`, non-empty `benchmark`, valid unique-string array `regressed`, and predicted partition:
     - Every ID in `fixed`, `missed`, `preserved ?? []`, `unproven ?? []`, `incomplete ?? []` must be pairwise disjoint and their union must equal `predicted`.
     - If `backfilled !== true`, validate that `fixed ∩ preserved === ∅` and all partition arrays contain unique non-empty strings.
   - Keep existing `next_id`, alias target/cycle, `opened_round`, `passed <= total`, and `files.length >= 1` checks.
   - Avoid inline type-cast member access (`(x as { foo?: unknown }).foo`) — use helper type guards (`isRecord` + `Object.entries` / `in`).
7. **`createEmptySimLedger()`:** Include `schema_version: SIM_SCHEMA_VERSION`.

### 4.3 `scripts/sim/manifest.ts` (new)
Create the deterministic pre-evaluation change manifest module (`G1`):
- Export `DEFAULT_MANIFEST_PATH` (repo-root `.omp/sim-manifest.json`), `SimManifestStatus = "pending" | "consumed"`, `SimChangeManifest`, `CreateManifestInput`, `ManifestValidationResult`.
- `SimChangeManifest` fields:
  - `version: 1`, `manifest_id: string`, `status: "pending" | "consumed"`, `created_at: string`, `consumed_at?: string`
  - `problem: string` (`"new"` or existing/alias `"P#"`)
  - `name?: string`, `round?: number`, `what?: string`, `files?: string[]`, `model?: string`, `domain?: string`, `benchmark?: string`, `sample?: string`, `backfilled?: boolean`
  - `predicted: string[]` (non-empty unique non-empty strings)
  - `baseline_path?: string`, `baseline_model?: string`, `baseline_passed_ids?: string[]`, `baseline_failed_ids?: string[]`
  - `prediction_hash: string` — SHA-256 hex digest over canonical JSON of `{ problem, name: name ?? null, predicted: [...predicted] }` using `new Bun.CryptoHasher("sha256")` (or `node:crypto` `createHash("sha256")`).
- Export functions:
  - `computePredictionHash({ problem, name, predicted }): string`
  - `createChangeManifest(input: CreateManifestInput): SimChangeManifest` (rejects empty `predicted`, duplicate `predicted`, or `problem === "new"` without non-empty `name`; supports optional deterministic `manifestId` & `createdAt` overrides for tests)
  - `validateChangeManifest(raw: unknown): ManifestValidationResult` (strict allowlist + recomputes `prediction_hash` to detect post-hoc tampering)
  - `readChangeManifest(manifestPath: string): Promise<SimChangeManifest>`
  - `writeChangeManifest(manifestPath: string, manifest: SimChangeManifest): Promise<void>`
  - `markManifestConsumed(manifest: SimChangeManifest, consumedAt?: string): SimChangeManifest`

### 4.4 `.omp/sim.json`
Upgrade the seeded ledger to `schema_version: 2` while preserving honest `backfilled: true` provenance (do NOT invent fake baselines):
- Add `"schema_version": 2` at root.
- On each seeded attempt (`P1`–`P6`), add:
  - `benchmark`: `"json-parse-repair"` (P1), `"patch-dialect-isolation"` (P2), `"gateway-retry-resilience"` (P3), `"utf8-truncation-bounds"` (P4), `"approval-ttsr-prompt-cache"` (P5), `"pi-catalog-compat"` (P6)
  - `sample`: `"seed-p1"` .. `"seed-p6"`
  - `regressed: []`
  - Keep existing `backfilled: true`, `fixed`, `missed`, `passed: 16`, `total: 16`.

### 4.5 `scripts/sim/replay.ts` (lines 360–380 only)
Update the inline `sampleLedger` inside `system-prompt-sim-and-prefix-stability` so `problems[0].attempts` contains 1 valid `schema_version: 2` Appendix D.3 attempt (`round: 1`, `accepted: true`, `what`, `files`, `model`, `domain`, `benchmark: "sim-replay"`, `predicted`, `fixed`, `missed: []`, `regressed: []`, `passed: 16`, `total: 16`, `sample: "replay-fixture"`). Do not alter any other replay case.

## 5. Hard constraints

1. No new npm dependencies. Use built-in Bun / Node APIs and existing `package.json` deps only.
2. Zero inline type-cast member access (`(x as { foo?: unknown }).foo`) — triggers `ts-no-inline-cast-access`.
3. No edits outside the 5 owned files. Verify via `git diff --name-only`.
4. Do NOT edit `scripts/sim/cli.ts`, `scripts/sim/sim.test.ts`, or `packages/coding-agent/*`.
5. This `[pre-phase]` lane runs in the main checkout where `node_modules` is present, so run the lane-scoped commands in Section 6 directly.
6. Skip project-wide build/test suites; run only Section 6 checks.

## 6. Verification

Run before declaring done:
```bash
bun run sim:validate
bun run sim:replay --json
bunx biome check .omp/sim.schema.json .omp/sim.json scripts/sim/schema.ts scripts/sim/manifest.ts scripts/sim/replay.ts
git diff --name-only
```

Expected:
- `bun run sim:validate` exits `0` (`6 problems, 6 attempts, 0 aliases`).
- `bun run sim:replay --json` exits `0` (`passed: 16, total: 16`).
- `biome check` exits `0` with 0 errors.
- `git diff --name-only` + `git status --short` show ONLY the 5 owned files.

## 7. Commit message

`feat(sim): add schema v2, 8-state diff, pre-eval manifest, and carry-forward contracts (Gap A)`

## 8. Final report

Fill in and return at the end of your response:
```
### Lane A final report
- Worktree path / branch:
- Files modified / created:
- Public exports added (signatures):
- @ts-expect-error suppressors added (count + which imports): none
- Lines added / removed:
- Verification:
  - bun run sim:validate exit: ___
  - bun run sim:replay --json exit: ___
  - biome check exit: ___
  - git diff --name-only: ___
- Flags / blockers:
```
