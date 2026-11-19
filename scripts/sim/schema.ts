/**
 * Self-Improvement Memory (SIM) schema, strict validation, deterministic
 * exact-text matching/merging, carry-forward, and 8-state baseline-to-candidate
 * replay attribution.
 *
 * Implements arXiv:2611.18856 (Appendix D.1–D.3 & §3.2) and OMPK-RSI §24.1.
 * Zero embeddings, zero similarity models, zero retrieval layers.
 */

import {
	SIM_SCHEMA_VERSION,
	type SimAttempt,
	type SimCarriedFrom,
	type SimLedger,
	type SimLedgerValidationResult,
	type SimProblem,
	validateSimLedgerShape,
	verifySimJsonSchemaParity,
} from "../../packages/coding-agent/src/utils/sim-ledger.ts";

export {
	SIM_SCHEMA_VERSION,
	type SimAttempt,
	type SimCarriedFrom,
	type SimLedger,
	type SimProblem,
	verifySimJsonSchemaParity,
};

export const SIM_PROBLEM_ID_RE = /^P([1-9][0-9]*)$/;

function parseProblemNumber(id: string): number | null {
	const match = SIM_PROBLEM_ID_RE.exec(id);
	if (!match) return null;
	return Number.parseInt(match[1], 10);
}
export type SimValidationResult = SimLedgerValidationResult;

/**
 * Validate a SIM ledger strictly against Appendix D.3 and `.omp/sim.schema.json`.
 * Delegates directly to the canonical runtime validator in `sim-ledger.ts` so CLI
 * and prompt-loader validation share a single source of truth.
 */
export const validateSimLedger: (raw: unknown) => SimValidationResult = validateSimLedgerShape;
export interface SimReplayCaseResult {
	id: string;
	category: "parser" | "retry" | "truncation" | "hooks" | "compat";
	description: string;
	passed: boolean;
	duration_ms: number;
	error?: string;
}

export interface SimReplayBaselineMeta {
	passed_ids: readonly string[];
	failed_ids: readonly string[];
	model?: string;
	evaluator_id?: string;
}

export interface SimReplayReport {
	timestamp: string;
	passed: number;
	total: number;
	passed_ids: string[];
	failed_ids: string[];
	model?: string;
	results: SimReplayCaseResult[];
	diff?: SimReplayDiff;
}

export interface SimReplayDiff {
	predicted: string[];
	/** Predicted cases that transitioned FAIL -> PASS against baseline. */
	fixed: string[];
	/** Predicted cases with known baseline that ended in FAIL (unresolved ∪ regressed among predicted). */
	missed: string[];
	/** Predicted cases that were already PASS -> PASS (never counted as fixed). */
	preserved: string[];
	/** ALL suite cases that transitioned PASS -> FAIL against baseline. */
	regressed: string[];
	/** ALL suite cases that remained FAIL -> FAIL against baseline. */
	unresolved: string[];
	/** Predicted cases whose baseline outcome was unknown (or baseline missing / model mismatched). */
	unproven: string[];
	/** Predicted cases whose candidate outcome was missing from the replay report. */
	incomplete: string[];
	/** ALL suite cases that transitioned FAIL -> PASS against baseline. */
	newly_passing: string[];
	/** Set when both baseline.model and candidateModel are provided and differ (RSI-21). */
	model_mismatch?: { baselineModel: string; candidateModel: string };
}

export interface SimRejectedCandidateLogEntry {
	timestamp: string;
	problem_id?: string;
	name?: string;
	round: number;
	accepted: false;
	what: string;
	files: string[];
	model: string;
	domain: string;
	benchmark: string;
	sample?: string;
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
	reason: string;
	manifest_id?: string;
	baseline_ref?: string;
	candidate_ref?: string;
}

export interface CarryForwardInput {
	arm: string;
	domain: string;
	into: string;
	benchmark?: string;
	model?: string;
	carriedAt?: string;
}

export interface RoundScope {
	run?: string;
}

