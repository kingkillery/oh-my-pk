import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateSimLedgerShape } from "../../packages/coding-agent/src/utils/sim-ledger";
import {
	computePredictionHash,
	createChangeManifest,
	DEFAULT_MANIFEST_PATH,
	markManifestConsumed,
	readChangeManifest,
	validateChangeManifest,
	writeChangeManifest,
} from "./manifest";
import { runSimReplay, SIM_REPLAY_CASES } from "./replay";
import {
	appendSimAttempt,
	carryForwardSimLedger,
	computeNextRound,
	createEmptySimLedger,
	evaluateReplayDiff,
	mergeDuplicateProblems,
	normalizeRootCauseName,
	resolveProblemId,
	SIM_SCHEMA_VERSION,
	type SimAttempt,
	type SimLedger,
	type SimReplayDiff,
	validateSimLedger,
	verifySimJsonSchemaParity,
} from "./schema";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sim-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error(`Expected ${label} to be an object`);
	}
	return value;
}

function requireStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
		throw new Error(`Expected ${label} to be a string[]`);
	}
	return value;
}

function makeValidAttempt(overrides: Partial<SimAttempt> = {}): SimAttempt {
	return {
		round: 1,
		accepted: true,
		what: "Fix parser edge case",
		files: ["packages/ai/src/utils/json-parse.ts"],
		model: "claude-opus-5.5",
		domain: "parsers",
		benchmark: "json-parse-repair",
		predicted: ["c1", "c2"],
		fixed: ["c1"],
		missed: ["c2"],
		regressed: [],
		passed: 15,
		total: 16,
		...overrides,
	};
}

function makeValidLedger(overrides: Partial<SimLedger> = {}): SimLedger {
	return {
		$schema: "./sim.schema.json",
		schema_version: SIM_SCHEMA_VERSION,
		next_id: 2,
		aliases: {},
		problems: [
			{
				id: "P1",
				name: "parser edge case root cause",
				opened_round: 1,
				attempts: [makeValidAttempt()],
			},
		],
		...overrides,
	};
}

function assertExactPredictedPartition(diff: SimReplayDiff): void {
	const buckets = [diff.fixed, diff.missed, diff.preserved, diff.unproven, diff.incomplete];
	const combined: string[] = [];
	const seen = new Set<string>();
	for (const bucket of buckets) {
		for (const id of bucket) {
			expect(seen.has(id)).toBe(false);
			seen.add(id);
			combined.push(id);
		}
	}
	expect(combined.length).toBe(diff.predicted.length);
	expect(new Set(combined)).toEqual(new Set(diff.predicted));
}

describe("Seeded .omp/sim.json compliance (G4, G5, G6)", () => {
	it("validates .omp/sim.json as schema_version 2 with P1-P6 complete provenance", async () => {
		const repoLedgerPath = path.resolve(import.meta.dir, "../../.omp/sim.json");
		const parsed: unknown = await Bun.file(repoLedgerPath).json();
		const result = validateSimLedger(parsed);
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);

		const ledger = requireRecord(parsed, ".omp/sim.json");
		expect(ledger.schema_version).toBe(2);
		expect(ledger.next_id).toBe(7);
		expect(ledger.aliases).toEqual({});
		expect(Array.isArray(ledger.problems)).toBe(true);

		const problems = Array.isArray(ledger.problems) ? ledger.problems : [];
		expect(problems).toHaveLength(6);

		const problemIds: string[] = [];
		const coveredCases = new Set<string>();
		for (let i = 0; i < problems.length; i++) {
			const problem = requireRecord(problems[i], `problems[${i}]`);
			expect(typeof problem.id).toBe("string");
			if (typeof problem.id === "string") problemIds.push(problem.id);
			const attempts = Array.isArray(problem.attempts) ? problem.attempts : [];
			expect(attempts.length).toBeGreaterThanOrEqual(1);
			for (let j = 0; j < attempts.length; j++) {
				const attempt = requireRecord(attempts[j], `problems[${i}].attempts[${j}]`);
				expect(attempt.accepted).toBe(true);
				expect(attempt.backfilled).toBe(true);
				expect(typeof attempt.benchmark).toBe("string");
				expect(String(attempt.benchmark).trim().length).toBeGreaterThan(0);
				expect(typeof attempt.sample).toBe("string");
				expect(String(attempt.sample).trim().length).toBeGreaterThan(0);
				expect(attempt.regressed).toEqual([]);
				for (const caseId of requireStringArray(attempt.predicted, "attempt.predicted")) {
					coveredCases.add(caseId);
				}
			}
		}

		expect(problemIds).toEqual(["P1", "P2", "P3", "P4", "P5", "P6"]);
		expect(coveredCases).toEqual(new Set(SIM_REPLAY_CASES.map(c => c.id)));
	});
});

