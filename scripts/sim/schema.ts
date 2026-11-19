/**
 * Self-Improvement Memory (SIM) schema, deterministic matching/merging,
 * and runtime validation for `.omp/sim.json` (arXiv:2611.18856v1 Appendix D).
 */

export const SIM_PROBLEM_ID_RE = /^P([1-9][0-9]*)$/;

export interface SimCarriedFrom {
	arm: string;
	domain: string;
	into: string;
}

export interface SimAttempt {
	round: number;
	accepted: boolean;
	what: string;
	files: string[];
	model: string;
	domain: string;
	predicted: string[];
	fixed: string[];
	missed: string[];
	passed: number;
	total: number;
	sample?: string;
	backfilled?: boolean;
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
	next_id: number;
	carried_from?: SimCarriedFrom;
	aliases: Record<string, string>;
	problems: SimProblem[];
}

export interface SimReplayCaseResult {
	id: string;
	category: "parser" | "retry" | "truncation" | "hooks" | "compat";
	description: string;
	passed: boolean;
	durationMs: number;
	error?: string;
}

export interface SimReplayReport {
	passed: number;
	total: number;
	passed_ids: string[];
	failed_ids: string[];
	results: SimReplayCaseResult[];
	/** Present when compared against a baseline replay report or predicted list. */
	diff?: {
		predicted: string[];
		fixed: string[];
		missed: string[];
		regressed: string[];
		newly_passing: string[];
	};
}

export interface SimValidationResult {
	ok: boolean;
	errors: string[];
}

export interface AppendAttemptInput {
	/** Existing problem ID (e.g. "P3", follows aliases) or "new" / omitted to match exact `name` or allocate a new ID. */
	problemId?: string;
	/** Recurring root-cause hypothesis. Required when creating a new problem; used for deterministic exact-text matching. */
	name?: string;
	round?: number;
	accepted: boolean;
	what: string;
	files: string[];
	model: string;
	domain: string;
	predicted: string[];
	fixed: string[];
	missed: string[];
	passed: number;
	total: number;
	sample?: string;
	backfilled?: boolean;
	commit?: string;
	timestamp?: string;
}

export interface AppendAttemptResult {
	ledger: SimLedger;
	problemId: string;
	createdProblem: boolean;
	mergedFromAlias?: string;
}

export function createEmptySimLedger(): SimLedger {
	return {
		$schema: "./sim.schema.json",
		next_id: 1,
		aliases: {},
		problems: [],
	};
}

export function parseProblemNumber(id: string): number | null {
	const match = SIM_PROBLEM_ID_RE.exec(id);
	if (!match?.[1]) return null;
	const num = Number.parseInt(match[1], 10);
	return Number.isSafeInteger(num) && num >= 1 ? num : null;
}

/**
 * Deterministic exact-text normalization for Appendix D.1 matching:
 * trims outer whitespace and collapses internal runs of whitespace to single spaces.
 */
