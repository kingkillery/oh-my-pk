import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSimCli } from "./cli";
import { runSimReplay, SIM_REPLAY_CASES } from "./replay";
import {
	appendSimAttempt,
	createEmptySimLedger,
	evaluateReplayDiff,
	mergeDuplicateProblems,
	resolveProblemId,
	type SimLedger,
	validateSimLedger,
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

describe("SIM schema validation and deterministic merging", () => {
	it("validates the repository .omp/sim.json ledger cleanly", async () => {
		const repoLedgerPath = path.resolve(import.meta.dir, "../../.omp/sim.json");
		const parsed: unknown = await Bun.file(repoLedgerPath).json();
		const result = validateSimLedger(parsed);
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it("rejects invalid invariants: fixed/missed mismatch, passed > total, broken alias, stale next_id", () => {
		const broken: SimLedger = {
			next_id: 2,
			aliases: { P9: "P99" },
			problems: [
				{
					id: "P2",
					name: "broken entry",
					opened_round: 1,
					attempts: [
						{
							round: 1,
							accepted: true,
							what: "test",
							files: ["a.ts"],
							model: "claude-opus",
							domain: "parsers",
							predicted: ["c1", "c2"],
							fixed: ["c1"],
							missed: [],
							passed: 5,
							total: 4,
						},
					],
				},
			],
		};

		const result = validateSimLedger(broken);
		expect(result.ok).toBe(false);
		expect(result.errors.some(e => e.includes("passed (5) cannot exceed total (4)"))).toBe(true);
		expect(result.errors.some(e => e.includes('predicted item "c2" is missing from both fixed and missed'))).toBe(
			true,
		);
		expect(result.errors.some(e => e.includes('points to unknown problem ID "P99"'))).toBe(true);
		expect(result.errors.some(e => e.includes("next_id (2) must be strictly greater"))).toBe(true);
	});

	it("preserves unresolved predictions on accepted attempts (Appendix F.2 P8 contract)", () => {
		const empty = createEmptySimLedger();
		const first = appendSimAttempt(empty, {
			problemId: "new",
			name: "premature termination on feasible but suboptimal solutions",
			accepted: true,
			what: "Add feasibility vs optimality notice to completion prompt",
			files: ["packages/coding-agent/src/prompts/system/system-prompt.md"],
			model: "gemini-3.8-flash",
			domain: "hooks-and-prompts",
			predicted: ["case-opt-a", "case-opt-b"],
			fixed: [],
			missed: ["case-opt-a", "case-opt-b"],
			passed: 14,
			total: 16,
		});

		expect(first.createdProblem).toBe(true);
		expect(first.problemId).toBe("P1");
		expect(first.ledger.next_id).toBe(2);

		// Appending by exact text (even with extra whitespace) deterministically merges into P1.
		const second = appendSimAttempt(first.ledger, {
			name: "  premature termination   on feasible but suboptimal solutions  ",
			accepted: true,
			what: "Follow-up active completion gate check",
			files: ["packages/coding-agent/src/tools/approval.ts"],
			model: "gemini-3.8-flash",
			domain: "hooks-and-prompts",
			predicted: ["case-opt-a", "case-opt-b"],
			fixed: ["case-opt-a"],
			missed: ["case-opt-b"],
			passed: 15,
			total: 16,
		});

		expect(second.createdProblem).toBe(false);
		expect(second.problemId).toBe("P1");
		expect(second.ledger.problems).toHaveLength(1);
		expect(second.ledger.problems[0]?.attempts).toHaveLength(2);
		expect(second.ledger.problems[0]?.attempts[0]?.missed).toEqual(["case-opt-a", "case-opt-b"]);
		expect(second.ledger.problems[0]?.attempts[1]?.fixed).toEqual(["case-opt-a"]);
	});

	it("deterministically merges duplicate root-cause entries and resolves alias chains", () => {
		const duplicated: SimLedger = {
			next_id: 7,
			aliases: {},
			problems: [
				{
					id: "P5",
					name: "premature completion without execution verification",
					opened_round: 2,
					attempts: [
						{
							round: 2,
							accepted: true,
							what: "Initial interlock",
							files: ["a.ts"],
							model: "claude-opus-5.5",
							domain: "coding",
							predicted: ["t1"],
							fixed: ["t1"],
							missed: [],
							passed: 10,
							total: 16,
						},
					],
				},
				{
					id: "P6",
					name: "  premature completion without   execution verification",
					opened_round: 4,
					attempts: [
						{
							round: 4,
							accepted: true,
							what: "Follow-up recalibration for Gemini",
							files: ["b.ts"],
							model: "gemini-3.8-flash",
							domain: "coding",
							predicted: ["t2"],
							fixed: [],
							missed: ["t2"],
							passed: 12,
							total: 16,
						},
					],
				},
			],
		};

		const { ledger, merged } = mergeDuplicateProblems(duplicated);
		expect(merged).toEqual([["P6", "P5"]]);
		expect(ledger.aliases).toEqual({ P6: "P5" });
		expect(ledger.problems).toHaveLength(1);
		expect(ledger.problems[0]?.attempts).toHaveLength(2);
		expect(resolveProblemId(ledger, "P6")).toBe("P5");
		expect(validateSimLedger(ledger).ok).toBe(true);

		// Appending via retired alias P6 routes transparently to canonical P5.
		const appended = appendSimAttempt(ledger, {
			problemId: "P6",
			accepted: true,
			what: "Third attempt via retired alias",
			files: ["c.ts"],
			model: "gemini-3.8-flash",
			domain: "coding",
			predicted: ["t2"],
			fixed: ["t2"],
			missed: [],
			passed: 16,
			total: 16,
		});
		expect(appended.problemId).toBe("P5");
		expect(appended.mergedFromAlias).toBe("P6");
		expect(appended.ledger.problems[0]?.attempts).toHaveLength(3);
	});

	it("computes fixed, missed, regressed, and newly_passing replay diffs", () => {
		const diff = evaluateReplayDiff(
			{
				passed_ids: ["c1", "c3"],
				failed_ids: ["c2", "c4"],
				results: [],
			},
			["c1", "c2", "unknown-case"],
			{
				passed_ids: ["c1", "c4"],
				failed_ids: ["c2", "c3"],
			},
		);

		expect(diff.fixed).toEqual(["c1"]);
		expect(diff.missed).toEqual(["c2", "unknown-case"]);
		expect(diff.regressed).toEqual(["c4"]);
		expect(diff.newly_passing).toEqual(["c3"]);
	});
});

describe("SIM local replay harness and CLI", () => {
	it("runs all 16 deterministic replay cases and returns machine-readable results", async () => {
		expect(SIM_REPLAY_CASES.length).toBeGreaterThanOrEqual(10);
		expect(SIM_REPLAY_CASES.length).toBeLessThanOrEqual(20);
		const report = await runSimReplay();
		expect(report.total).toBe(SIM_REPLAY_CASES.length);
		expect(report.passed).toBe(report.total);
		expect(report.failed_ids).toEqual([]);
	});

	it("records verified replay output into a temp ledger and validates via CLI", async () => {
		const dir = makeTempDir();
		const ledgerPath = path.join(dir, "sim.json");
		const replayJsonPath = path.join(dir, "replay.json");

		const replayExit = await runSimCli(["replay", "--json", "--save", replayJsonPath]);
		expect(replayExit).toBe(0);
		expect(fs.existsSync(replayJsonPath)).toBe(true);

		const recordExit = await runSimCli([
			"record",
			"--ledger",
			ledgerPath,
			"--problem",
			"new",
			"--name",
			"cli integration root cause",
			"--what",
			"Verify CLI records observed fixed and missed predictions",
			"--files",
			"packages/ai/src/utils/json-parse.ts",
			"--model",
			"claude-opus-5.5",
			"--domain",
			"parsers",
			"--predicted",
			"parser-json-unescaped-controls,nonexistent-regression-case",
			"--accepted",
			"true",
			"--replay-json",
			replayJsonPath,
		]);
		expect(recordExit).toBe(0);

		const validateExit = await runSimCli(["validate", "--ledger", ledgerPath]);
		expect(validateExit).toBe(0);

		const saved = (await Bun.file(ledgerPath).json()) as SimLedger;
		expect(saved.next_id).toBe(2);
		expect(saved.problems).toHaveLength(1);
		const attempt = saved.problems[0]?.attempts[0];
		expect(attempt?.fixed).toEqual(["parser-json-unescaped-controls"]);
		expect(attempt?.missed).toEqual(["nonexistent-regression-case"]);
		expect(attempt?.passed).toBe(SIM_REPLAY_CASES.length);
		expect(attempt?.total).toBe(SIM_REPLAY_CASES.length);
	});
});