describe("Strict schema allowlist & parity vs .omp/sim.schema.json (G7)", () => {
	it("matches .omp/sim.schema.json required keys, properties, and additionalProperties: false at every level", async () => {
		const schemaPath = path.resolve(import.meta.dir, "../../.omp/sim.schema.json");
		const schemaDoc = requireRecord(await Bun.file(schemaPath).json(), ".omp/sim.schema.json");
		const rootProps = requireRecord(schemaDoc.properties, "root.properties");
		const carriedFromSchema = requireRecord(rootProps.carried_from, "root.properties.carried_from");
		const carriedFromProps = requireRecord(carriedFromSchema.properties, "carried_from.properties");
		const defs = requireRecord(schemaDoc.$defs, "$defs");
		const problemSchema = requireRecord(defs.problem, "$defs.problem");
		const problemProps = requireRecord(problemSchema.properties, "problem.properties");
		const attemptSchema = requireRecord(defs.attempt, "$defs.attempt");
		const attemptProps = requireRecord(attemptSchema.properties, "attempt.properties");
		const acceptedSchema = requireRecord(attemptProps.accepted, "attempt.properties.accepted");

		expect(schemaDoc.additionalProperties).toBe(false);
		expect(carriedFromSchema.additionalProperties).toBe(false);
		expect(problemSchema.additionalProperties).toBe(false);
		expect(attemptSchema.additionalProperties).toBe(false);
		expect(acceptedSchema.const).toBe(true);

		const rootRequired = requireStringArray(schemaDoc.required, "root.required");
		const carriedRequired = requireStringArray(carriedFromSchema.required, "carried_from.required");
		const problemRequired = requireStringArray(problemSchema.required, "problem.required");
		const attemptRequired = requireStringArray(attemptSchema.required, "attempt.required");

		expect(rootRequired).toEqual(["next_id", "aliases", "problems"]);
		expect(carriedRequired).toEqual(["arm", "domain", "into"]);
		expect(problemRequired).toEqual(["id", "name", "opened_round", "attempts"]);
		expect(attemptRequired).toEqual([
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
			"passed",
			"total",
		]);

		// Full ledger populating every property declared in .omp/sim.schema.json must validate cleanly.
		const fullLedger: SimLedger = {
			$schema: "./sim.schema.json",
			schema_version: 2,
			next_id: 3,
			carried_from: {
				arm: "baseline-arm",
				domain: "parsers",
				into: "run-2",
				benchmark: "json-parse-repair",
				model: "claude-opus-5.5",
				carried_at: "2026-11-19T00:00:00.000Z",
			},
			aliases: { P2: "P1" },
			problems: [
				{
					id: "P1",
					name: "full property parity check",
					opened_round: 1,
					attempts: [
						{
							round: 1,
							accepted: true,
							what: "Exercise all attempt schema fields",
							files: ["scripts/sim/schema.ts"],
							model: "claude-opus-5.5",
							domain: "parsers",
							benchmark: "json-parse-repair",
							predicted: ["c-fix", "c-miss", "c-pres", "c-unp", "c-inc"],
							fixed: ["c-fix"],
							missed: ["c-miss"],
							regressed: ["c-reg"],
							preserved: ["c-pres"],
							unresolved: ["c-miss"],
							unproven: ["c-unp"],
							incomplete: ["c-inc"],
							passed: 14,
							total: 16,
							sample: "sample-1",
							backfilled: false,
							run: "run-2",
							baseline_ref: "base-001",
							candidate_ref: "cand-001",
							commit: "abc1234",
							timestamp: "2026-11-19T00:05:00.000Z",
							control_baseline: {
								baseline_type: "unchanged",
								baseline_score: 0.75,
								candidate_score: 0.875,
								delta: 0.125,
								notes: "full parity check",
							},
							claim_evidence: {
								claims_verified: 2,
								unsupported_claims: 0,
								evidence_refs: ["test://sim-parity"],
							},
						},
					],
				},
			],
		};

		expect(Object.keys(fullLedger).sort()).toEqual(Object.keys(rootProps).sort());
		expect(Object.keys(fullLedger.carried_from ?? {}).sort()).toEqual(Object.keys(carriedFromProps).sort());
		expect(Object.keys(fullLedger.problems[0] ?? {}).sort()).toEqual(Object.keys(problemProps).sort());
		expect(Object.keys(fullLedger.problems[0]?.attempts[0] ?? {}).sort()).toEqual(Object.keys(attemptProps).sort());
		expect(validateSimLedger(fullLedger)).toEqual({ ok: true, errors: [] });

		// Removing any required key at any level must fail validateSimLedger().
		for (const key of rootRequired) {
			const copy: Record<string, unknown> = { ...fullLedger };
			delete copy[key];
			expect(validateSimLedger(copy).ok).toBe(false);
		}
		for (const key of carriedRequired) {
			const carriedCopy: Record<string, unknown> = { ...fullLedger.carried_from };
			delete carriedCopy[key];
			expect(validateSimLedger({ ...fullLedger, carried_from: carriedCopy }).ok).toBe(false);
		}
		for (const key of problemRequired) {
			const problemCopy: Record<string, unknown> = { ...fullLedger.problems[0] };
			delete problemCopy[key];
			expect(validateSimLedger({ ...fullLedger, problems: [problemCopy] }).ok).toBe(false);
		}
		for (const key of attemptRequired) {
			const attemptCopy: Record<string, unknown> = { ...fullLedger.problems[0]?.attempts[0] };
			delete attemptCopy[key];
			const problemCopy = { ...fullLedger.problems[0], attempts: [attemptCopy] };
			expect(validateSimLedger({ ...fullLedger, problems: [problemCopy] }).ok).toBe(false);
		}
	});

	it("rejects unknown keys at root, carried_from, problem, and attempt levels", () => {
		const base = makeValidLedger({
			carried_from: { arm: "src", domain: "parsers", into: "dst" },
		});

		const rootExtra = validateSimLedger({ ...base, rogue_root: true });
		expect(rootExtra.ok).toBe(false);
		expect(rootExtra.errors.some(e => e.includes("root.rogue_root"))).toBe(true);

		const carriedExtra = validateSimLedger({
			...base,
			carried_from: { arm: "src", domain: "parsers", into: "dst", rogue_carried: 1 },
		});
		expect(carriedExtra.ok).toBe(false);
		expect(carriedExtra.errors.some(e => e.includes("carried_from.rogue_carried"))).toBe(true);

		const problemExtra = validateSimLedger({
			...base,
			problems: [{ ...base.problems[0], rogue_problem: "x" }],
		});
		expect(problemExtra.ok).toBe(false);
		expect(problemExtra.errors.some(e => e.includes("problems[0].rogue_problem"))).toBe(true);

		const attemptExtra = validateSimLedger({
			...base,
			problems: [
				{
					...base.problems[0],
					attempts: [{ ...base.problems[0]?.attempts[0], rogue_attempt: "y" }],
				},
			],
		});
		expect(attemptExtra.ok).toBe(false);
		expect(attemptExtra.errors.some(e => e.includes("problems[0].attempts[0].rogue_attempt"))).toBe(true);
	});

	it("rejects invalid optional field types and accepts legacy schema_version 1 with backfilled: true", () => {
		const badOptionalLedger: Record<string, unknown> = {
			$schema: "",
			schema_version: 99,
			next_id: 2,
			carried_from: {
				arm: "arm-a",
				domain: "parsers",
				into: "run-b",
				benchmark: "",
				model: "",
				carried_at: 123,
			},
			aliases: {},
			problems: [
				{
					id: "P1",
					name: "invalid optional types",
					opened_round: 1,
					attempts: [
						{
							...makeValidAttempt(),
							backfilled: "yes",
							sample: 123,
							run: "",
							baseline_ref: 42,
							candidate_ref: "",
							commit: "",
							timestamp: false,
							preserved: [42],
							unresolved: [""],
							unproven: "not-an-array",
							incomplete: ["c1", "c1"],
						},
					],
				},
			],
		};

		const result = validateSimLedger(badOptionalLedger);
		expect(result.ok).toBe(false);
		expect(result.errors.some(e => e.includes("root.$schema"))).toBe(true);
		expect(result.errors.some(e => e.includes("root.schema_version"))).toBe(true);
		expect(result.errors.some(e => e.includes("carried_from.benchmark"))).toBe(true);
		expect(result.errors.some(e => e.includes("carried_from.model"))).toBe(true);
		expect(result.errors.some(e => e.includes("carried_from.carried_at"))).toBe(true);
		expect(result.errors.some(e => e.includes(".backfilled"))).toBe(true);
		expect(result.errors.some(e => e.includes(".sample"))).toBe(true);
		expect(result.errors.some(e => e.includes(".run"))).toBe(true);
		expect(result.errors.some(e => e.includes(".baseline_ref"))).toBe(true);
		expect(result.errors.some(e => e.includes(".candidate_ref"))).toBe(true);
		expect(result.errors.some(e => e.includes(".commit"))).toBe(true);
		expect(result.errors.some(e => e.includes(".timestamp"))).toBe(true);
		expect(result.errors.some(e => e.includes(".preserved[0]"))).toBe(true);
		expect(result.errors.some(e => e.includes(".unresolved[0]"))).toBe(true);
		expect(result.errors.some(e => e.includes(".unproven"))).toBe(true);
		expect(result.errors.some(e => e.includes(".incomplete[1]"))).toBe(true);

		// Legacy schema_version: 1 with backfilled: true remains valid for read compatibility.
		const legacyV1 = makeValidLedger({
			schema_version: 1,
			problems: [
				{
					id: "P1",
					name: "legacy backfilled record",
					opened_round: 1,
					attempts: [makeValidAttempt({ backfilled: true, sample: "legacy-seed" })],
				},
			],
		});
		expect(validateSimLedger(legacyV1)).toEqual({ ok: true, errors: [] });
	});

	it("rejects accepted: false, passed > total, broken/cyclic aliases, stale next_id, and partition violations", () => {
		const broken = {
			schema_version: 2,
			next_id: 2,
			aliases: {
				P9: "P99",
				P10: "P11",
				P11: "P10",
				P12: "P12",
			},
			problems: [
				{
					id: "P2",
					name: "broken entry",
					opened_round: 1,
					attempts: [
						{
							round: 1,
							accepted: false,
							what: "test",
							files: ["a.ts"],
							model: "claude-opus-5.5",
							domain: "parsers",
							benchmark: "json-parse-repair",
							predicted: ["c1", "c2", "c3"],
							fixed: ["c1", "c-extra"],
							missed: ["c1"],
							regressed: [],
							preserved: ["c3"],
							passed: 5,
							total: 4,
						},
					],
				},
			],
		};

		const result = validateSimLedger(broken);
		expect(result.ok).toBe(false);
		expect(result.errors.some(e => e.includes("accepted must be true"))).toBe(true);
		expect(result.errors.some(e => e.includes("passed (5) cannot exceed total (4)"))).toBe(true);
		expect(result.errors.some(e => e.includes("cannot appear in both fixed and missed"))).toBe(true);
		expect(result.errors.some(e => e.includes('fixed contains "c-extra" which is not in predicted'))).toBe(true);
		expect(
			result.errors.some(e =>
				e.includes('predicted contains "c2" missing from fixed/missed/preserved/unproven/incomplete'),
			),
		).toBe(true);
		expect(result.errors.some(e => e.includes('resolves to "P99", which is not an active problem'))).toBe(true);
		expect(result.errors.some(e => e.includes("Alias cycle detected"))).toBe(true);
		expect(result.errors.some(e => e.includes("cannot alias itself"))).toBe(true);
		expect(result.errors.some(e => e.includes("next_id (2) must be strictly greater"))).toBe(true);
	});
});