export interface AppendAttemptInput {
	/** Existing problem ID (or alias), OR `"new"` to open/exact-match by `name`. */
	problem: string;
	/** Required when `problem === "new"`. Exact normalized match reuses existing problem. */
	name?: string;
	round: number;
	accepted: boolean;
	what: string;
	files: string[];
	model: string;
	domain: string;
	benchmark: string;
	predicted: string[];
	fixed: string[];
	missed: string[];
	regressed?: string[];
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

export type AppendAttemptResult =
	| {
			recorded: true;
			ledger: SimLedger;
			problemId: string;
			createdProblem: boolean;
			mergedFromAlias?: string;
	  }
	| {
			recorded: false;
			ledger: SimLedger;
			createdProblem: false;
			reason: string;
	  };

/**
 * Normalize a root-cause name for deterministic exact-text matching (trim +
 * collapse internal whitespace, case-sensitive to match arXiv:2611.18856 D.1).
 */
export function normalizeRootCauseName(name: string): string {
	return name.trim().replace(/\s+/g, " ");
}

/**
 * Follow alias chains to the canonical problem ID, detecting cycles.
 */
export function resolveProblemId(ledger: Pick<SimLedger, "aliases">, id: string): string {
	let current = id;
	const visited = new Set<string>();
	while (Object.hasOwn(ledger.aliases, current)) {
		if (visited.has(current)) {
			throw new Error(`Alias cycle detected involving ${current}`);
		}
		visited.add(current);
		current = ledger.aliases[current];
	}
	return current;
}

export function createEmptySimLedger(): SimLedger {
	return {
		$schema: "./sim.schema.json",
		schema_version: SIM_SCHEMA_VERSION,
		next_id: 1,
		aliases: {},
		problems: [],
	};
}

/**
 * Compute strict 8-state baseline-to-candidate attribution (OMPK-RSI §24.1 &
 * arXiv:2611.18856 D.3):
 *
 * | Baseline | Candidate | Classification              |
 * | -------- | --------- | --------------------------- |
 * | FAIL     | PASS      | fixed (+ newly_passing)     |
 * | PASS     | PASS      | preserved (NEVER fixed)     |
 * | PASS     | FAIL      | regressed (+ missed if pred)|
 * | FAIL     | FAIL      | unresolved (+ missed if pred)|
 * | UNKNOWN  | PASS/FAIL | unproven (NEVER fixed)      |
 * | PASS/FAIL| UNKNOWN   | incomplete                  |
 *
 * Predicted partition invariant:
 *   fixed ⊔ missed ⊔ preserved ⊔ unproven ⊔ incomplete === predicted
 */
export function evaluateReplayDiff(
	report: Pick<SimReplayReport, "passed_ids" | "failed_ids" | "model">,
	predicted: readonly string[],
	baseline?: SimReplayBaselineMeta,
	options?: { candidateModel?: string },
): SimReplayDiff {
	const uniquePredicted = [...new Set(predicted.map(id => id.trim()).filter(Boolean))];
	const passedSet = new Set(report.passed_ids);
	const failedSet = new Set(report.failed_ids);

	const candidateModel = options?.candidateModel ?? report.model;
	if (baseline?.model && candidateModel && baseline.model !== candidateModel) {
		return {
			predicted: uniquePredicted,
			fixed: [],
			missed: [],
			preserved: [],
			regressed: [],
			unresolved: [],
			unproven: [...uniquePredicted],
			incomplete: [],
			newly_passing: [],
			model_mismatch: {
				baselineModel: baseline.model,
				candidateModel,
			},
		};
	}

	// Missing baseline cannot demonstrate a fix (OMPK-RSI §24.1 / RSI-03).
	if (!baseline) {
		const incomplete: string[] = [];
		const unproven: string[] = [];
		for (const id of uniquePredicted) {
			if (!passedSet.has(id) && !failedSet.has(id)) {
				incomplete.push(id);
			} else {
				unproven.push(id);
			}
		}
		return {
			predicted: uniquePredicted,
			fixed: [],
			missed: [],
			preserved: [],
			regressed: [],
			unresolved: [],
			unproven,
			incomplete,
			newly_passing: [],
		};
	}

	const baselinePassSet = new Set(baseline.passed_ids);
	const baselineFailSet = new Set(baseline.failed_ids);

	const regressed: string[] = [];
	const unresolved: string[] = [];
	const newly_passing: string[] = [];

	for (const id of report.failed_ids) {
		if (baselinePassSet.has(id)) {
			regressed.push(id);
		} else if (baselineFailSet.has(id)) {
			unresolved.push(id);
		}
	}
	for (const id of report.passed_ids) {
		if (baselineFailSet.has(id)) {
			newly_passing.push(id);
		}
	}

	const fixed: string[] = [];
	const missed: string[] = [];
	const preserved: string[] = [];
	const unproven: string[] = [];
	const incomplete: string[] = [];

	for (const id of uniquePredicted) {
		const candidatePass = passedSet.has(id);
		const candidateFail = failedSet.has(id);
		const baselinePass = baselinePassSet.has(id);
		const baselineFail = baselineFailSet.has(id);

		if (!candidatePass && !candidateFail) {
			incomplete.push(id);
		} else if (!baselinePass && !baselineFail) {
			unproven.push(id);
		} else if (baselineFail && candidatePass) {
			fixed.push(id);
		} else if (baselinePass && candidatePass) {
			preserved.push(id);
		} else {
			// Known baseline (PASS or FAIL) and candidate FAIL -> missed
			missed.push(id);
		}
	}

	return {
		predicted: uniquePredicted,
		fixed,
		missed,
		preserved,
		regressed,
		unresolved,
		unproven,
		incomplete,
		newly_passing,
	};
}

/**
 * Deterministic exact-text duplicate merger (Appendix D.1):
 * merges problems with identical normalized `name` into the lowest numeric ID,
 * preserves all attempts in chronological order, and records retired IDs in `aliases`.
 */
export function mergeDuplicateProblems(ledger: SimLedger): {
	ledger: SimLedger;
	merged: Array<{ from: string; into: string; name: string }>;
} {
	const merged: Array<{ from: string; into: string; name: string }> = [];
	const aliases: Record<string, string> = { ...ledger.aliases };
	const byNormalizedName = new Map<string, SimProblem>();

	const sortedProblems = [...ledger.problems].sort((a, b) => {
		const numA = parseProblemNumber(a.id) ?? Number.MAX_SAFE_INTEGER;
		const numB = parseProblemNumber(b.id) ?? Number.MAX_SAFE_INTEGER;
		return numA - numB;
	});

	for (const problem of sortedProblems) {
		const key = normalizeRootCauseName(problem.name);
		const existing = byNormalizedName.get(key);
		if (!existing) {
			byNormalizedName.set(key, {
				...problem,
				name: key,
				attempts: [...problem.attempts],
			});
			continue;
		}

		existing.opened_round = Math.min(existing.opened_round, problem.opened_round);
		existing.attempts = [...existing.attempts, ...problem.attempts].sort((a, b) => a.round - b.round);
		aliases[problem.id] = existing.id;
		merged.push({ from: problem.id, into: existing.id, name: key });
	}

	// Flatten transitive alias targets so aliases always point to the final canonical ID.
	for (const aliasKey of Object.keys(aliases)) {
		aliases[aliasKey] = resolveProblemId({ aliases }, aliasKey);
	}

	const nextLedger: SimLedger = {
		...ledger,
		aliases,
		problems: [...byNormalizedName.values()],
	};

	return { ledger: nextLedger, merged };
}

/**
 * Mark a ledger as carried forward into a new run/domain/model (arXiv:2611.18856 §3.3 & D.3).
 * Preserves all existing problems, aliases, and `next_id`.
 */
export function carryForwardSimLedger(ledger: SimLedger, input: CarryForwardInput): SimLedger {
	const arm = input.arm.trim();
	const domain = input.domain.trim();
	const into = input.into.trim();
	if (!arm) throw new Error("carryForwardSimLedger requires a non-empty arm");
	if (!domain) throw new Error("carryForwardSimLedger requires a non-empty domain");
	if (!into) throw new Error("carryForwardSimLedger requires a non-empty into target run");

	const carriedFrom: SimCarriedFrom = {
		arm,
		domain,
		into,
		...(input.benchmark?.trim() ? { benchmark: input.benchmark.trim() } : {}),
		...(input.model?.trim() ? { model: input.model.trim() } : {}),
		carried_at: input.carriedAt?.trim() || new Date().toISOString(),
	};

	return {
		...ledger,
		schema_version: SIM_SCHEMA_VERSION,
		carried_from: carriedFrom,
		aliases: { ...ledger.aliases },
		problems: ledger.problems.map(p => ({ ...p, attempts: [...p.attempts] })),
	};
}

/**
 * Append an attempt to an existing problem (resolving aliases), exact-text-matched
 * problem, or a newly allocated `P<next_id>` problem.
 *
 * Enforces arXiv:2611.18856 §3.2: if `input.accepted === false`, returns
 * `{ recorded: false }` without modifying the ledger (`U(M_t, ∅) = M_t`).
 */
export function appendSimAttempt(ledger: SimLedger, input: AppendAttemptInput): AppendAttemptResult {
	if (!input.accepted) {
		return {
			recorded: false,
			ledger,
			createdProblem: false,
			reason: "Rejected candidate not appended to SIM ledger per arXiv:2611.18856 §3.2 (U(M_t, ∅) = M_t)",
		};
	}

	const effectiveRun = input.run?.trim() || ledger.carried_from?.into;

	const attempt: SimAttempt = {
		round: input.round,
		accepted: true,
		what: input.what.trim(),
		files: input.files.map(f => f.trim()).filter(Boolean),
		model: input.model.trim(),
		domain: input.domain.trim(),
		benchmark: input.benchmark.trim(),
		predicted: [...input.predicted],
		fixed: [...input.fixed],
		missed: [...input.missed],
		regressed: [...(input.regressed ?? [])],
		...(input.preserved && input.preserved.length > 0 ? { preserved: [...input.preserved] } : {}),
		...(input.unresolved && input.unresolved.length > 0 ? { unresolved: [...input.unresolved] } : {}),
		...(input.unproven && input.unproven.length > 0 ? { unproven: [...input.unproven] } : {}),
		...(input.incomplete && input.incomplete.length > 0 ? { incomplete: [...input.incomplete] } : {}),
		passed: input.passed,
		total: input.total,
		...(input.sample?.trim() ? { sample: input.sample.trim() } : {}),
		...(input.backfilled !== undefined ? { backfilled: input.backfilled } : {}),
		...(effectiveRun ? { run: effectiveRun } : {}),
		...(input.baseline_ref?.trim() ? { baseline_ref: input.baseline_ref.trim() } : {}),
		...(input.candidate_ref?.trim() ? { candidate_ref: input.candidate_ref.trim() } : {}),
		...(input.commit?.trim() ? { commit: input.commit.trim() } : {}),
		...(input.timestamp?.trim() ? { timestamp: input.timestamp.trim() } : {}),
	};

	const problems: SimProblem[] = ledger.problems.map(p => ({
		...p,
		attempts: [...p.attempts],
	}));
	const aliases: Record<string, string> = { ...ledger.aliases };
	let nextId = ledger.next_id;

	if (input.problem === "new") {
		if (!input.name?.trim()) {
			throw new Error("A non-empty problem --name is required when --problem is 'new'");
		}
		const normalizedName = normalizeRootCauseName(input.name);
		const exactMatch = problems.find(p => normalizeRootCauseName(p.name) === normalizedName);
		if (exactMatch) {
			exactMatch.attempts.push(attempt);
			return {
				recorded: true,
				ledger: { ...ledger, schema_version: SIM_SCHEMA_VERSION, next_id: nextId, aliases, problems },
				problemId: exactMatch.id,
				createdProblem: false,
			};
		}

		const newId = `P${nextId}`;
		nextId += 1;
		problems.push({
			id: newId,
			name: normalizedName,
			opened_round: input.round,
			attempts: [attempt],
		});
		return {
			recorded: true,
			ledger: { ...ledger, schema_version: SIM_SCHEMA_VERSION, next_id: nextId, aliases, problems },
			problemId: newId,
			createdProblem: true,
		};
	}

	const resolvedId = resolveProblemId({ aliases }, input.problem);
	const mergedFromAlias = resolvedId !== input.problem ? input.problem : undefined;
	const target = problems.find(p => p.id === resolvedId);
	if (!target) {
		throw new Error(`Problem "${input.problem}" (resolved: "${resolvedId}") does not exist in SIM ledger`);
	}
	target.attempts.push(attempt);
	return {
		recorded: true,
		ledger: { ...ledger, schema_version: SIM_SCHEMA_VERSION, next_id: nextId, aliases, problems },
		problemId: target.id,
		createdProblem: false,
		mergedFromAlias,
	};
}

/**
 * Compute the next round number.
 *
 * Per arXiv:2611.18856 Appendix D.3 & Appendix F: rounds are run-relative and
 * restart at `1` when carried forward into a new `run` (`scope.run ?? ledger.carried_from?.into`).
 * When no run scope is active, increments monotonically across all recorded attempts.
 */
export function computeNextRound(ledger: SimLedger, scope?: RoundScope): number {
	const targetRun = scope?.run?.trim() || ledger.carried_from?.into;
	let maxRound = 0;
	for (const problem of ledger.problems) {
		if (!targetRun && problem.opened_round > maxRound) {
			maxRound = problem.opened_round;
		}
		for (const attempt of problem.attempts) {
			if (targetRun && attempt.run !== targetRun) {
				continue;
			}
			if (attempt.round > maxRound) {
				maxRound = attempt.round;
			}
		}
	}
	return maxRound + 1;
}
