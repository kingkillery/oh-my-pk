import * as path from "node:path";
import { isEnoent, logger } from "@pk-nerdsaver-ai/pi-utils";
import { repo } from "./git";
import { normalizePromptPath } from "./prompt-path";

export const SIM_LEDGER_RELATIVE_PATH = ".omp/sim.json";
export const DEFAULT_SIM_LEDGER_MAX_CHARS = 32_000;
export const SIM_SCHEMA_VERSION = 2 as const;
const SIM_PROBLEM_ID_RE = /^P([1-9][0-9]*)$/;

const SIM_ROOT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
	"$schema",
	"schema_version",
	"next_id",
	"carried_from",
	"aliases",
	"problems",
]);
const SIM_CARRIED_FROM_ALLOWED_KEYS: ReadonlySet<string> = new Set([
	"arm",
	"domain",
	"into",
	"benchmark",
	"model",
	"carried_at",
]);
const SIM_PROBLEM_ALLOWED_KEYS: ReadonlySet<string> = new Set(["id", "name", "opened_round", "attempts"]);
const SIM_ATTEMPT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
	"round",
	"accepted",
	"what",
	"files",
	"model",
	"domain",
	"benchmark",
	"predicted",
	"fixed",
	"missed",
	"regressed",
	"preserved",
	"unresolved",
	"unproven",
	"incomplete",
	"passed",
	"total",
	"sample",
	"backfilled",
	"run",
	"baseline_ref",
	"candidate_ref",
	"commit",
	"timestamp",
]);

export interface SimLedgerContext {
	path: string;
	content: string;
	truncated?: boolean;
}

export interface LoadSimLedgerOptions {
	maxChars?: number;
}

export interface SimLedgerValidationResult {
	ok: boolean;
	errors: string[];
}

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

type ParseSimLedgerOutcome =
	| { ok: true; ledger: SimLedger; errors: string[] }
	| { ok: false; ledger: null; errors: string[] };
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isNonNegativeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseProblemNumber(id: string): number | null {
	const match = SIM_PROBLEM_ID_RE.exec(id);
	if (!match) return null;
	return Number.parseInt(match[1], 10);
}

function checkAllowedKeys(
	obj: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	prefix: string,
	errors: string[],
): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) {
			errors.push(`${prefix}.${key} is not an allowed SIM schema property`);
		}
	}
}

function parseOptionalNonEmptyString(
	obj: Record<string, unknown>,
	key: string,
	prefix: string,
	errors: string[],
): string | undefined {
	const value = obj[key];
	if (value === undefined) return undefined;
	if (!isNonEmptyString(value)) {
		errors.push(`${prefix}.${key} must be a non-empty string when provided`);
		return undefined;
	}
	return value;
}

function parseUniqueStringArray(value: unknown, fieldPath: string, errors: string[]): string[] {
	if (!Array.isArray(value)) {
		errors.push(`${fieldPath} must be an array of strings`);
		return [];
	}
	const seen = new Set<string>();
	const result: string[] = [];
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (!isNonEmptyString(item)) {
			errors.push(`${fieldPath}[${i}] must be a non-empty string`);
			continue;
		}
		if (seen.has(item)) {
			errors.push(`${fieldPath}[${i}] duplicates "${item}"`);
			continue;
		}
		seen.add(item);
		result.push(item);
	}
	return result;
}

function resolveAliasTarget(aliases: Record<string, string>, id: string): { target: string } | { error: string } {
	let current = id;
	const visited = new Set<string>();
	while (Object.hasOwn(aliases, current)) {
		if (visited.has(current)) {
			return { error: `Alias cycle detected involving ${current}` };
		}
		visited.add(current);
		current = aliases[current];
	}
	return { target: current };
}