describe("8-state baseline-to-candidate attribution matrix (G5, §24.1, RSI-01/02/03/21)", () => {
	it("classifies all 8 baseline->candidate transitions accurately and maintains disjoint predicted partition", () => {
		const baseline = {
			passed_ids: ["c-pass-pass", "u-pass-pass", "c-pass-fail", "u-pass-fail", "c-pass-unk"],
			failed_ids: ["c-fail-pass", "u-fail-pass", "c-fail-fail", "u-fail-fail", "c-fail-unk"],
			model: "claude-opus-5.5",
		};
		const candidateReport = {
			passed_ids: ["c-fail-pass", "u-fail-pass", "c-pass-pass", "u-pass-pass", "c-unk-pass"],
			failed_ids: ["c-pass-fail", "u-pass-fail", "c-fail-fail", "u-fail-fail", "c-unk-fail"],
			model: "claude-opus-5.5",
		};
		const predicted = [
			"c-fail-pass",
			"c-pass-pass",
			"c-pass-fail",
			"c-fail-fail",
			"c-unk-pass",
			"c-unk-fail",
			"c-pass-unk",
			"c-fail-unk",
		];

		const diff = evaluateReplayDiff(candidateReport, predicted, baseline);

		// RSI-01: FAIL -> PASS => fixed (+ newly_passing)
		expect(diff.fixed).toEqual(["c-fail-pass"]);
		expect(diff.newly_passing).toEqual(["c-fail-pass", "u-fail-pass"]);
		// RSI-02: PASS -> PASS => preserved, NEVER fixed
		expect(diff.preserved).toEqual(["c-pass-pass"]);
		expect(diff.fixed).not.toContain("c-pass-pass");
		// PASS -> FAIL => regressed (suite-wide) + missed (if predicted)
		expect(diff.regressed).toEqual(["c-pass-fail", "u-pass-fail"]);
		// FAIL -> FAIL => unresolved (suite-wide) + missed (if predicted)
		expect(diff.unresolved).toEqual(["c-fail-fail", "u-fail-fail"]);
		expect(diff.missed).toEqual(["c-pass-fail", "c-fail-fail"]);
		// UNKNOWN -> PASS & UNKNOWN -> FAIL => unproven, NEVER fixed
		expect(diff.unproven).toEqual(["c-unk-pass", "c-unk-fail"]);
		expect(diff.fixed).not.toContain("c-unk-pass");
		// PASS -> UNKNOWN & FAIL -> UNKNOWN => incomplete
		expect(diff.incomplete).toEqual(["c-pass-unk", "c-fail-unk"]);
		expect(diff.model_mismatch).toBeUndefined();
		assertExactPredictedPartition(diff);
	});

	it("classifies predicted cases as unproven with fixed: [] when baseline is missing (RSI-03)", () => {
		const diff = evaluateReplayDiff(
			{
				passed_ids: ["c1", "c2"],
				failed_ids: ["c3"],
			},
			["c1", "c2", "c3"],
			undefined,
		);

		expect(diff.fixed).toEqual([]);
		expect(diff.missed).toEqual([]);
		expect(diff.preserved).toEqual([]);
		expect(diff.regressed).toEqual([]);
		expect(diff.unresolved).toEqual([]);
		expect(diff.unproven).toEqual(["c1", "c2", "c3"]);
		expect(diff.incomplete).toEqual([]);
		expect(diff.newly_passing).toEqual([]);
		expect(diff.model_mismatch).toBeUndefined();
		assertExactPredictedPartition(diff);

		// Even when a predicted ID is absent from candidate without a baseline, fixed stays empty and partition holds.
		const withMissingCandidate = evaluateReplayDiff(
			{ passed_ids: ["c1"], failed_ids: [] },
			["c1", "c-not-run"],
			undefined,
		);
		expect(withMissingCandidate.fixed).toEqual([]);
		expect(withMissingCandidate.unproven).toEqual(["c1"]);
		expect(withMissingCandidate.incomplete).toEqual(["c-not-run"]);
		assertExactPredictedPartition(withMissingCandidate);
	});

	it("invalidates comparison on baseline vs candidate model mismatch (RSI-21)", () => {
		const baseline = {
			passed_ids: [],
			failed_ids: ["c1", "c2"],
			model: "claude-opus-5.5",
		};

		const viaOption = evaluateReplayDiff({ passed_ids: ["c1", "c2"], failed_ids: [] }, ["c1", "c2"], baseline, {
			candidateModel: "gemini-3.8-flash",
		});
		expect(viaOption.model_mismatch).toEqual({
			baselineModel: "claude-opus-5.5",
			candidateModel: "gemini-3.8-flash",
		});
		expect(viaOption.fixed).toEqual([]);
		expect(viaOption.missed).toEqual([]);
		expect(viaOption.preserved).toEqual([]);
		expect(viaOption.regressed).toEqual([]);
		expect(viaOption.unresolved).toEqual([]);
		expect(viaOption.incomplete).toEqual([]);
		expect(viaOption.newly_passing).toEqual([]);
		expect(viaOption.unproven).toEqual(["c1", "c2"]);
		assertExactPredictedPartition(viaOption);

		const viaReportModel = evaluateReplayDiff(
			{ passed_ids: ["c1"], failed_ids: [], model: "gpt-5.4" },
			["c1"],
			baseline,
		);
		expect(viaReportModel.model_mismatch).toEqual({
			baselineModel: "claude-opus-5.5",
			candidateModel: "gpt-5.4",
		});
		expect(viaReportModel.fixed).toEqual([]);
		expect(viaReportModel.unproven).toEqual(["c1"]);
		assertExactPredictedPartition(viaReportModel);
	});
});

