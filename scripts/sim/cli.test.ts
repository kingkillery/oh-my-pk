import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSimCli } from "./cli.ts";
import { readChangeManifest, type SimChangeManifest } from "./manifest.ts";
import { SIM_REPLAY_CASES } from "./replay.ts";
import {
	type SimLedger,
	type SimRejectedCandidateLogEntry,
	type SimReplayReport,
	validateSimLedger,
} from "./schema.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sim-cli-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

interface CliRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runCliCaptured(argv: string[]): Promise<CliRunResult> {
	const outLines: string[] = [];
	const errLines: string[] = [];
	const origLog = console.log;
	const origError = console.error;
	console.log = (...args: unknown[]) => {
		outLines.push(args.map(a => String(a)).join(" "));
	};
	console.error = (...args: unknown[]) => {
		errLines.push(args.map(a => String(a)).join(" "));
	};
	try {
		const exitCode = await runSimCli(argv);
		return {
			exitCode,
			stdout: outLines.join("\n"),
			stderr: errLines.join("\n"),
		};
	} finally {
		console.log = origLog;
		console.error = origError;
	}
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");
}

function makeReplayReport(params: { passedIds: string[]; failedIds: string[]; model?: string }): SimReplayReport {
	return {
		timestamp: "2026-11-19T00:00:00.000Z",
		passed: params.passedIds.length,
		total: params.passedIds.length + params.failedIds.length,
		passed_ids: params.passedIds,
		failed_ids: params.failedIds,
		...(params.model ? { model: params.model } : {}),
		results: [],
	};
}

const ALL_CASE_IDS = SIM_REPLAY_CASES.map(c => c.id);
const CASE_A = "parser-json-unescaped-controls";
const CASE_B = "parser-json-invalid-escapes";
const CASE_C = "parser-apply-patch-heredoc";
const CASE_D = "parser-hashline-contamination";