function parseAndValidateSimLedger(raw: unknown): ParseSimLedgerOutcome {
	const errors: string[] = [];
	if (!isRecord(raw)) {
		return { ok: false, ledger: null, errors: ["Ledger root must be a JSON object"] };
	}

	checkAllowedKeys(raw, SIM_ROOT_ALLOWED_KEYS, "root", errors);
	const schemaRef = parseOptionalNonEmptyString(raw, "$schema", "root", errors);

	let schemaVersion: 1 | 2 | undefined;
	if (raw.schema_version !== undefined) {
		if (raw.schema_version === 1 || raw.schema_version === 2) {
			schemaVersion = raw.schema_version;
		} else {
			errors.push("root.schema_version must be 1 or 2 when provided");
		}
	}

	const nextId = raw.next_id;
	if (!isPositiveInt(nextId)) {
		errors.push("next_id must be a positive integer");
	}

	let carriedFrom: SimCarriedFrom | undefined;
	if (raw.carried_from !== undefined) {
		if (!isRecord(raw.carried_from)) {
			errors.push("carried_from must be an object when provided");
		} else {
			checkAllowedKeys(raw.carried_from, SIM_CARRIED_FROM_ALLOWED_KEYS, "carried_from", errors);
			const arm = raw.carried_from.arm;
			const domain = raw.carried_from.domain;
			const into = raw.carried_from.into;
			if (!isNonEmptyString(arm)) {
				errors.push("carried_from.arm must be a non-empty string");
			}
			if (!isNonEmptyString(domain)) {
				errors.push("carried_from.domain must be a non-empty string");
			}
			if (!isNonEmptyString(into)) {
				errors.push("carried_from.into must be a non-empty string");
			}
			const benchmark = parseOptionalNonEmptyString(raw.carried_from, "benchmark", "carried_from", errors);
			const model = parseOptionalNonEmptyString(raw.carried_from, "model", "carried_from", errors);
			const carriedAt = parseOptionalNonEmptyString(raw.carried_from, "carried_at", "carried_from", errors);
			if (isNonEmptyString(arm) && isNonEmptyString(domain) && isNonEmptyString(into)) {
				carriedFrom = {
					arm,
					domain,
					into,
					...(benchmark !== undefined ? { benchmark } : {}),
					...(model !== undefined ? { model } : {}),
					...(carriedAt !== undefined ? { carried_at: carriedAt } : {}),
				};
			}
		}
	}

	const aliases: Record<string, string> = {};
	if (!isRecord(raw.aliases)) {
		errors.push("aliases must be an object mapping P# -> P#");
	} else {
		for (const [aliasKey, aliasTarget] of Object.entries(raw.aliases)) {
			if (!SIM_PROBLEM_ID_RE.test(aliasKey)) {
				errors.push(`aliases key "${aliasKey}" must match /^P[1-9][0-9]*$/`);
			}
			if (typeof aliasTarget !== "string" || !SIM_PROBLEM_ID_RE.test(aliasTarget)) {
				errors.push(`aliases["${aliasKey}"] must match /^P[1-9][0-9]*$/`);
			} else if (aliasKey === aliasTarget) {
				errors.push(`aliases["${aliasKey}"] cannot alias itself`);
			} else {
				aliases[aliasKey] = aliasTarget;
			}
		}
	}

	if (!Array.isArray(raw.problems)) {
		errors.push("problems must be an array");
		return { ok: false, ledger: null, errors };
	}

	const seenProblemIds = new Set<string>();
	const parsedProblems: SimProblem[] = [];
	let maxProblemNum = 0;

	for (let pIdx = 0; pIdx < raw.problems.length; pIdx++) {
		const problem = raw.problems[pIdx];
		const prefix = `problems[${pIdx}]`;
		if (!isRecord(problem)) {
			errors.push(`${prefix} must be an object`);
			continue;
		}
		checkAllowedKeys(problem, SIM_PROBLEM_ALLOWED_KEYS, prefix, errors);

		const id = problem.id;
		const idNum = typeof id === "string" ? parseProblemNumber(id) : null;
		if (idNum === null || typeof id !== "string") {
			errors.push(`${prefix}.id must match /^P[1-9][0-9]*$/`);
		} else {
			if (seenProblemIds.has(id)) {
				errors.push(`Duplicate problem id "${id}"`);
			}
			seenProblemIds.add(id);
			if (idNum > maxProblemNum) maxProblemNum = idNum;
		}

		const name = problem.name;
		if (!isNonEmptyString(name)) {
			errors.push(`${prefix}.name must be a non-empty string`);
		}
		const openedRound = problem.opened_round;
		if (!isPositiveInt(openedRound)) {
			errors.push(`${prefix}.opened_round must be a positive integer`);
		}

		if (!Array.isArray(problem.attempts) || problem.attempts.length === 0) {
			errors.push(`${prefix}.attempts must be a non-empty array`);
			continue;
		}

		const parsedAttempts: SimAttempt[] = [];
		for (let aIdx = 0; aIdx < problem.attempts.length; aIdx++) {
			const attempt = problem.attempts[aIdx];
			const aPrefix = `${prefix}.attempts[${aIdx}]`;
			if (!isRecord(attempt)) {
				errors.push(`${aPrefix} must be an object`);
				continue;
			}
			checkAllowedKeys(attempt, SIM_ATTEMPT_ALLOWED_KEYS, aPrefix, errors);

			const round = attempt.round;
			if (!isPositiveInt(round)) {
				errors.push(`${aPrefix}.round must be a positive integer`);
			}
			const accepted = attempt.accepted;
			if (accepted !== true) {
				errors.push(`${aPrefix}.accepted must be true (rejected candidates are not stored in sim.json per §3.2)`);
			}
			const what = attempt.what;
			if (!isNonEmptyString(what)) {
				errors.push(`${aPrefix}.what must be a non-empty string`);
			}
			const files: string[] = [];
			if (!Array.isArray(attempt.files) || attempt.files.length === 0) {
				errors.push(`${aPrefix}.files must be a non-empty array of file paths`);
			} else {
				for (let fIdx = 0; fIdx < attempt.files.length; fIdx++) {
					const fileItem = attempt.files[fIdx];
					if (!isNonEmptyString(fileItem)) {
						errors.push(`${aPrefix}.files[${fIdx}] must be a non-empty string`);
					} else {
						files.push(fileItem);
					}
				}
			}
			const model = attempt.model;
			if (!isNonEmptyString(model)) {
				errors.push(`${aPrefix}.model must be a non-empty string`);
			}
			const domain = attempt.domain;
			if (!isNonEmptyString(domain)) {
				errors.push(`${aPrefix}.domain must be a non-empty string`);
			}
			const benchmark = attempt.benchmark;
			if (!isNonEmptyString(benchmark)) {
				errors.push(`${aPrefix}.benchmark must be a non-empty string`);
			}

			const predicted = parseUniqueStringArray(attempt.predicted, `${aPrefix}.predicted`, errors);
			const fixed = parseUniqueStringArray(attempt.fixed, `${aPrefix}.fixed`, errors);
			const missed = parseUniqueStringArray(attempt.missed, `${aPrefix}.missed`, errors);
			const regressed = parseUniqueStringArray(attempt.regressed, `${aPrefix}.regressed`, errors);

			const preserved =
				attempt.preserved !== undefined
					? parseUniqueStringArray(attempt.preserved, `${aPrefix}.preserved`, errors)
					: undefined;
			const unresolved =
				attempt.unresolved !== undefined
					? parseUniqueStringArray(attempt.unresolved, `${aPrefix}.unresolved`, errors)
					: undefined;
			const unproven =
				attempt.unproven !== undefined
					? parseUniqueStringArray(attempt.unproven, `${aPrefix}.unproven`, errors)
					: undefined;
			const incomplete =
				attempt.incomplete !== undefined
					? parseUniqueStringArray(attempt.incomplete, `${aPrefix}.incomplete`, errors)
					: undefined;

			// Partition invariant: predicted === fixed ⊔ missed ⊔ preserved ⊔ unproven ⊔ incomplete
			const buckets: Array<{ name: string; items: string[] }> = [
				{ name: "fixed", items: fixed },
				{ name: "missed", items: missed },
				{ name: "preserved", items: preserved ?? [] },
				{ name: "unproven", items: unproven ?? [] },
				{ name: "incomplete", items: incomplete ?? [] },
			];
			const predictedSet = new Set(predicted);
			const seenInPartition = new Map<string, string>();
			for (const bucket of buckets) {
				for (const item of bucket.items) {
					const prior = seenInPartition.get(item);
					if (prior) {
						errors.push(`${aPrefix}: "${item}" cannot appear in both ${prior} and ${bucket.name}`);
					} else {
						seenInPartition.set(item, bucket.name);
					}
					if (!predictedSet.has(item)) {
						errors.push(`${aPrefix}.${bucket.name} contains "${item}" which is not in predicted`);
					}
				}
			}
			for (const item of predicted) {
				if (!seenInPartition.has(item)) {
					errors.push(
						`${aPrefix}.predicted contains "${item}" missing from fixed/missed/preserved/unproven/incomplete`,
					);
				}
			}

			const passed = attempt.passed;
			const total = attempt.total;
			if (!isNonNegativeInt(passed)) {
				errors.push(`${aPrefix}.passed must be a non-negative integer`);
			}
			if (!isNonNegativeInt(total)) {
				errors.push(`${aPrefix}.total must be a non-negative integer`);
			}
			if (isNonNegativeInt(passed) && isNonNegativeInt(total) && passed > total) {
				errors.push(`${aPrefix}.passed (${passed}) cannot exceed total (${total})`);
			}

			const sample = parseOptionalNonEmptyString(attempt, "sample", aPrefix, errors);
			let backfilled: boolean | undefined;
			if (attempt.backfilled !== undefined) {
				if (typeof attempt.backfilled === "boolean") {
					backfilled = attempt.backfilled;
				} else {
					errors.push(`${aPrefix}.backfilled must be a boolean when provided`);
				}
			}
			const run = parseOptionalNonEmptyString(attempt, "run", aPrefix, errors);
			const baselineRef = parseOptionalNonEmptyString(attempt, "baseline_ref", aPrefix, errors);
			const candidateRef = parseOptionalNonEmptyString(attempt, "candidate_ref", aPrefix, errors);
			const commit = parseOptionalNonEmptyString(attempt, "commit", aPrefix, errors);
			const timestamp = parseOptionalNonEmptyString(attempt, "timestamp", aPrefix, errors);

			if (
				isPositiveInt(round) &&
				accepted === true &&
				isNonEmptyString(what) &&
				files.length > 0 &&
				isNonEmptyString(model) &&
				isNonEmptyString(domain) &&
				isNonEmptyString(benchmark) &&
				isNonNegativeInt(passed) &&
				isNonNegativeInt(total)
			) {
				parsedAttempts.push({
					round,
					accepted: true,
					what,
					files,
					model,
					domain,
					benchmark,
					predicted,
					fixed,
					missed,
					regressed,
					...(preserved !== undefined ? { preserved } : {}),
					...(unresolved !== undefined ? { unresolved } : {}),
					...(unproven !== undefined ? { unproven } : {}),
					...(incomplete !== undefined ? { incomplete } : {}),
					passed,
					total,
					...(sample !== undefined ? { sample } : {}),
					...(backfilled !== undefined ? { backfilled } : {}),
					...(run !== undefined ? { run } : {}),
					...(baselineRef !== undefined ? { baseline_ref: baselineRef } : {}),
					...(candidateRef !== undefined ? { candidate_ref: candidateRef } : {}),
					...(commit !== undefined ? { commit } : {}),
					...(timestamp !== undefined ? { timestamp } : {}),
				});
			}
		}

		if (
			typeof id === "string" &&
			idNum !== null &&
			isNonEmptyString(name) &&
			isPositiveInt(openedRound) &&
			parsedAttempts.length > 0
		) {
			parsedProblems.push({
				id,
				name,
				opened_round: openedRound,
				attempts: parsedAttempts,
			});
		}
	}

	for (const aliasKey of Object.keys(aliases)) {
		const aliasNum = parseProblemNumber(aliasKey);
		if (aliasNum !== null && aliasNum > maxProblemNum) {
			maxProblemNum = aliasNum;
		}
		if (seenProblemIds.has(aliasKey)) {
			errors.push(`aliases key "${aliasKey}" cannot also exist as an active problem id`);
		}
		const resolved = resolveAliasTarget(aliases, aliasKey);
		if ("error" in resolved) {
			errors.push(resolved.error);
		} else if (!seenProblemIds.has(resolved.target)) {
			errors.push(`aliases["${aliasKey}"] resolves to "${resolved.target}", which is not an active problem`);
		}
	}

	if (isPositiveInt(nextId) && nextId <= maxProblemNum) {
		errors.push(`next_id (${nextId}) must be strictly greater than max used problem id (P${maxProblemNum})`);
	}

	if (errors.length > 0 || !isPositiveInt(nextId)) {
		return { ok: false, ledger: null, errors };
	}

	const ledger: SimLedger = {
		...(schemaRef !== undefined ? { $schema: schemaRef } : {}),
		...(schemaVersion !== undefined ? { schema_version: schemaVersion } : {}),
		next_id: nextId,
		...(carriedFrom !== undefined ? { carried_from: carriedFrom } : {}),
		aliases,
		problems: parsedProblems,
	};

	return { ok: true, ledger, errors: [] };
}