describe("Pre-eval change manifest integrity (G1)", () => {
	it("creates deterministic manifests and rejects empty/duplicate predicted or unnamed new problems", () => {
		expect(DEFAULT_MANIFEST_PATH.endsWith(path.join(".omp", "sim-manifest.json"))).toBe(true);

		const manifest = createChangeManifest({
			problem: "new",
			name: "unescaped newline in tool JSON",
			predicted: ["parser-json-unescaped-controls", "parser-json-invalid-escapes"],
			round: 1,
			files: ["packages/ai/src/utils/json-parse.ts"],
			model: "claude-opus-5.5",
			domain: "parsers",
			benchmark: "json-parse-repair",
			manifestId: "manifest-fixed-01",
			createdAt: "2026-11-19T00:00:00.000Z",
		});

		expect(manifest.version).toBe(1);
		expect(manifest.status).toBe("pending");
		expect(manifest.manifest_id).toBe("manifest-fixed-01");
		expect(manifest.prediction_hash).toMatch(/^[a-f0-9]{64}$/);
		expect(manifest.prediction_hash).toBe(
			computePredictionHash({
				problem: "new",
				name: "unescaped newline in tool JSON",
				predicted: ["parser-json-unescaped-controls", "parser-json-invalid-escapes"],
			}),
		);
		expect(validateChangeManifest(manifest)).toEqual({ ok: true, errors: [] });

		expect(() => createChangeManifest({ problem: "P1", predicted: [] })).toThrow(/at least one predicted/i);
		expect(() => createChangeManifest({ problem: "P1", predicted: ["   "] })).toThrow(/at least one predicted/i);
		expect(() => createChangeManifest({ problem: "P1", predicted: ["c1", "c1"] })).toThrow(/must be unique/i);
		expect(() => createChangeManifest({ problem: "P1", predicted: ["c1", " c1 "] })).toThrow(/must be unique/i);
		expect(() => createChangeManifest({ problem: "new", predicted: ["c1"] })).toThrow(/requires a non-empty name/i);
		expect(() => createChangeManifest({ problem: "new", name: "   ", predicted: ["c1"] })).toThrow(
			/requires a non-empty name/i,
		);
		expect(() => createChangeManifest({ problem: "P0", predicted: ["c1"] })).toThrow(/Invalid manifest problem/i);
		expect(() => createChangeManifest({ problem: "P1", predicted: ["c1"], round: 0 })).toThrow(/positive integer/i);
	});

	it("detects post-hoc tampering of predicted, problem, or name and rejects unknown keys or invalid status", async () => {
		const fresh = createChangeManifest({
			problem: "new",
			name: "original root cause",
			predicted: ["case-a", "case-b"],
			createdAt: "2026-11-19T00:00:00.000Z",
		});
		expect(validateChangeManifest(fresh).ok).toBe(true);

		const tamperedPredicted = validateChangeManifest({ ...fresh, predicted: ["case-a"] });
		expect(tamperedPredicted.ok).toBe(false);
		expect(tamperedPredicted.errors.some(e => e.includes("prediction_hash mismatch"))).toBe(true);

		const tamperedProblem = validateChangeManifest({ ...fresh, problem: "P1" });
		expect(tamperedProblem.ok).toBe(false);
		expect(tamperedProblem.errors.some(e => e.includes("prediction_hash mismatch"))).toBe(true);

		const tamperedName = validateChangeManifest({ ...fresh, name: "post-hoc rewritten root cause" });
		expect(tamperedName.ok).toBe(false);
		expect(tamperedName.errors.some(e => e.includes("prediction_hash mismatch"))).toBe(true);

		const unknownKey = validateChangeManifest({ ...fresh, injected: true });
		expect(unknownKey.ok).toBe(false);
		expect(unknownKey.errors.some(e => e.includes("manifest.injected"))).toBe(true);

		const badStatus = validateChangeManifest({ ...fresh, status: "expired" });
		expect(badStatus.ok).toBe(false);
		expect(badStatus.errors.some(e => e.includes("manifest.status"))).toBe(true);

		const consumedWithoutTimestamp = validateChangeManifest({ ...fresh, status: "consumed" });
		expect(consumedWithoutTimestamp.ok).toBe(false);
		expect(consumedWithoutTimestamp.errors.some(e => e.includes("consumed_at is required"))).toBe(true);

		// markManifestConsumed transitions pending -> consumed and validates cleanly.
		const consumed = markManifestConsumed(fresh, "2026-11-19T01:00:00.000Z");
		expect(consumed.status).toBe("consumed");
		expect(consumed.consumed_at).toBe("2026-11-19T01:00:00.000Z");
		expect(consumed.prediction_hash).toBe(fresh.prediction_hash);
		expect(validateChangeManifest(consumed)).toEqual({ ok: true, errors: [] });

		// Disk round-trip and tamper rejection on read.
		const dir = makeTempDir();
		const manifestPath = path.join(dir, "sim-manifest.json");
		await writeChangeManifest(manifestPath, fresh);
		const loaded = await readChangeManifest(manifestPath);
		expect(loaded).toEqual(fresh);

		const tamperedJson = JSON.stringify({ ...fresh, predicted: ["case-a", "case-b", "case-c"] });
		fs.writeFileSync(manifestPath, tamperedJson, "utf-8");
		await expect(readChangeManifest(manifestPath)).rejects.toThrow(/prediction_hash mismatch/i);
	});
});

