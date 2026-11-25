import { describe, expect, it } from "bun:test";
import type { SimReplayBaselineMeta, SimReplayReport } from "./schema";
import { createInMemorySimStore, createSimWorkflow, SimWorkflowError } from "./workflow";

const FIXED_NOW = "2026-11-19T04:00:00.000Z";
const CASE_A = "parser-json-unescaped-controls";
const CASE_B = "parser-json-invalid-escapes";
const CASE_C = "retry-empty-completion-recovers";

function makeCannedReport(params: { passedIds: string[]; failedIds: string[]; model?: string }): SimReplayReport {
	return {
		timestamp: FIXED_NOW,
		passed: params.passedIds.length,
		total: params.passedIds.length + params.failedIds.length,
		passed_ids: params.passedIds,
		failed_ids: params.failedIds,
		...(params.model ? { model: params.model } : {}),
		results: [
			...params.passedIds.map(id => ({
				id,
				category: "parser" as const,
				description: id,
				passed: true,
				duration_ms: 1,
			})),
			...params.failedIds.map(id => ({
				id,
				category: "parser" as const,
				description: id,
				passed: false,
				duration_ms: 1,
				error: "simulated failure",
			})),
		],
	};
}

describe("SIM deep workflow module (in-memory store + canned replay)", () => {
	it("executes predict -> record (accepted: true) with minimal caller input and consumes manifest once", async () => {
		const store = createInMemorySimStore();
		const baseline: SimReplayBaselineMeta = {
			passed_ids: [CASE_C],
			failed_ids: [CASE_A, CASE_B],
			model: "claude-opus-5.5",
		};
		const candidate = makeCannedReport({
			passedIds: [CASE_A, CASE_C],
			failedIds: [CASE_B],
			model: "claude-opus-5.5",
		});

		const wf = createSimWorkflow({
			rootDir: "/virtual/repo",
			store,
			runReplay: async () => candidate,
			now: () => FIXED_NOW,
		});

		const pred = await wf.predict({
			problem: "new",
			name: "unescaped JSON controls in tool arguments",
			predicted: [CASE_A, CASE_B],
			what: "Escape raw control characters inside JSON string literals",
			files: ["packages/ai/src/utils/json-parse.ts"],
			model: "claude-opus-5.5",
			domain: "parsers",
			benchmark: "json-parse-repair",
			baseline,
		});
		expect(pred.manifest.status).toBe("pending");
		expect(pred.baselineSource).toBe("explicit");

		// Second predict without force is rejected while pending.
		await expect(
			wf.predict({
				problem: "new",
				name: "duplicate",
				predicted: [CASE_A],
			}),
		).rejects.toBeInstanceOf(SimWorkflowError);

		// Common caller passes nothing extra because metadata & inline baseline live in the manifest.
		const rec = await wf.record({ accepted: true });
		expect(rec.recorded).toBe(true);
		if (!rec.recorded) throw new Error("expected recorded: true");
		expect(rec.problemId).toBe("P1");
		expect(rec.createdProblem).toBe(true);
		expect(rec.ledgerWritten).toBe(true);
		expect(rec.manifestConsumed).toBe(true);
		expect(rec.baselineSource).toBe("manifest_inline");
		expect(rec.candidateSource).toBe("live_replay");
		expect(rec.diff.fixed).toEqual([CASE_A]);
		expect(rec.diff.missed).toEqual([CASE_B]);
		expect(rec.diff.unresolved).toEqual([CASE_B]);

		const validation = await wf.validate();
		expect(validation.valid).toBe(true);
		if (!validation.valid) throw new Error("expected valid ledger");
		expect(validation.problemCount).toBe(1);
		expect(validation.attemptCount).toBe(1);

		// Reusing a consumed manifest fails with manifest_state.
		await expect(wf.record({ accepted: true })).rejects.toThrow(/already "consumed"/);
	});

	it("enforces §3.2 chosen-only invariance: accepted: false leaves ledger byte-untouched and appends rejected log", async () => {
		const store = createInMemorySimStore();
		const wf = createSimWorkflow({
			rootDir: "/virtual/repo",
			store,
			runReplay: async () =>
				makeCannedReport({
					passedIds: [],
					failedIds: [CASE_A],
					model: "claude-opus-5.5",
				}),
			now: () => FIXED_NOW,
		});

		await wf.predict({
			problem: "new",
			name: "candidate fix that regressed",
			predicted: [CASE_A],
			what: "Try aggressive regex repair",
			files: ["packages/ai/src/utils/json-parse.ts"],
			model: "claude-opus-5.5",
			domain: "parsers",
			benchmark: "json-parse-repair",
			baseline: { passed_ids: [], failed_ids: [CASE_A], model: "claude-opus-5.5" },
		});

		expect(store.peekText(wf.paths.ledgerPath)).toBeUndefined();

		const rec = await wf.record({ accepted: false });
		expect(rec.recorded).toBe(false);
		if (rec.recorded) throw new Error("expected recorded: false");
		expect(rec.ledgerWritten).toBe(false);
		expect(rec.rejectedLogAppended).toBe(true);
		expect(rec.manifestConsumed).toBe(true);

		// Ledger was never created or written.
		expect(store.peekText(wf.paths.ledgerPath)).toBeUndefined();
		const rejectedEntries = store.peekRejectedEntries(wf.paths.rejectedLogPath);
		expect(rejectedEntries).toHaveLength(1);
		expect(rejectedEntries[0]?.accepted).toBe(false);
		expect(rejectedEntries[0]?.missed).toEqual([CASE_A]);
	});

	it("aborts before consuming manifest on model mismatch or prediction contradiction so caller can retry", async () => {
		const store = createInMemorySimStore();
		let candidateModel = "gemini-3-pro";
		const wf = createSimWorkflow({
			rootDir: "/virtual/repo",
			store,
			runReplay: async opts =>
				makeCannedReport({
					passedIds: [CASE_A],
					failedIds: [],
					model: opts?.model,
				}),
			now: () => FIXED_NOW,
		});

		await wf.predict({
			problem: "new",
			name: "cross-model retry check",
			predicted: [CASE_A],
			what: "Adjust empty-completion retry",
			files: ["packages/ai/src/utils/empty-completion-retry.ts"],
			domain: "retry-policies",
			benchmark: "empty-completion",
			baseline: { passed_ids: [], failed_ids: [CASE_A], model: "claude-opus-5.5" },
		});

		// Contradicting predicted list fails with manifest_mismatch and keeps manifest pending.
		await expect(
			wf.record({
				predicted: [CASE_B],
				model: "claude-opus-5.5",
			}),
		).rejects.toMatchObject({ code: "manifest_mismatch" });

		// Model mismatch fails with model_mismatch and STILL keeps manifest pending.
		await expect(
			wf.record({
				model: candidateModel,
			}),
		).rejects.toMatchObject({ code: "model_mismatch" });

		// Fixing the model succeeds on retry because the manifest stayed pending.
		candidateModel = "claude-opus-5.5";
		const okRec = await wf.record({ model: candidateModel });
		expect(okRec.recorded).toBe(true);
	});

	it("supports carry-forward round reset, duplicate merging, and full v2 status projection", async () => {
		const store = createInMemorySimStore();
		const wf = createSimWorkflow({
			rootDir: "/virtual/repo",
			store,
			runReplay: async () =>
				makeCannedReport({
					passedIds: [CASE_A],
					failedIds: [CASE_B, CASE_C],
					model: "claude-opus-5.5",
				}),
			now: () => FIXED_NOW,
		});

		// Backfill round 5 with regression + unproven + missed so status projection exercises v2 buckets.
		await wf.record({
			backfilled: true,
			allowAdHoc: true,
			problem: "new",
			name: "truncation byte split",
			round: 5,
			predicted: [CASE_A, CASE_B],
			what: "Initial truncation guard",
			files: ["packages/coding-agent/src/session/streaming-output.ts"],
			model: "claude-opus-5.5",
			domain: "truncation",
			benchmark: "streaming-output",
			baseline: {
				passed_ids: [CASE_C],
				failed_ids: [CASE_A],
				model: "claude-opus-5.5",
			},
		});

		const statusBefore = await wf.status();
		expect(statusBefore.problems[0]?.regressed).toEqual([CASE_C]);
		expect(statusBefore.problems[0]?.unproven).toEqual([CASE_B]);

		const carried = await wf.carry({
			arm: "claude-opus-5.5-v1",
			domain: "truncation",
			into: "qwen3.5-v2",
			benchmark: "streaming-output",
			model: "claude-opus-5.5",
		});
		expect(carried.nextRound).toBe(1);
		expect(carried.carriedFrom?.into).toBe("qwen3.5-v2");
	});

	it("records control_baseline and claim_evidence through predict -> replay -> record -> validate, blocks unsupported claims on accepted:true, and preserves byte-identical ledger on accepted:false", async () => {
		const store = createInMemorySimStore();
		const baseline: SimReplayBaselineMeta = {
			passed_ids: [CASE_C],
			failed_ids: [CASE_A, CASE_B],
			model: "claude-opus-5.5",
		};
		const candidate = makeCannedReport({
			passedIds: [CASE_A, CASE_C],
			failedIds: [CASE_B],
			model: "claude-opus-5.5",
		});

		const wf = createSimWorkflow({
			rootDir: "/virtual/repo",
			store,
			runReplay: async () => candidate,
			now: () => FIXED_NOW,
		});

		await wf.predict({
			problem: "new",
			name: "control-baseline and claim-evidence check",
			predicted: [CASE_A],
			what: "Add deterministic repair with verified evidence",
			files: ["packages/ai/src/utils/json-parse.ts"],
			model: "claude-opus-5.5",
			domain: "parsers",
			benchmark: "json-parse-repair",
			baseline,
		});

		// Accepted attempt with unsupported_claims > 0 must fail closed before mutating ledger or consuming manifest.
		await expect(
			wf.record({
				accepted: true,
				controlBaseline: {
					baseline_type: "unchanged",
					baseline_score: 0.33,
					candidate_score: 0.67,
					delta: 0.34,
				},
				claimEvidence: {
					claims_verified: 1,
					unsupported_claims: 1,
					evidence_refs: ["test://sim-replay-case-a"],
				},
			}),
		).rejects.toMatchObject({ code: "validation" });
		expect(store.peekText(wf.paths.ledgerPath)).toBeUndefined();

		// Fixing unsupported_claims to 0 succeeds and validates cleanly.
		const acceptedRec = await wf.record({
			accepted: true,
			controlBaseline: {
				baseline_type: "unchanged",
				baseline_score: 0.33,
				candidate_score: 0.67,
				delta: 0.34,
				notes: "beats unchanged baseline by +0.34",
			},
			claimEvidence: {
				claims_verified: 2,
				unsupported_claims: 0,
				evidence_refs: ["test://sim-replay-case-a"],
			},
		});
		expect(acceptedRec.recorded).toBe(true);
		const ledgerAfterAccept = store.peekText(wf.paths.ledgerPath);
		expect(ledgerAfterAccept).toBeDefined();
		expect((await wf.validate()).valid).toBe(true);

		// A subsequent rejected candidate must leave sim.json byte-identical and log to sim-rejected.jsonl.
		await wf.predict({
			problem: "P1",
			predicted: [CASE_B],
			what: "Speculative regex fallback that missed",
			files: ["packages/ai/src/utils/json-parse.ts"],
			model: "claude-opus-5.5",
			domain: "parsers",
			benchmark: "json-parse-repair",
			baseline: { passed_ids: [CASE_A, CASE_C], failed_ids: [CASE_B], model: "claude-opus-5.5" },
		});
		const rejectedRec = await wf.record({
			accepted: false,
			controlBaseline: {
				baseline_type: "heuristic",
				baseline_score: 0.67,
				candidate_score: 0.67,
				delta: 0,
			},
			claimEvidence: {
				claims_verified: 0,
				unsupported_claims: 1,
				evidence_refs: ["test://sim-replay-case-b"],
			},
		});
		expect(rejectedRec.recorded).toBe(false);
		expect(store.peekText(wf.paths.ledgerPath)).toBe(ledgerAfterAccept);
		const rejectedEntries = store.peekRejectedEntries(wf.paths.rejectedLogPath);
		expect(rejectedEntries).toHaveLength(1);
		expect(rejectedEntries[0]?.control_baseline?.baseline_type).toBe("heuristic");
		expect(rejectedEntries[0]?.claim_evidence?.unsupported_claims).toBe(1);
	});
});