/**
 * Validate an unknown parsed JSON value strictly against the Appendix D.3 /
 * `.omp/sim.schema.json` contract (allowlists, optional field types, `accepted === true`,
 * `benchmark`, `regressed`, `0 <= passed <= total`, `predicted` disjoint partition,
 * alias targets/cycles, and `next_id` monotonicity).
 */
export function validateSimLedgerShape(raw: unknown): SimLedgerValidationResult {
	const outcome = parseAndValidateSimLedger(raw);
	return { ok: outcome.ok, errors: outcome.errors };
}

function compareSchemaKeySet(
	label: string,
	expected: ReadonlySet<string>,
	schemaNode: unknown,
	errors: string[],
): void {
	if (!isRecord(schemaNode) || !isRecord(schemaNode.properties)) {
		errors.push(`${label} in JSON Schema is missing a valid "properties" object`);
		return;
	}
	const actual = new Set(Object.keys(schemaNode.properties));
	for (const key of expected) {
		if (!actual.has(key)) {
			errors.push(`${label} is missing allowed key "${key}" in JSON Schema`);
		}
	}
	for (const key of actual) {
		if (!expected.has(key)) {
			errors.push(`${label} has unguarded key "${key}" in JSON Schema not covered by runtime validator`);
		}
	}
}