describe("§3.2 chosen-candidate recording and Appendix F.2 retention (G3)", () => {
	it("refuses accepted: false without mutating ledger or bumping next_id", () => {
		const initial = makeValidLedger();
		const snapshot = structuredClone(initial);

		const rejectedNew = appendSimAttempt(initial, {
			problem: "new",
			name: "rejected candidate root cause",
			round: 2,
			accepted: false,
			what: "Did not pass gate",
			files: ["packages/ai/src/utils/json-parse.ts"],
			model: "claude-opus-5.5",
			domain: "parsers",
			benchmark: "json-parse-repair",
			predicted: ["c2"],
			fixed: [],
			missed: ["c2"],
			regressed: ["c1"],
			passed: 14,
			total: 16,
		});

		expect(rejectedNew.recorded).toBe(false);
		expect(rejectedNew.createdProblem).toBe(false);
		expect(rejectedNew.ledger).toBe(initial);
		expect(initial).toEqual(snapshot);
		if (!rejectedNew.recorded) {
			expect(rejectedNew.reason).toContain("§3.2");
		}

		const rejectedExisting = appendSimAttempt(initial, {
			problem: "P1",
			round: 2,
			accepted: false,
			what: "Rejected follow-up on P1",
			files: ["packages/ai/src/utils/json-parse.ts"],
			model: "claude-opus-5.5",
			domain: "parsers",
			benchmark: "json-parse-repair",
			predicted: ["c2"],
			fixed: [],
			missed: ["c2"],
			regressed: [],
			passed: 15,
			total: 16,
		});

		expect(rejectedExisting.recorded).toBe(false);
		expect(rejectedExisting.ledger).toBe(initial);
		expect(initial).toEqual(snapshot);
	});

	it("preserves unresolved missed predictions on accepted attempts (Appendix F.2)", () => {
		const empty = createEmptySimLedger();
		expect(empty.schema_version).toBe(SIM_SCHEMA_VERSION);

		const first = appendSimAttempt(empty, {
			problem: "new",
			name: "premature termination on feasible but suboptimal solutions",
			round: 1,
			accepted: true,
			what: "Add feasibility vs optimality notice to completion prompt",
			files: ["packages/coding-agent/src/prompts/system/system-prompt.md"],
			model: "gemini-3.8-flash",
			domain: "hooks-and-prompts",
			benchmark: "completion-optimality",
			predicted: ["case-opt-a", "case-opt-b"],
			fixed: [],
			missed: ["case-opt-a", "case-opt-b"],
			regressed: [],
			passed: 14,
			total: 16,
		});

		expect(first.recorded).toBe(true);
		if (!first.recorded) throw new Error("Expected first attempt to be recorded");
		expect(first.createdProblem).toBe(true);
		expect(first.problemId).toBe("P1");
		expect(first.ledger.next_id).toBe(2);

		// Exact normalized text match merges into P1 and preserves prior missed record.
		const second = appendSimAttempt(first.ledger, {
			problem: "new",
			name: "  premature termination   on feasible but suboptimal solutions  ",
			round: 2,
			accepted: true,
			what: "Follow-up active completion gate check",
			files: ["packages/coding-agent/src/tools/approval.ts"],
			model: "gemini-3.8-flash",
			domain: "hooks-and-prompts",
			benchmark: "completion-optimality",
			predicted: ["case-opt-a", "case-opt-b"],
			fixed: ["case-opt-a"],
			missed: ["case-opt-b"],
			regressed: [],
			passed: 15,
			total: 16,
		});

		expect(second.recorded).toBe(true);
		if (!second.recorded) throw new Error("Expected second attempt to be recorded");
		expect(second.createdProblem).toBe(false);
		expect(second.problemId).toBe("P1");
		expect(second.ledger.problems).toHaveLength(1);
		expect(second.ledger.problems[0]?.attempts).toHaveLength(2);
		expect(second.ledger.problems[0]?.attempts[0]?.missed).toEqual(["case-opt-a", "case-opt-b"]);
		expect(second.ledger.problems[0]?.attempts[1]?.fixed).toEqual(["case-opt-a"]);
		expect(second.ledger.problems[0]?.attempts[1]?.missed).toEqual(["case-opt-b"]);
		expect(validateSimLedger(second.ledger)).toEqual({ ok: true, errors: [] });
	});
});