describe("SIM CLI workflow (arXiv:2611.18856 Appendix D & OMPK-RSI §24.1)", () => {
	it("1. runs full predict -> replay -> record lifecycle with failing baseline to passing candidate", async () => {
		const dir = makeTempDir();
		const ledgerPath = path.join(dir, "sim.json");
		const manifestPath = path.join(dir, "sim-manifest.json");
		const baselinePath = path.join(dir, "baseline.json");
		const replayJsonPath = path.join(dir, "candidate-replay.json");
		const rejectedLogPath = path.join(dir, "sim-rejected.jsonl");

		const baselinePassed = ALL_CASE_IDS.filter(id => id !== CASE_A);
		writeJson(baselinePath, {
			passed_ids: baselinePassed,
			failed_ids: [CASE_A],
			model: "claude-opus-5.5",
		});

		const predictRes = await runCliCaptured([
			"predict",
			"--manifest",
			manifestPath,
			"--problem",
			"new",
			"--name",
			"unescaped control characters inside JSON tool-call strings",
			"--predicted",
			CASE_A,
			"--baseline",
			baselinePath,
			"--what",
			"Escape raw control characters inside JSON string literals before parsing",
			"--files",
			"packages/ai/src/utils/json-parse.ts",
			"--model",
			"claude-opus-5.5",
			"--domain",
			"parsers",
			"--benchmark",
			"json-parse-repair",
			"--json",
		]);
		expect(predictRes.exitCode).toBe(0);
		const predictPayload: SimChangeManifest & { manifest_path: string } = JSON.parse(predictRes.stdout);
		expect(predictPayload.status).toBe("pending");
		expect(predictPayload.problem).toBe("new");
		expect(predictPayload.predicted).toEqual([CASE_A]);
		expect(predictPayload.baseline_failed_ids).toEqual([CASE_A]);
		expect(predictPayload.prediction_hash).toMatch(/^[0-9a-f]{64}$/);

		// Pending manifest cannot be silently overwritten without --force.
		const overwriteRefused = await runCliCaptured([
			"predict",
			"--manifest",
			manifestPath,
			"--problem",
			"new",
			"--name",
			"other",
			"--predicted",
			CASE_B,
		]);
		expect(overwriteRefused.exitCode).toBe(1);
		expect(overwriteRefused.stderr).toContain("Pending manifest already exists");

		// Live replay with --model saves model into JSON report for RSI-21 checks.
		const replayRes = await runCliCaptured([
			"replay",
			"--json",
			"--model",
			"claude-opus-5.5",
			"--save",
			replayJsonPath,
			"--baseline",
			baselinePath,
		]);
		expect(replayRes.exitCode).toBe(0);
		const savedReplay: SimReplayReport = JSON.parse(fs.readFileSync(replayJsonPath, "utf-8"));
		expect(savedReplay.model).toBe("claude-opus-5.5");
		expect(savedReplay.passed).toBe(SIM_REPLAY_CASES.length);
		expect(savedReplay.total).toBe(SIM_REPLAY_CASES.length);

		// Record pulls defaults from manifest and marks manifest consumed.
		const recordRes = await runCliCaptured([
			"record",
			"--ledger",
			ledgerPath,
			"--manifest",
			manifestPath,
			"--rejected-log",
			rejectedLogPath,
			"--replay-json",
			replayJsonPath,
			"--accepted",
			"true",
		]);
		expect(recordRes.exitCode).toBe(0);
		expect(recordRes.stdout).toContain("Opened P1 round 1");

		const consumedManifest = await readChangeManifest(manifestPath);
		expect(consumedManifest.status).toBe("consumed");
		expect(consumedManifest.consumed_at).toBeTruthy();

		const validateRes = await runCliCaptured(["validate", "--ledger", ledgerPath]);
		expect(validateRes.exitCode).toBe(0);

		const savedLedger: SimLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
		expect(validateSimLedger(savedLedger).ok).toBe(true);
		expect(savedLedger.schema_version).toBe(2);
		expect(savedLedger.problems).toHaveLength(1);
		const attempt = savedLedger.problems[0]?.attempts[0];
		expect(attempt?.fixed).toEqual([CASE_A]);
		expect(attempt?.missed).toEqual([]);
		expect(attempt?.regressed).toEqual([]);
		expect(attempt?.sample).toBe("s1");
		expect(attempt?.passed).toBe(SIM_REPLAY_CASES.length);
		expect(attempt?.total).toBe(SIM_REPLAY_CASES.length);
		expect(fs.existsSync(rejectedLogPath)).toBe(false);
	});

	it("1b. evaluates baseline-aware 8-state diff during live replay (no --replay-json)", async () => {
		const dir = makeTempDir();
		const ledgerPath = path.join(dir, "sim.json");
		const manifestPath = path.join(dir, "sim-manifest.json");
		const baselinePath = path.join(dir, "baseline.json");
		const rejectedLogPath = path.join(dir, "sim-rejected.jsonl");

		writeJson(baselinePath, {
			passed_ids: ALL_CASE_IDS.filter(id => id !== CASE_B),
			failed_ids: [CASE_B],
			model: "claude-opus-5.5",
		});

		const predictRes = await runCliCaptured([
			"predict",
			"--manifest",
			manifestPath,
			"--problem",
			"new",
			"--name",
			"invalid JSON backslash escapes on Windows paths",
			"--predicted",
			CASE_B,
			"--baseline",
			baselinePath,
		]);
		expect(predictRes.exitCode).toBe(0);

		const recordRes = await runCliCaptured([
			"record",
			"--ledger",
			ledgerPath,
			"--manifest",
			manifestPath,
			"--rejected-log",
			rejectedLogPath,
			"--what",
			"Repair invalid backslash escapes inside JSON strings",
			"--files",
			"packages/ai/src/utils/json-parse.ts",
			"--model",
			"claude-opus-5.5",
			"--domain",
			"parsers",
			"--benchmark",
			"json-parse-repair",
			"--accepted",
			"true",
		]);
		expect(recordRes.exitCode).toBe(0);

		const ledger: SimLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
		expect(validateSimLedger(ledger).ok).toBe(true);
		expect(ledger.problems[0]?.attempts[0]?.fixed).toEqual([CASE_B]);
		expect(ledger.problems[0]?.attempts[0]?.passed).toBe(SIM_REPLAY_CASES.length);
	});

	it("2. enforces pre-eval manifest (missing, consumed, tampered, mismatched) and permits explicit backfill bypass", async () => {
		const dir = makeTempDir();
		const ledgerPath = path.join(dir, "sim.json");
		const manifestPath = path.join(dir, "sim-manifest.json");
		const baselinePath = path.join(dir, "baseline.json");
		const replayJsonPath = path.join(dir, "replay.json");
		const rejectedLogPath = path.join(dir, "sim-rejected.jsonl");

		writeJson(baselinePath, {
			passed_ids: [CASE_B],
			failed_ids: [CASE_A],
			model: "claude-opus-5.5",
		});
		writeJson(
			replayJsonPath,
			makeReplayReport({ passedIds: [CASE_A, CASE_B], failedIds: [], model: "claude-opus-5.5" }),
		);

		const baseRecordArgs = [
			"record",
			"--ledger",
			ledgerPath,
			"--manifest",
			manifestPath,
			"--rejected-log",
			rejectedLogPath,
			"--baseline",
			baselinePath,
			"--replay-json",
			replayJsonPath,
			"--what",
			"Fix unescaped control chars",
			"--files",
			"packages/ai/src/utils/json-parse.ts",
			"--model",
			"claude-opus-5.5",
			"--domain",
			"parsers",
			"--benchmark",
			"json-parse-repair",
		];

		// Missing manifest -> non-zero exit.
		const missingRes = await runCliCaptured([
			...baseRecordArgs,
			"--problem",
			"new",
			"--name",
			"missing manifest test",
			"--predicted",
			CASE_A,
		]);
		expect(missingRes.exitCode).toBe(1);
		expect(missingRes.stderr).toContain("Missing pre-eval SIM manifest");

		// Create valid pending manifest.
		const predictRes = await runCliCaptured([
			"predict",
			"--manifest",
			manifestPath,
			"--problem",
			"new",
			"--name",
			"manifest enforcement root cause",
			"--predicted",
			CASE_A,
			"--baseline",
			baselinePath,
		]);
		expect(predictRes.exitCode).toBe(0);

		// Mismatched --predicted -> non-zero exit.
		const mismatchPredicted = await runCliCaptured([...baseRecordArgs, "--predicted", CASE_B]);
		expect(mismatchPredicted.exitCode).toBe(1);
		expect(mismatchPredicted.stderr).toContain("contradicts pre-eval manifest");

		// Mismatched --problem -> non-zero exit.
		const mismatchProblem = await runCliCaptured([...baseRecordArgs, "--problem", "P99"]);
		expect(mismatchProblem.exitCode).toBe(1);
		expect(mismatchProblem.stderr).toContain("contradicts pre-eval manifest problem");

		// Tampered prediction_hash (modify predicted on disk without recomputing hash) -> non-zero exit.
		const tamperedRaw: SimChangeManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		const tamperedPath = path.join(dir, "sim-manifest-tampered.json");
		writeJson(tamperedPath, { ...tamperedRaw, predicted: [CASE_A, CASE_B] });
		const tamperedRes = await runCliCaptured([
			"record",
			"--ledger",
			ledgerPath,
			"--manifest",
			tamperedPath,
			"--rejected-log",
			rejectedLogPath,
			"--baseline",
			baselinePath,
			"--replay-json",
			replayJsonPath,
			"--what",
			"Fix unescaped control chars",
			"--files",
			"packages/ai/src/utils/json-parse.ts",
			"--model",
			"claude-opus-5.5",
			"--domain",
			"parsers",
			"--benchmark",
			"json-parse-repair",
		]);
		expect(tamperedRes.exitCode).toBe(1);
		expect(tamperedRes.stderr).toContain("prediction_hash mismatch");

		// Valid record consumes the manifest.
		const okRes = await runCliCaptured(baseRecordArgs);
		expect(okRes.exitCode).toBe(0);

		// Reusing the already-consumed manifest -> non-zero exit.
		const consumedRes = await runCliCaptured(baseRecordArgs);
		expect(consumedRes.exitCode).toBe(1);
		expect(consumedRes.stderr).toContain('already "consumed"');

		// --backfilled true alone (without --allow-ad-hoc) still requires pending manifest.
		const missingAdHocFlag = await runCliCaptured([
			...baseRecordArgs,
			"--problem",
			"P1",
			"--predicted",
			CASE_A,
			"--backfilled",
			"true",
		]);
		expect(missingAdHocFlag.exitCode).toBe(1);

		// Explicit --backfilled true --allow-ad-hoc bypasses manifest and succeeds.
		const backfillRes = await runCliCaptured([
			"record",
			"--ledger",
			ledgerPath,
			"--manifest",
			path.join(dir, "nonexistent-manifest.json"),
			"--rejected-log",
			rejectedLogPath,
			"--problem",
			"P1",
			"--predicted",
			CASE_A,
			"--baseline",
			baselinePath,
			"--replay-json",
			replayJsonPath,
			"--what",
			"Historical backfill record",
			"--files",
			"packages/ai/src/utils/json-parse.ts",
			"--model",
			"claude-opus-5.5",
			"--domain",
			"parsers",
			"--benchmark",
			"json-parse-repair",
			"--backfilled",
			"true",
			"--allow-ad-hoc",
		]);
		expect(backfillRes.exitCode).toBe(0);

		const ledger: SimLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
		expect(validateSimLedger(ledger).ok).toBe(true);
		expect(ledger.problems[0]?.attempts).toHaveLength(2);
		expect(ledger.problems[0]?.attempts[1]?.backfilled).toBe(true);
	});

	it("3. enforces RSI-02 (PASS -> PASS): predict rejects unless --allow-preserved, record puts in preserved (never fixed)", async () => {
		const dir = makeTempDir();
		const ledgerPath = path.join(dir, "sim.json");
		const manifestPath = path.join(dir, "sim-manifest.json");
		const baselinePath = path.join(dir, "baseline.json");
		const replayJsonPath = path.join(dir, "replay.json");
		const rejectedLogPath = path.join(dir, "sim-rejected.jsonl");

		writeJson(baselinePath, {
			passed_ids: [CASE_A, CASE_B],
			failed_ids: [CASE_C],
			model: "claude-opus-5.5",
		});
		writeJson(
			replayJsonPath,
			makeReplayReport({ passedIds: [CASE_A, CASE_B, CASE_C], failedIds: [], model: "claude-opus-5.5" }),
		);

		// predict --baseline rejects already-passing case CASE_A without --allow-preserved.
		const rejectedPredict = await runCliCaptured([
			"predict",
			"--manifest",
			manifestPath,
			"--problem",
			"new",
			"--name",
			"already passing case check",
			"--predicted",
			`${CASE_A},${CASE_C}`,
			"--baseline",
			baselinePath,
		]);
		expect(rejectedPredict.exitCode).toBe(1);
		expect(rejectedPredict.stderr).toContain("already pass in baseline");
		expect(rejectedPredict.stderr).toContain(CASE_A);

		// With --allow-preserved, predict succeeds.
		const allowedPredict = await runCliCaptured([
			"predict",
			"--manifest",
			manifestPath,
			"--problem",
			"new",
			"--name",
			"already passing case check",
			"--predicted",
			`${CASE_A},${CASE_C}`,
			"--baseline",
			baselinePath,
			"--allow-preserved",
		]);
		expect(allowedPredict.exitCode).toBe(0);

		// Record classifies CASE_A as preserved (NEVER fixed) and CASE_C as fixed.
		const recordRes = await runCliCaptured([
			"record",
			"--ledger",
			ledgerPath,
			"--manifest",
			manifestPath,
			"--rejected-log",
			rejectedLogPath,
			"--baseline",
			baselinePath,
			"--replay-json",
			replayJsonPath,
			"--what",
			"Fix heredoc parsing while keeping JSON repair intact",
			"--files",
			"packages/coding-agent/src/edit/apply-patch/parser.ts",
			"--model",
			"claude-opus-5.5",
			"--domain",
			"parsers",
			"--benchmark",
			"patch-dialect-isolation",
		]);
		expect(recordRes.exitCode).toBe(0);

		const ledger: SimLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
		expect(validateSimLedger(ledger).ok).toBe(true);
		const attempt = ledger.problems[0]?.attempts[0];
		expect(attempt?.fixed).toEqual([CASE_C]);
		expect(attempt?.preserved).toEqual([CASE_A]);
		expect(attempt?.fixed).not.toContain(CASE_A);
		expect(attempt?.missed).toEqual([]);
	});

	it("4. enforces RSI-03 (missing baseline): record without baseline classifies predicted cases as unproven (0 fixed)", async () => {
		const dir = makeTempDir();
		const ledgerPath = path.join(dir, "sim.json");
		const manifestPath = path.join(dir, "sim-manifest.json");
		const replayJsonPath = path.join(dir, "replay.json");
		const rejectedLogPath = path.join(dir, "sim-rejected.jsonl");

		writeJson(
			replayJsonPath,
			makeReplayReport({ passedIds: [CASE_A, CASE_B], failedIds: [], model: "claude-opus-5.5" }),
		);

		const predictRes = await runCliCaptured([
			"predict",
			"--manifest",
			manifestPath,
			"--problem",
			"new",
			"--name",
			"no baseline provenance test",
			"--predicted",
			`${CASE_A},${CASE_B}`,
		]);
		expect(predictRes.exitCode).toBe(0);

		const recordRes = await runCliCaptured([
			"record",
			"--ledger",
			ledgerPath,
			"--manifest",
			manifestPath,
			"--rejected-log",
			rejectedLogPath,
			"--replay-json",
			replayJsonPath,
			"--what",
			"Run candidate without baseline file",
			"--files",
			"packages/ai/src/utils/json-parse.ts",
			"--model",
			"claude-opus-5.5",
			"--domain",
			"parsers",
			"--benchmark",
			"json-parse-repair",
		]);
		expect(recordRes.exitCode).toBe(0);

		const ledger: SimLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
		expect(validateSimLedger(ledger).ok).toBe(true);
		const attempt = ledger.problems[0]?.attempts[0];
		expect(attempt?.fixed).toEqual([]);
		expect(attempt?.missed).toEqual([]);
		expect(attempt?.preserved).toBeUndefined();
		expect(attempt?.unproven).toEqual([CASE_A, CASE_B]);
	});

	it("5. enforces RSI-21 (model mismatch): record rejects when baseline model differs from candidate model", async () => {
		const dir = makeTempDir();
		const ledgerPath = path.join(dir, "sim.json");
		const manifestPath = path.join(dir, "sim-manifest.json");
		const baselinePath = path.join(dir, "baseline.json");
		const replayJsonPath = path.join(dir, "replay.json");
		const rejectedLogPath = path.join(dir, "sim-rejected.jsonl");

		writeJson(baselinePath, {
			passed_ids: [CASE_B],
			failed_ids: [CASE_A],
			model: "claude-opus-5.5",
		});
		writeJson(replayJsonPath, makeReplayReport({ passedIds: [CASE_A, CASE_B], failedIds: [], model: "gpt-5.4" }));

		const predictRes = await runCliCaptured([
			"predict",
			"--manifest",
			manifestPath,
			"--problem",
			"new",
			"--name",
			"cross-model baseline comparison guard",
			"--predicted",
			CASE_A,
			"--baseline",
			baselinePath,
		]);
		expect(predictRes.exitCode).toBe(0);

		const recordRes = await runCliCaptured([
			"record",
			"--ledger",
			ledgerPath,
			"--manifest",
			manifestPath,
			"--rejected-log",
			rejectedLogPath,
			"--baseline",
			baselinePath,
			"--replay-json",
			replayJsonPath,
			"--what",
			"Attempt cross-model diff",
			"--files",
			"packages/ai/src/utils/json-parse.ts",
			"--model",
			"gpt-5.4",
			"--domain",
			"parsers",
			"--benchmark",
			"json-parse-repair",
		]);
		expect(recordRes.exitCode).toBe(1);
		expect(recordRes.stderr).toContain("RSI-21");
		expect(recordRes.stderr).toContain("claude-opus-5.5");
		expect(recordRes.stderr).toContain("gpt-5.4");
		expect(fs.existsSync(ledgerPath)).toBe(false);

		// Manifest remains pending on failed record.
		const stillPending = await readChangeManifest(manifestPath);
		expect(stillPending.status).toBe("pending");
	});

	it("6. tracks regressions, unresolved, and incomplete outcomes with --replay-json + --baseline", async () => {
		const dir = makeTempDir();
		const ledgerPath = path.join(dir, "sim.json");
		const manifestPath = path.join(dir, "sim-manifest.json");
		const baselinePath = path.join(dir, "baseline.json");
		const replayJsonPath = path.join(dir, "replay.json");
		const rejectedLogPath = path.join(dir, "sim-rejected.jsonl");

		// CASE_A: FAIL -> PASS (fixed)
		// CASE_B: PASS -> FAIL (regressed, and missed because predicted)
		// CASE_C: FAIL -> FAIL (unresolved, and missed because predicted)
		// CASE_D: PASS -> FAIL (regressed, not predicted)
		// retry-empty-completion-recovers: FAIL -> missing in candidate (incomplete)
		const CASE_INCOMPLETE = "retry-empty-completion-recovers";
		writeJson(baselinePath, {
			passed_ids: [CASE_B, CASE_D],
			failed_ids: [CASE_A, CASE_C, CASE_INCOMPLETE],
			model: "claude-opus-5.5",
		});
		writeJson(
			replayJsonPath,
			makeReplayReport({
				passedIds: [CASE_A],
				failedIds: [CASE_B, CASE_C, CASE_D],
				model: "claude-opus-5.5",
			}),
		);

		const predictRes = await runCliCaptured([
			"predict",
			"--manifest",
			manifestPath,
			"--problem",
			"new",
			"--name",
			"regression and incomplete attribution",
			"--predicted",
			`${CASE_A},${CASE_B},${CASE_C},${CASE_INCOMPLETE}`,
			"--baseline",
			baselinePath,
			"--allow-preserved",
		]);
		expect(predictRes.exitCode).toBe(0);

		const recordRes = await runCliCaptured([
			"record",
			"--ledger",
			ledgerPath,
			"--manifest",
			manifestPath,
			"--rejected-log",
			rejectedLogPath,
			"--baseline",
			baselinePath,
			"--replay-json",
			replayJsonPath,
			"--what",
			"Partial fix causing parser regressions",
			"--files",
			"packages/ai/src/utils/json-parse.ts",
			"--model",
			"claude-opus-5.5",
			"--domain",
			"parsers",
			"--benchmark",
			"json-parse-repair",
		]);
		expect(recordRes.exitCode).toBe(0);

		const ledger: SimLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
		expect(validateSimLedger(ledger).ok).toBe(true);
		const attempt = ledger.problems[0]?.attempts[0];
		expect(attempt?.fixed).toEqual([CASE_A]);
		expect(attempt?.missed).toEqual([CASE_B, CASE_C]);
		expect(attempt?.regressed).toEqual([CASE_B, CASE_D]);
		expect(attempt?.unresolved).toEqual([CASE_C]);
		expect(attempt?.incomplete).toEqual([CASE_INCOMPLETE]);
	});

	it("7. enforces §3.2 no-op on --accepted false: ledger byte-identical, manifest consumed, rejected JSONL appended", async () => {
		const dir = makeTempDir();
		const ledgerPath = path.join(dir, "sim.json");
		const manifestPath = path.join(dir, "sim-manifest.json");
		const baselinePath = path.join(dir, "baseline.json");
		const replayJsonPath = path.join(dir, "replay.json");
		const rejectedLogPath = path.join(dir, "sim-rejected.jsonl");

		const initialLedger: SimLedger = {
			$schema: "./sim.schema.json",
			schema_version: 2,
			next_id: 2,
			aliases: {},
			problems: [
				{
					id: "P1",
					name: "seeded existing problem",
					opened_round: 1,
					attempts: [
						{
							round: 1,
							accepted: true,
							what: "Initial accepted fix",
							files: ["packages/ai/src/utils/json-parse.ts"],
							model: "claude-opus-5.5",
							domain: "parsers",
							benchmark: "json-parse-repair",
							predicted: [CASE_A],
							fixed: [CASE_A],
							missed: [],
							regressed: [],
							passed: 2,
							total: 2,
							sample: "s1",
						},
					],
				},
			],
		};
		writeJson(ledgerPath, initialLedger);
		const bytesBefore = Array.from(new Uint8Array(fs.readFileSync(ledgerPath)));

		writeJson(baselinePath, {
			passed_ids: [CASE_A],
			failed_ids: [CASE_B],
			model: "claude-opus-5.5",
		});
		writeJson(
			replayJsonPath,
			makeReplayReport({ passedIds: [], failedIds: [CASE_A, CASE_B], model: "claude-opus-5.5" }),
		);

		const predictRes = await runCliCaptured([
			"predict",
			"--manifest",
			manifestPath,
			"--problem",
			"P1",
			"--predicted",
			CASE_B,
			"--baseline",
			baselinePath,
		]);
		expect(predictRes.exitCode).toBe(0);

		const recordRes = await runCliCaptured([
			"record",
			"--ledger",
			ledgerPath,
			"--manifest",
			manifestPath,
			"--rejected-log",
			rejectedLogPath,
			"--baseline",
			baselinePath,
			"--replay-json",
			replayJsonPath,
			"--accepted",
			"false",
			"--what",
			"Over-aggressive escape stripping regressed CASE_A",
			"--files",
			"packages/ai/src/utils/json-parse.ts",
			"--model",
			"claude-opus-5.5",
			"--domain",
			"parsers",
			"--benchmark",
			"json-parse-repair",
		]);
		expect(recordRes.exitCode).toBe(0);
		expect(recordRes.stdout).toContain("[NO-OP §3.2]");

		// Ledger must remain byte-identical.
		const bytesAfter = Array.from(new Uint8Array(fs.readFileSync(ledgerPath)));
		expect(bytesAfter).toEqual(bytesBefore);

		// Pending manifest must be marked consumed.
		const consumedManifest = await readChangeManifest(manifestPath);
		expect(consumedManifest.status).toBe("consumed");

		// Rejected log contains exactly one valid SimRejectedCandidateLogEntry JSONL line.
		const logLines = fs.readFileSync(rejectedLogPath, "utf-8").trim().split("\n");
		expect(logLines).toHaveLength(1);
		const entry: SimRejectedCandidateLogEntry = JSON.parse(logLines[0] ?? "{}");
		expect(entry.accepted).toBe(false);
		expect(entry.problem_id).toBe("P1");
		expect(entry.round).toBe(2);
		expect(entry.predicted).toEqual([CASE_B]);
		expect(entry.fixed).toEqual([]);
		expect(entry.missed).toEqual([CASE_B]);
		expect(entry.regressed).toEqual([CASE_A]);
		expect(entry.unresolved).toEqual([CASE_B]);
		expect(entry.manifest_id).toBe(consumedManifest.manifest_id);
		expect(entry.reason).toContain("§3.2");

		// --no-rejected-log skips appending to rejected log.
		const predict2 = await runCliCaptured([
			"predict",
			"--manifest",
			manifestPath,
			"--problem",
			"P1",
			"--predicted",
			CASE_B,
			"--baseline",
			baselinePath,
		]);
		expect(predict2.exitCode).toBe(0);
		const noLogRes = await runCliCaptured([
			"record",
			"--ledger",
			ledgerPath,
			"--manifest",
			manifestPath,
			"--rejected-log",
			rejectedLogPath,
			"--no-rejected-log",
			"--baseline",
			baselinePath,
			"--replay-json",
			replayJsonPath,
			"--accepted",
			"false",
			"--what",
			"Discarded experiment without log",
			"--files",
			"packages/ai/src/utils/json-parse.ts",
			"--model",
			"claude-opus-5.5",
			"--domain",
			"parsers",
			"--benchmark",
			"json-parse-repair",
		]);
		expect(noLogRes.exitCode).toBe(0);
		expect(fs.readFileSync(rejectedLogPath, "utf-8").trim().split("\n")).toHaveLength(1);
	});

	it("8. runs carry -> status -> predict -> record: sets carried_from, reports it, restarts round at 1 on same domain", async () => {
		const dir = makeTempDir();
		const ledgerPath = path.join(dir, "sim.json");
		const manifestPath = path.join(dir, "sim-manifest.json");
		const baselinePath = path.join(dir, "baseline.json");
		const replayJsonPath = path.join(dir, "replay.json");
		const rejectedLogPath = path.join(dir, "sim-rejected.jsonl");

		const initialLedger: SimLedger = {
			$schema: "./sim.schema.json",
			schema_version: 2,
			next_id: 2,
			aliases: {},
			problems: [
				{
					id: "P1",
					name: "JSON parser control chars",
					opened_round: 1,
					attempts: [
						{
							round: 4,
							accepted: true,
							what: "Prior model fix at round 4",
							files: ["packages/ai/src/utils/json-parse.ts"],
							model: "claude-opus-5.5",
							domain: "parsers",
							benchmark: "json-parse-repair",
							predicted: [CASE_A],
							fixed: [CASE_A],
							missed: [],
							regressed: [],
							passed: 2,
							total: 2,
							run: "claude-parsers-r1",
							sample: "s4",
						},
					],
				},
			],
		};
		writeJson(ledgerPath, initialLedger);

		const carryRes = await runCliCaptured([
			"carry",
			"--ledger",
			ledgerPath,
			"--arm",
			"claude-parsers-r1",
			"--domain",
			"parsers",
			"--into",
			"gpt54-parsers-r1",
			"--benchmark",
			"json-parse-repair",
			"--model",
			"claude-opus-5.5",
			"--json",
		]);
		expect(carryRes.exitCode).toBe(0);
		const carryPayload: {
			carried_from: {
				arm: string;
				domain: string;
				into: string;
				benchmark?: string;
				model?: string;
				carried_at?: string;
			};
			next_round: number;
		} = JSON.parse(carryRes.stdout);
		expect(carryPayload.carried_from.arm).toBe("claude-parsers-r1");
		expect(carryPayload.carried_from.domain).toBe("parsers");
		expect(carryPayload.carried_from.into).toBe("gpt54-parsers-r1");
		expect(carryPayload.carried_from.benchmark).toBe("json-parse-repair");
		expect(carryPayload.carried_from.model).toBe("claude-opus-5.5");
		expect(carryPayload.carried_from.carried_at).toBeTruthy();
		expect(carryPayload.next_round).toBe(1);

		// status --json reports schema_version, carried_from, and per-problem benchmarks.
		const statusJsonRes = await runCliCaptured(["status", "--ledger", ledgerPath, "--json"]);
		expect(statusJsonRes.exitCode).toBe(0);
		const statusPayload: {
			schema_version: number;
			carried_from: {
				arm: string;
				domain: string;
				into: string;
				benchmark?: string;
				model?: string;
				carried_at?: string;
			} | null;
			problems: Array<{ id: string; domains: string[]; benchmarks: string[]; models: string[] }>;
		} = JSON.parse(statusJsonRes.stdout);
		expect(statusPayload.schema_version).toBe(2);
		expect(statusPayload.carried_from?.into).toBe("gpt54-parsers-r1");
		expect(statusPayload.problems[0]?.benchmarks).toEqual(["json-parse-repair"]);

		// Human-readable status also displays carried_from (including carried_at) and benchmarks.
		const statusTextRes = await runCliCaptured(["status", "--ledger", ledgerPath]);
		expect(statusTextRes.exitCode).toBe(0);
		expect(statusTextRes.stdout).toContain("v2");
		expect(statusTextRes.stdout).toContain(
			"Carried from: arm=claude-parsers-r1, domain=parsers, into=gpt54-parsers-r1",
		);
		expect(statusTextRes.stdout).toContain("carried_at=");
		expect(statusTextRes.stdout).toContain("benchmarks=[json-parse-repair]");

		// Next recorded attempt on the SAME domain ("parsers") restarts at round 1 with run === carried_from.into.
		writeJson(baselinePath, {
			passed_ids: [CASE_A],
			failed_ids: [CASE_B],
			model: "gpt-5.4",
		});
		writeJson(replayJsonPath, makeReplayReport({ passedIds: [CASE_A, CASE_B], failedIds: [], model: "gpt-5.4" }));

		const predictRes = await runCliCaptured([
			"predict",
			"--manifest",
			manifestPath,
			"--problem",
			"P1",
			"--predicted",
			CASE_B,
			"--baseline",
			baselinePath,
		]);
		expect(predictRes.exitCode).toBe(0);

		const recordRes = await runCliCaptured([
			"record",
			"--ledger",
			ledgerPath,
			"--manifest",
			manifestPath,
			"--rejected-log",
			rejectedLogPath,
			"--baseline",
			baselinePath,
			"--replay-json",
			replayJsonPath,
			"--what",
			"Transfer-round fix for GPT-5.4 on same parsers domain",
			"--files",
			"packages/ai/src/utils/json-parse.ts",
			"--model",
			"gpt-5.4",
			"--domain",
			"parsers",
			"--benchmark",
			"json-parse-repair",
		]);
		expect(recordRes.exitCode).toBe(0);

		const updated: SimLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
		expect(validateSimLedger(updated).ok).toBe(true);
		const newAttempt = updated.problems[0]?.attempts[1];
		expect(newAttempt?.round).toBe(1);
		expect(newAttempt?.run).toBe("gpt54-parsers-r1");
		expect(newAttempt?.sample).toBe("s1");
		expect(newAttempt?.fixed).toEqual([CASE_B]);
	});

	it("9. persists --sample, --backfilled, --benchmark, --run, --baseline-ref, and --candidate-ref accurately", async () => {
		const dir = makeTempDir();
		const ledgerPath = path.join(dir, "sim.json");
		const manifestPath = path.join(dir, "sim-manifest.json");
		const baselinePath = path.join(dir, "baseline.json");
		const replayJsonPath = path.join(dir, "replay.json");
		const rejectedLogPath = path.join(dir, "sim-rejected.jsonl");

		writeJson(baselinePath, {
			passed_ids: [CASE_B],
			failed_ids: [CASE_A],
			model: "claude-opus-5.5",
		});
		writeJson(
			replayJsonPath,
			makeReplayReport({ passedIds: [CASE_A, CASE_B], failedIds: [], model: "claude-opus-5.5" }),
		);

		const predictRes = await runCliCaptured([
			"predict",
			"--manifest",
			manifestPath,
			"--problem",
			"new",
			"--name",
			"provenance metadata persistence",
			"--predicted",
			CASE_A,
			"--baseline",
			baselinePath,
		]);
		expect(predictRes.exitCode).toBe(0);

		const recordRes = await runCliCaptured([
			"record",
			"--ledger",
			ledgerPath,
			"--manifest",
			manifestPath,
			"--rejected-log",
			rejectedLogPath,
			"--baseline",
			baselinePath,
			"--replay-json",
			replayJsonPath,
			"--what",
			"Verify full provenance flags persist cleanly",
			"--files",
			"packages/ai/src/utils/json-parse.ts,scripts/sim/cli.ts",
			"--model",
			"claude-opus-5.5",
			"--domain",
			"parsers",
			"--benchmark",
			"json-parse-repair-v2",
			"--sample",
			"batch-42",
			"--backfilled",
			"false",
			"--run",
			"run-2026-11-19",
			"--baseline-ref",
			"git:base-abc123",
			"--candidate-ref",
			"git:cand-def456",
			"--commit",
			"def456",
		]);
		expect(recordRes.exitCode).toBe(0);

		const ledger: SimLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
		const validation = validateSimLedger(ledger);
		expect(validation.errors).toEqual([]);
		expect(validation.ok).toBe(true);

		const attempt = ledger.problems[0]?.attempts[0];
		expect(attempt?.sample).toBe("batch-42");
		expect(attempt?.backfilled).toBe(false);
		expect(attempt?.benchmark).toBe("json-parse-repair-v2");
		expect(attempt?.run).toBe("run-2026-11-19");
		expect(attempt?.baseline_ref).toBe("git:base-abc123");
		expect(attempt?.candidate_ref).toBe("git:cand-def456");
		expect(attempt?.commit).toBe("def456");
		expect(attempt?.files).toEqual(["packages/ai/src/utils/json-parse.ts", "scripts/sim/cli.ts"]);
	});

	it("10. sim:status surfaces missed, regressed, unresolved, unproven, incomplete, and preserved v2 buckets", async () => {
		const dir = makeTempDir();
		const ledgerPath = path.join(dir, "sim.json");

		const ledger: SimLedger = {
			$schema: "./sim.schema.json",
			schema_version: 2,
			next_id: 2,
			aliases: {},
			problems: [
				{
					id: "P1",
					name: "mixed 8-state attribution visibility",
					opened_round: 1,
					attempts: [
						{
							round: 1,
							accepted: true,
							what: "Partial fix with regression and unproven/incomplete cases",
							files: ["packages/ai/src/utils/json-parse.ts"],
							model: "claude-opus-5.5",
							domain: "parsers",
							benchmark: "json-parse-repair",
							predicted: [CASE_A, CASE_B, CASE_C, CASE_D, "case-preserved"],
							fixed: [CASE_A],
							missed: [CASE_B],
							regressed: ["case-regressed"],
							preserved: ["case-preserved"],
							unresolved: [CASE_B],
							unproven: [CASE_C],
							incomplete: [CASE_D],
							passed: 2,
							total: 5,
							sample: "s1",
						},
					],
				},
			],
		};
		writeJson(ledgerPath, ledger);

		const jsonRes = await runCliCaptured(["status", "--ledger", ledgerPath, "--json"]);
		expect(jsonRes.exitCode).toBe(0);
		const payload: {
			problems: Array<{
				id: string;
				unresolved_predictions: string[];
				missed: string[];
				regressed: string[];
				unresolved: string[];
				unproven: string[];
				incomplete: string[];
				preserved: string[];
			}>;
		} = JSON.parse(jsonRes.stdout);
		const p1 = payload.problems[0];
		expect(p1?.unresolved_predictions).toEqual([CASE_B]);
		expect(p1?.missed).toEqual([CASE_B]);
		expect(p1?.regressed).toEqual(["case-regressed"]);
		expect(p1?.unresolved).toEqual([CASE_B]);
		expect(p1?.unproven).toEqual([CASE_C]);
		expect(p1?.incomplete).toEqual([CASE_D]);
		expect(p1?.preserved).toEqual(["case-preserved"]);

		const textRes = await runCliCaptured(["status", "--ledger", ledgerPath]);
		expect(textRes.exitCode).toBe(0);
		expect(textRes.stdout).toContain(`missed=[${CASE_B}]`);
		expect(textRes.stdout).toContain("regressed=[case-regressed]");
		expect(textRes.stdout).toContain(`unresolved=[${CASE_B}]`);
		expect(textRes.stdout).toContain(`unproven=[${CASE_C}]`);
		expect(textRes.stdout).toContain(`incomplete=[${CASE_D}]`);
	});
});