/**
 * Verify that a parsed `.omp/sim.schema.json` document matches the runtime
 * validator's private property allowlists across root, `carried_from`,
 * `$defs.problem`, and `$defs.attempt`.
 */
export function verifySimJsonSchemaParity(jsonSchema: unknown): SimLedgerValidationResult {
	const errors: string[] = [];
	if (!isRecord(jsonSchema)) {
		return { ok: false, errors: ["JSON Schema root must be an object"] };
	}
	compareSchemaKeySet("root", SIM_ROOT_ALLOWED_KEYS, jsonSchema, errors);
	const rootProps = isRecord(jsonSchema.properties) ? jsonSchema.properties : undefined;
	compareSchemaKeySet("carried_from", SIM_CARRIED_FROM_ALLOWED_KEYS, rootProps?.carried_from, errors);
	const defs = isRecord(jsonSchema.$defs) ? jsonSchema.$defs : undefined;
	compareSchemaKeySet("$defs.problem", SIM_PROBLEM_ALLOWED_KEYS, defs?.problem, errors);
	compareSchemaKeySet("$defs.attempt", SIM_ATTEMPT_ALLOWED_KEYS, defs?.attempt, errors);
	return { ok: errors.length === 0, errors };
}

function attemptHasUnresolved(attempt: SimAttempt): boolean {
	return (
		attempt.missed.length > 0 ||
		attempt.regressed.length > 0 ||
		(attempt.unproven?.length ?? 0) > 0 ||
		(attempt.unresolved?.length ?? 0) > 0 ||
		(attempt.incomplete?.length ?? 0) > 0
	);
}