describe("Carry-forward & per-run round scoping (G2, G8)", () => {
	it("sets carried_from without losing history and restarts computeNextRound at 1 for the new run", () => {
		const source = makeValidLedger({
			next_id: 5,
			aliases: { P4: "P1" },
			problems: [
				{
					id: "P1",
					name: "parser edge case root cause",
					opened_round: 1,
					attempts: [
						makeValidAttempt({ round: 1, domain: "parsers", benchmark: "json-parse-repair" }),
						makeValidAttempt({ round: 3, domain: "parsers", benchmark: "json-parse-repair" }),
					],
				},
			],
		});

		expect(computeNextRound(createEmptySimLedger())).toBe(1);
		expect(computeNextRound(source)).toBe(4);

		expect(() => carryForwardSimLedger(source, { arm: " ", domain: "parsers", into: "run-2" })).toThrow(
			/non-empty arm/,
		);
		expect(() => carryForwardSimLedger(source, { arm: "src", domain: "", into: "run-2" })).toThrow(
			/non-empty domain/,
		);
		expect(() => carryForwardSimLedger(source, { arm: "src", domain: "parsers", into: "" })).toThrow(
			/non-empty into/,
		);

		const carried = carryForwardSimLedger(source, {
			arm: "claude-parsers-v1",
			domain: "parsers",
			into: "gemini-parsers-v2",
			benchmark: "json-parse-repair",
			model: "claude-opus-5.5",
			carriedAt: "2026-11-19T02:00:00.000Z",
		});

		expect(carried.schema_version).toBe(2);
		expect(carried.next_id).toBe(5);
		expect(carried.aliases).toEqual({ P4: "P1" });
		expect(carried.problems).toHaveLength(1);
		expect(carried.carried_from).toEqual({
			arm: "claude-parsers-v1",
			domain: "parsers",
			into: "gemini-parsers-v2",
			benchmark: "json-parse-repair",
			model: "claude-opus-5.5",
			carried_at: "2026-11-19T02:00:00.000Z",
		});
		expect(source.carried_from).toBeUndefined();
		expect(validateSimLedger(carried)).toEqual({ ok: true, errors: [] });

		// Same domain and benchmark, new run => round restarts at 1.
		expect(computeNextRound(carried)).toBe(1);

		const firstInNewRun = appendSimAttempt(carried, {
			problem: "P1",
			round: computeNextRound(carried),
			accepted: true,
			what: "Cross-model transfer attempt 1",
			files: ["packages/ai/src/utils/json-parse.ts"],
			model: "gemini-3.8-flash",
			domain: "parsers",
			benchmark: "json-parse-repair",
			predicted: ["c2"],
			fixed: ["c2"],
			missed: [],
			regressed: [],
			passed: 16,
			total: 16,
		});
		expect(firstInNewRun.recorded).toBe(true);
		if (!firstInNewRun.recorded) throw new Error("Expected attempt to record");
		const stampedAttempt = firstInNewRun.ledger.problems[0]?.attempts.at(-1);
		expect(stampedAttempt?.round).toBe(1);
		expect(stampedAttempt?.run).toBe("gemini-parsers-v2");
		expect(computeNextRound(firstInNewRun.ledger)).toBe(2);

		const secondInNewRun = appendSimAttempt(firstInNewRun.ledger, {
			problem: "P1",
			round: computeNextRound(firstInNewRun.ledger),
			accepted: true,
			what: "Cross-model transfer attempt 2",
			files: ["packages/ai/src/utils/json-parse.ts"],
			model: "gemini-3.8-flash",
			domain: "parsers",
			benchmark: "json-parse-repair",
			predicted: ["c2"],
			fixed: [],
			missed: [],
			preserved: ["c2"],
			regressed: [],
			passed: 16,
			total: 16,
		});
		expect(secondInNewRun.recorded).toBe(true);
		if (!secondInNewRun.recorded) throw new Error("Expected second attempt to record");
		expect(secondInNewRun.ledger.problems[0]?.attempts.at(-1)?.round).toBe(2);
		expect(computeNextRound(secondInNewRun.ledger)).toBe(3);
		expect(computeNextRound(secondInNewRun.ledger, { run: "brand-new-run" })).toBe(1);
		expect(computeNextRound(secondInNewRun.ledger, { run: "gemini-parsers-v2" })).toBe(3);
		expect(validateSimLedger(secondInNewRun.ledger)).toEqual({ ok: true, errors: [] });
	});
});