export function normalizeRootCauseName(name: string): string {
	return name.trim().replace(/\s+/g, " ");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isStringArray(value: unknown, allowEmpty: boolean): value is string[] {
	if (!Array.isArray(value)) return false;
	if (!allowEmpty && value.length === 0) return false;
	return value.every(item => isNonEmptyString(item));
}

function dedupePreserveOrder(items: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of items) {
		const trimmed = raw.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/**
 * Resolve a problem ID through the `aliases` table deterministically, detecting cycles.
 */
export function resolveProblemId(ledger: Pick<SimLedger, "aliases">, id: string): string {
	let current = id.trim();
	const visited = new Set<string>();
	while (Object.hasOwn(ledger.aliases, current)) {
		if (visited.has(current)) {
			throw new Error(`Alias cycle detected while resolving problem ID "${id}" at "${current}"`);
		}
		visited.add(current);
		current = ledger.aliases[current];
	}
	return current;
}

/**
 * Compute observed `fixed`, `missed`, `regressed`, and `newly_passing` from
 * replay results and pre-run `predicted` case IDs.
 */
export function evaluateReplayDiff(
	report: Pick<SimReplayReport, "passed_ids" | "failed_ids" | "results">,
	predicted: readonly string[],
	baseline?: Pick<SimReplayReport, "passed_ids" | "failed_ids">,
): NonNullable<SimReplayReport["diff"]> {
	const cleanPredicted = dedupePreserveOrder(predicted);
	const passedSet = new Set(report.passed_ids);
	const failedSet = new Set(report.failed_ids);

	const fixed: string[] = [];
	const missed: string[] = [];
	for (const caseId of cleanPredicted) {
		if (passedSet.has(caseId)) {
			fixed.push(caseId);
		} else {
			missed.push(caseId);
		}
	}

	const baselinePassed = new Set(baseline?.passed_ids ?? []);
	const baselineFailed = new Set(baseline?.failed_ids ?? []);

	const regressed = baseline ? [...baselinePassed].filter(id => failedSet.has(id)) : [];
	const newlyPassing = baseline ? [...baselineFailed].filter(id => passedSet.has(id)) : [];

	return {
		predicted: cleanPredicted,
		fixed,
		missed,
		regressed,
		newly_passing: newlyPassing,
	};
}

/**
 * Deterministically merge problems with identical normalized root-cause text,
 * preserving all attempts and recording retired IDs in `aliases`.
 */
export function mergeDuplicateProblems(ledger: SimLedger): { ledger: SimLedger; merged: Array<[string, string]> } {
	const byName = new Map<string, SimProblem>();
	const nextProblems: SimProblem[] = [];
	const nextAliases: Record<string, string> = { ...ledger.aliases };
	const merged: Array<[string, string]> = [];

	// Sort by numeric ID so the earliest problem ID is always canonical.
	const sorted = [...ledger.problems].sort((a, b) => {
		const numA = parseProblemNumber(a.id) ?? Number.MAX_SAFE_INTEGER;
		const numB = parseProblemNumber(b.id) ?? Number.MAX_SAFE_INTEGER;
		return numA - numB;
	});

	for (const problem of sorted) {
		const normalized = normalizeRootCauseName(problem.name);
		const existing = byName.get(normalized);
		if (!existing) {
			const copy: SimProblem = {
				id: problem.id,
				name: normalized,
				opened_round: problem.opened_round,
				attempts: [...problem.attempts],
			};
			byName.set(normalized, copy);
			nextProblems.push(copy);
			continue;
		}
		existing.opened_round = Math.min(existing.opened_round, problem.opened_round);
		existing.attempts.push(...problem.attempts);
		existing.attempts.sort((a, b) => a.round - b.round);
		nextAliases[problem.id] = existing.id;
		merged.push([problem.id, existing.id]);
	}

	// Flatten transitive alias chains so every alias points directly to its canonical target.
	for (const aliasKey of Object.keys(nextAliases)) {
		const target = resolveProblemId({ aliases: nextAliases }, aliasKey);
		nextAliases[aliasKey] = target;
	}

	return {
		ledger: {
			...(ledger.$schema ? { $schema: ledger.$schema } : {}),
			next_id: ledger.next_id,
			...(ledger.carried_from ? { carried_from: { ...ledger.carried_from } } : {}),
			aliases: nextAliases,
			problems: nextProblems,
		},
		merged,
	};
}

/**
 * Compute the next global round number across all recorded attempts (max round + 1, or 1 when empty).
 */
export function computeNextRound(ledger: SimLedger): number {
	let maxRound = 0;
	for (const problem of ledger.problems) {
		if (problem.opened_round > maxRound) maxRound = problem.opened_round;
		for (const attempt of problem.attempts) {
			if (attempt.round > maxRound) maxRound = attempt.round;
		}
	}
	return maxRound + 1;
}

/**
 * Append a verified attempt to the ledger:
 * 1. If `problemId` is given and not `"new"`, resolves through `aliases` and appends to that problem.
 * 2. Otherwise checks deterministic exact-text match against existing `problem.name`.
 * 3. Otherwise allocates `P<next_id>` and increments `next_id`.
 * Preserves all earlier attempts intact, including missed predictions.
 */
export function appendSimAttempt(ledger: SimLedger, input: AppendAttemptInput): AppendAttemptResult {
	const clone: SimLedger = {
		...(ledger.$schema ? { $schema: ledger.$schema } : {}),
		next_id: ledger.next_id,
		...(ledger.carried_from ? { carried_from: { ...ledger.carried_from } } : {}),
		aliases: { ...ledger.aliases },
		problems: ledger.problems.map(problem => ({
			...problem,
			attempts: problem.attempts.map(attempt => ({
				...attempt,
				files: [...attempt.files],
				predicted: [...attempt.predicted],
				fixed: [...attempt.fixed],
				missed: [...attempt.missed],
			})),
		})),
	};

	const round = input.round ?? computeNextRound(clone);
	const attempt: SimAttempt = {
		round,
		accepted: input.accepted,
		what: input.what.trim(),
		files: dedupePreserveOrder(input.files),
		model: input.model.trim(),
		domain: input.domain.trim(),
		predicted: dedupePreserveOrder(input.predicted),
		fixed: dedupePreserveOrder(input.fixed),
		missed: dedupePreserveOrder(input.missed),
		passed: input.passed,
		total: input.total,
		...(input.sample ? { sample: input.sample.trim() } : {}),
		...(input.backfilled !== undefined ? { backfilled: input.backfilled } : {}),
		...(input.commit ? { commit: input.commit.trim() } : {}),
		...(input.timestamp ? { timestamp: input.timestamp.trim() } : {}),
	};

	let targetProblem: SimProblem | undefined;
	let mergedFromAlias: string | undefined;

	const rawId = input.problemId?.trim();
	if (rawId && rawId.toLowerCase() !== "new") {
		const canonicalId = resolveProblemId(clone, rawId);
		if (canonicalId !== rawId) {
			mergedFromAlias = rawId;
		}
		targetProblem = clone.problems.find(problem => problem.id === canonicalId);
		if (!targetProblem) {
			throw new Error(`Problem ID "${rawId}" (resolved to "${canonicalId}") does not exist in SIM ledger.`);
		}
	}

	if (!targetProblem && input.name) {
		const normalizedName = normalizeRootCauseName(input.name);
		targetProblem = clone.problems.find(problem => normalizeRootCauseName(problem.name) === normalizedName);
	}

	let createdProblem = false;
	if (targetProblem) {
		targetProblem.attempts.push(attempt);
	} else {
		if (!input.name || input.name.trim().length === 0) {
			throw new Error("Opening a new SIM problem requires a non-empty root-cause `name`.");
		}
		const newId = `P${clone.next_id}`;
		clone.next_id += 1;
		targetProblem = {
			id: newId,
			name: normalizeRootCauseName(input.name),
			opened_round: round,
			attempts: [attempt],
		};
		clone.problems.push(targetProblem);
		createdProblem = true;
	}

	const validation = validateSimLedger(clone);
	if (!validation.ok) {
		throw new Error(`SIM ledger invariant violation after append:\n- ${validation.errors.join("\n- ")}`);
	}

	return {
		ledger: clone,
		problemId: targetProblem.id,
		createdProblem,
		...(mergedFromAlias ? { mergedFromAlias } : {}),
	};
}

/**
 * Validate an unknown parsed JSON value against the Appendix D.3 SIM ledger contract.
 */
export function validateSimLedger(raw: unknown): SimValidationResult {
	const errors: string[] = [];
	if (!isPlainRecord(raw)) {
		return { ok: false, errors: ["Ledger root must be a JSON object."] };
	}

	if (!isPositiveInt(raw.next_id)) {
		errors.push("`next_id` must be a positive integer >= 1.");
	}

	if (raw.carried_from !== undefined) {
		if (!isPlainRecord(raw.carried_from)) {
			errors.push("`carried_from` must be an object when present.");
		} else {
			for (const field of ["arm", "domain", "into"] as const) {
				if (!isNonEmptyString(raw.carried_from[field])) {
					errors.push(`\`carried_from.${field}\` must be a non-empty string.`);
				}
			}
		}
	}

	if (!isPlainRecord(raw.aliases)) {
		errors.push("`aliases` must be an object mapping retired problem IDs to canonical IDs.");
	}

	if (!Array.isArray(raw.problems)) {
		errors.push("`problems` must be an array.");
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	const nextId = raw.next_id as number;
	const aliases = raw.aliases as Record<string, unknown>;
	const problems = raw.problems as unknown[];

	const seenIds = new Set<string>();
	const seenNames = new Map<string, string>();
	let maxProblemNum = 0;

	for (let pIndex = 0; pIndex < problems.length; pIndex++) {
		const entry = problems[pIndex];
		const prefix = `problems[${pIndex}]`;
		if (!isPlainRecord(entry)) {
			errors.push(`${prefix} must be an object.`);
			continue;
		}

		const id = entry.id;
		const idNum = typeof id === "string" ? parseProblemNumber(id) : null;
		if (idNum === null || typeof id !== "string") {
			errors.push(`${prefix}.id must match /^P[1-9][0-9]*$/.`);
		} else {
			if (seenIds.has(id)) {
				errors.push(`${prefix}.id "${id}" is duplicated.`);
			}
			seenIds.add(id);
			if (idNum > maxProblemNum) maxProblemNum = idNum;
		}

		if (!isNonEmptyString(entry.name)) {
			errors.push(`${prefix}.name must be a non-empty string.`);
		} else if (typeof id === "string") {
			const normalized = normalizeRootCauseName(entry.name);
			const existingId = seenNames.get(normalized);
			if (existingId) {
				errors.push(
					`${prefix}.name duplicates "${existingId}" (${JSON.stringify(normalized)}); run \`sim merge\` to merge deterministically.`,
				);
			} else {
				seenNames.set(normalized, id);
			}
		}

		if (!isPositiveInt(entry.opened_round)) {
			errors.push(`${prefix}.opened_round must be a positive integer >= 1.`);
		}

		if (!Array.isArray(entry.attempts) || entry.attempts.length === 0) {
			errors.push(`${prefix}.attempts must be a non-empty array.`);
			continue;
		}

		for (let aIndex = 0; aIndex < entry.attempts.length; aIndex++) {
			const attempt = entry.attempts[aIndex];
			const aPrefix = `${prefix}.attempts[${aIndex}]`;
			if (!isPlainRecord(attempt)) {
				errors.push(`${aPrefix} must be an object.`);
				continue;
			}
			if (!isPositiveInt(attempt.round)) errors.push(`${aPrefix}.round must be an integer >= 1.`);
			if (typeof attempt.accepted !== "boolean") errors.push(`${aPrefix}.accepted must be a boolean.`);
			if (!isNonEmptyString(attempt.what)) errors.push(`${aPrefix}.what must be a non-empty string.`);
			if (!isStringArray(attempt.files, false)) errors.push(`${aPrefix}.files must be a non-empty string array.`);
			if (!isNonEmptyString(attempt.model)) errors.push(`${aPrefix}.model must be a non-empty string.`);
			if (!isNonEmptyString(attempt.domain)) errors.push(`${aPrefix}.domain must be a non-empty string.`);
			if (!isStringArray(attempt.predicted, true)) errors.push(`${aPrefix}.predicted must be a string array.`);
			if (!isStringArray(attempt.fixed, true)) errors.push(`${aPrefix}.fixed must be a string array.`);
			if (!isStringArray(attempt.missed, true)) errors.push(`${aPrefix}.missed must be a string array.`);
			if (!isNonNegativeInt(attempt.passed)) errors.push(`${aPrefix}.passed must be an integer >= 0.`);
			if (!isNonNegativeInt(attempt.total)) errors.push(`${aPrefix}.total must be an integer >= 0.`);

			if (isNonNegativeInt(attempt.passed) && isNonNegativeInt(attempt.total) && attempt.passed > attempt.total) {
				errors.push(`${aPrefix}.passed (${attempt.passed}) cannot exceed total (${attempt.total}).`);
			}

			if (
				isStringArray(attempt.predicted, true) &&
				isStringArray(attempt.fixed, true) &&
				isStringArray(attempt.missed, true)
			) {
				const predictedSet = new Set(attempt.predicted);
				const fixedSet = new Set(attempt.fixed);
				const missedSet = new Set(attempt.missed);

				for (const item of fixedSet) {
					if (!predictedSet.has(item)) {
						errors.push(`${aPrefix}.fixed contains "${item}" which is not in predicted.`);
					}
					if (missedSet.has(item)) {
						errors.push(`${aPrefix} lists "${item}" in both fixed and missed.`);
					}
				}
				for (const item of missedSet) {
					if (!predictedSet.has(item)) {
						errors.push(`${aPrefix}.missed contains "${item}" which is not in predicted.`);
					}
				}
				for (const item of predictedSet) {
					if (!fixedSet.has(item) && !missedSet.has(item)) {
						errors.push(`${aPrefix}.predicted item "${item}" is missing from both fixed and missed.`);
					}
				}
			}
		}
	}

	// Validate aliases and monotonicity of next_id.
	for (const [aliasFrom, aliasTo] of Object.entries(aliases)) {
		const fromNum = parseProblemNumber(aliasFrom);
		if (fromNum === null) {
			errors.push(`aliases key "${aliasFrom}" must match /^P[1-9][0-9]*$/.`);
		} else {
			if (fromNum > maxProblemNum) maxProblemNum = fromNum;
			if (seenIds.has(aliasFrom)) {
				errors.push(`aliases key "${aliasFrom}" cannot also exist as an active problem ID.`);
			}
		}
		if (typeof aliasTo !== "string" || parseProblemNumber(aliasTo) === null) {
			errors.push(`aliases["${aliasFrom}"] target must match /^P[1-9][0-9]*$/.`);
			continue;
		}
		if (!seenIds.has(aliasTo) && !Object.hasOwn(aliases, aliasTo)) {
			errors.push(`aliases["${aliasFrom}"] points to unknown problem ID "${aliasTo}".`);
		}
	}

	// Check alias cycle freedom.
	const stringAliases: Record<string, string> = {};
	for (const [k, v] of Object.entries(aliases)) {
		if (typeof v === "string") stringAliases[k] = v;
	}
	for (const aliasKey of Object.keys(stringAliases)) {
		try {
			const resolved = resolveProblemId({ aliases: stringAliases }, aliasKey);
			if (!seenIds.has(resolved)) {
				errors.push(`aliases["${aliasKey}"] resolves to missing problem ID "${resolved}".`);
			}
		} catch (error) {
			errors.push(String(error));
		}
	}

	if (nextId <= maxProblemNum) {
		errors.push(`next_id (${nextId}) must be strictly greater than highest problem/alias ID (P${maxProblemNum}).`);
	}

	return { ok: errors.length === 0, errors };
}