function getLatestAttemptIndex(problem: SimProblem): number {
	let latestIdx = 0;
	let maxRound = problem.attempts[0]?.round ?? 0;
	for (let i = 1; i < problem.attempts.length; i++) {
		const round = problem.attempts[i].round;
		if (round >= maxRound) {
			maxRound = round;
			latestIdx = i;
		}
	}
	return latestIdx;
}

function getProblemMaxRound(problem: SimProblem): number {
	let maxRound = problem.opened_round;
	for (const attempt of problem.attempts) {
		if (attempt.round > maxRound) {
			maxRound = attempt.round;
		}
	}
	return maxRound;
}

function truncateText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, Math.max(1, limit - 3))}...`;
}

function cloneLedger(ledger: SimLedger): SimLedger {
	return {
		...(ledger.$schema !== undefined ? { $schema: ledger.$schema } : {}),
		...(ledger.schema_version !== undefined ? { schema_version: ledger.schema_version } : {}),
		next_id: ledger.next_id,
		...(ledger.carried_from !== undefined ? { carried_from: { ...ledger.carried_from } } : {}),
		aliases: { ...ledger.aliases },
		problems: ledger.problems.map(problem => ({
			id: problem.id,
			name: problem.name,
			opened_round: problem.opened_round,
			attempts: problem.attempts.map(attempt => ({
				...attempt,
				files: [...attempt.files],
				predicted: [...attempt.predicted],
				fixed: [...attempt.fixed],
				missed: [...attempt.missed],
				regressed: [...attempt.regressed],
				...(attempt.preserved !== undefined ? { preserved: [...attempt.preserved] } : {}),
				...(attempt.unresolved !== undefined ? { unresolved: [...attempt.unresolved] } : {}),
				...(attempt.unproven !== undefined ? { unproven: [...attempt.unproven] } : {}),
				...(attempt.incomplete !== undefined ? { incomplete: [...attempt.incomplete] } : {}),
			})),
		})),
	};
}

/**
 * Deterministically prune a validated SIM ledger to fit `maxChars` without a
 * retrieval/vector layer (OMPK-RSI §24.2).
 *
 * Preserves `schema_version`, `next_id`, `carried_from`, `aliases`, stable
 * problem IDs, and provenance (`model`, `domain`, `benchmark`), dropping older
 * solved attempts and lower-priority solved problems first while prioritizing
 * unresolved (`missed`/`regressed`/`unproven`) and highest-round entries.
 */
function pruneSimLedgerToBudget(ledger: SimLedger, maxChars: number): string {
	const working = cloneLedger(ledger);
	let serialized = JSON.stringify(working);
	if (serialized.length <= maxChars) {
		return serialized;
	}

	// Stage 1: Drop older attempts while keeping every problem's latest attempt.
	interface DroppableAttempt {
		problemId: string;
		problemNum: number;
		attemptRef: SimAttempt;
		unresolved: boolean;
		round: number;
		attemptIndex: number;
	}
	const droppableAttempts: DroppableAttempt[] = [];
	for (const problem of working.problems) {
		if (problem.attempts.length <= 1) continue;
		const latestIdx = getLatestAttemptIndex(problem);
		const problemNum = parseProblemNumber(problem.id) ?? Number.MAX_SAFE_INTEGER;
		for (let i = 0; i < problem.attempts.length; i++) {
			if (i === latestIdx) continue;
			const attempt = problem.attempts[i];
			droppableAttempts.push({
				problemId: problem.id,
				problemNum,
				attemptRef: attempt,
				unresolved: attemptHasUnresolved(attempt),
				round: attempt.round,
				attemptIndex: i,
			});
		}
	}
	droppableAttempts.sort((a, b) => {
		if (a.unresolved !== b.unresolved) return a.unresolved ? 1 : -1;
		if (a.round !== b.round) return a.round - b.round;
		if (a.problemNum !== b.problemNum) return a.problemNum - b.problemNum;
		return a.attemptIndex - b.attemptIndex;
	});
	for (const candidate of droppableAttempts) {
		const target = working.problems.find(p => p.id === candidate.problemId);
		if (!target || target.attempts.length <= 1) continue;
		target.attempts = target.attempts.filter(a => a !== candidate.attemptRef);
		serialized = JSON.stringify(working);
		if (serialized.length <= maxChars) {
			return serialized;
		}
	}

	// Deterministic lowest-priority-first ordering for problems:
	// solved before unresolved, then lowest max round, then lowest problem ID.
	const problemPriority = [...working.problems].sort((a, b) => {
		const aLatest = a.attempts[getLatestAttemptIndex(a)];
		const bLatest = b.attempts[getLatestAttemptIndex(b)];
		const aUnresolved = aLatest ? attemptHasUnresolved(aLatest) : false;
		const bUnresolved = bLatest ? attemptHasUnresolved(bLatest) : false;
		if (aUnresolved !== bUnresolved) return aUnresolved ? 1 : -1;
		const roundDiff = getProblemMaxRound(a) - getProblemMaxRound(b);
		if (roundDiff !== 0) return roundDiff;
		const aNum = parseProblemNumber(a.id) ?? Number.MAX_SAFE_INTEGER;
		const bNum = parseProblemNumber(b.id) ?? Number.MAX_SAFE_INTEGER;
		return aNum - bNum;
	});

	// Stage 2: Compact verbose `what` text on retained attempts before dropping any problem.
	for (const problem of problemPriority) {
		for (const attempt of problem.attempts) {
			if (attempt.what.length > 100) {
				attempt.what = truncateText(attempt.what, 100);
				serialized = JSON.stringify(working);
				if (serialized.length <= maxChars) {
					return serialized;
				}
			}
		}
	}

	// Stage 3: Drop lowest-priority problems while preserving root provenance and at least the highest-priority problem.
	for (const problem of problemPriority) {
		if (working.problems.length <= 1) break;
		working.problems = working.problems.filter(p => p.id !== problem.id);
		const survivingIds = new Set(working.problems.map(p => p.id));
		for (const [aliasKey, targetId] of Object.entries(working.aliases)) {
			if (aliasKey === problem.id || !survivingIds.has(targetId)) {
				delete working.aliases[aliasKey];
			}
		}
		serialized = JSON.stringify(working);
		if (serialized.length <= maxChars) {
			return serialized;
		}
	}

	// Final fallback for extremely tight budgets: tighten remaining problem text while keeping valid JSON & provenance.
	if (serialized.length > maxChars && working.problems.length === 1) {
		const lone = working.problems[0];
		lone.name = truncateText(lone.name, 60);
		for (const attempt of lone.attempts) {
			attempt.what = truncateText(attempt.what, 48);
		}
		serialized = JSON.stringify(working);
	}

	return serialized;
}

async function resolveStopDirectory(resolvedCwd: string): Promise<string> {
	try {
		const resolved = await repo.resolve(resolvedCwd);
		if (resolved?.repoRoot) {
			return path.resolve(resolved.repoRoot);
		}
	} catch {
		// Fall through to cwd-only lookup when git metadata is unavailable.
	}
	return resolvedCwd;
}

/**
 * Locate, strictly validate, and load `.omp/sim.json` by walking from `cwd` up
 * to the enclosing git repository root (or checking only `cwd` outside git).
 *
 * Returns the full JSON verbatim when under `maxChars`, deterministically pruned
 * valid JSON with `truncated: true` when over `maxChars`, or `null` if absent or
 * invalid.
 */
export async function loadSimLedger(cwd: string, options?: LoadSimLedgerOptions): Promise<SimLedgerContext | null> {
	const resolvedCwd = path.resolve(cwd);
	const stopDir = await resolveStopDirectory(resolvedCwd);
	const maxChars =
		typeof options?.maxChars === "number" && Number.isFinite(options.maxChars) && options.maxChars > 0
			? Math.floor(options.maxChars)
			: DEFAULT_SIM_LEDGER_MAX_CHARS;

	let current = resolvedCwd;
	while (true) {
		const candidate = path.join(current, ".omp", "sim.json");
		const file = Bun.file(candidate);
		try {
			const raw = await file.text();
			const trimmed = raw.trim();
			if (trimmed.length === 0) {
				return null;
			}
			const parsed: unknown = JSON.parse(trimmed);
			const validation = parseAndValidateSimLedger(parsed);
			if (!validation.ok) {
				logger.warn("Ignoring malformed SIM ledger (failed strict Appendix D.3 validation)", {
					path: candidate,
					errors: validation.errors,
				});
				return null;
			}
			const relative = path.relative(resolvedCwd, candidate);
			const displayPath = relative.length > 0 ? normalizePromptPath(relative) : SIM_LEDGER_RELATIVE_PATH;
			if (trimmed.length > maxChars) {
				const pruned = pruneSimLedgerToBudget(validation.ledger, maxChars);
				logger.debug("Pruned SIM ledger to fit context budget", {
					path: candidate,
					rawChars: trimmed.length,
					prunedChars: pruned.length,
					maxChars,
				});
				return {
					path: displayPath,
					content: pruned,
					truncated: true,
				};
			}
			return {
				path: displayPath,
				content: trimmed,
			};
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Failed to load SIM ledger", { path: candidate, error: String(error) });
				return null;
			}
		}

		if (current === stopDir) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return null;
}