describe("Deterministic exact-text merging & alias resolution (Appendix D.1)", () => {
	it("merges exact whitespace-normalized duplicates, flattens transitive aliases, and preserves case sensitivity", () => {
		const duplicated: SimLedger = {
			schema_version: 2,
			next_id: 9,
			aliases: { P7: "P6" },
			problems: [
				{
					id: "P5",
					name: "premature completion without execution verification",
					opened_round: 2,
					attempts: [
						makeValidAttempt({
							round: 2,
							what: "Initial interlock",
							files: ["a.ts"],
							domain: "coding",
							benchmark: "completion-gate",
							predicted: ["t1"],
							fixed: ["t1"],
							missed: [],
							passed: 10,
							total: 16,
						}),
					],
				},
				{
					id: "P6",
					name: "  premature completion without   execution verification",
					opened_round: 4,
					attempts: [
						makeValidAttempt({
							round: 4,
							what: "Follow-up recalibration for Gemini",
							files: ["b.ts"],
							model: "gemini-3.8-flash",
							domain: "coding",
							benchmark: "completion-gate",
							predicted: ["t2"],
							fixed: [],
							missed: ["t2"],
							passed: 12,
							total: 16,
						}),
					],
				},
				{
					id: "P8",
					name: "Premature completion without execution verification",
					opened_round: 5,
					attempts: [
						makeValidAttempt({
							round: 5,
							what: "Different case stays distinct per Appendix D.1",
							files: ["c.ts"],
							domain: "coding",
							benchmark: "completion-gate",
							predicted: ["t3"],
							fixed: ["t3"],
							missed: [],
							passed: 13,
							total: 16,
						}),
					],
				},
			],
		};

		expect(normalizeRootCauseName("  foo   bar\t")).toBe("foo bar");
		expect(normalizeRootCauseName("Foo bar")).not.toBe(normalizeRootCauseName("foo bar"));

		const { ledger, merged } = mergeDuplicateProblems(duplicated);
		expect(merged).toEqual([
			{
				from: "P6",
				into: "P5",
				name: "premature completion without execution verification",
			},
		]);
		expect(ledger.aliases).toEqual({ P6: "P5", P7: "P5" });
		expect(ledger.problems.map(p => p.id)).toEqual(["P5", "P8"]);
		expect(ledger.problems[0]?.attempts).toHaveLength(2);
		expect(resolveProblemId(ledger, "P6")).toBe("P5");
		expect(resolveProblemId(ledger, "P7")).toBe("P5");
		expect(() => resolveProblemId({ aliases: { P1: "P2", P2: "P1" } }, "P1")).toThrow(/Alias cycle detected/);
		expect(validateSimLedger(ledger)).toEqual({ ok: true, errors: [] });

		// Appending via retired alias P6 routes transparently to canonical P5.
		const appended = appendSimAttempt(ledger, {
			problem: "P6",
			round: 6,
			accepted: true,
			what: "Third attempt via retired alias",
			files: ["d.ts"],
			model: "gemini-3.8-flash",
			domain: "coding",
			benchmark: "completion-gate",
			predicted: ["t2"],
			fixed: ["t2"],
			missed: [],
			regressed: [],
			passed: 16,
			total: 16,
		});
		expect(appended.recorded).toBe(true);
		if (!appended.recorded) throw new Error("Expected alias append to record");
		expect(appended.problemId).toBe("P5");
		expect(appended.mergedFromAlias).toBe("P6");
		expect(appended.ledger.problems[0]?.attempts).toHaveLength(3);
		expect(validateSimLedger(appended.ledger)).toEqual({ ok: true, errors: [] });
	});
});

describe("Live 16-case replay smoke (runSimReplay)", () => {
	it("runs all 16 deterministic replay cases including system-prompt-sim-and-prefix-stability", async () => {
		expect(SIM_REPLAY_CASES.length).toBe(16);
		expect(SIM_REPLAY_CASES.length).toBeGreaterThanOrEqual(10);
		expect(SIM_REPLAY_CASES.length).toBeLessThanOrEqual(20);

		const report = await runSimReplay();
		expect(report.total).toBe(SIM_REPLAY_CASES.length);
		expect(report.passed).toBe(report.total);
		expect(report.failed_ids).toEqual([]);
		expect(report.passed_ids).toContain("system-prompt-sim-and-prefix-stability");
	});
});

describe("SIM schema single source of truth, JSON Schema parity & shared fixtures", () => {
	it("shares the exact runtime validator between CLI and prompt loader and matches .omp/sim.schema.json", () => {
		expect(validateSimLedger).toBe(validateSimLedgerShape);

		const schemaPath = path.resolve(import.meta.dir, "../../.omp/sim.schema.json");
		const jsonSchema: Record<string, unknown> = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
		expect(verifySimJsonSchemaParity(jsonSchema)).toEqual({ ok: true, errors: [] });

		const driftedSchema = structuredClone(jsonSchema);
		const rootProps = driftedSchema.properties;
		if (typeof rootProps === "object" && rootProps !== null && !Array.isArray(rootProps)) {
			Reflect.set(rootProps, "unexpected_future_field", { type: "string" });
		}
		const driftedResult = verifySimJsonSchemaParity(driftedSchema);
		expect(driftedResult.ok).toBe(false);
		expect(driftedResult.errors.some(e => e.includes("unexpected_future_field"))).toBe(true);
	});

	it("validates every case in .omp/fixtures/sim-validator-cases.json against expected verdicts", () => {
		const fixturePath = path.resolve(import.meta.dir, "../../.omp/fixtures/sim-validator-cases.json");
		const cases: Array<{
			id: string;
			expectedOk: boolean;
			expectedErrorSubstring?: string;
			ledger: unknown;
		}> = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
		expect(cases.length).toBeGreaterThan(0);
		for (const item of cases) {
			const res = validateSimLedger(item.ledger);
			expect(res.ok).toBe(item.expectedOk);
			if (!item.expectedOk && item.expectedErrorSubstring) {
				expect(res.errors.some(err => err.includes(item.expectedErrorSubstring!))).toBe(true);
			}
		}
	});
});
