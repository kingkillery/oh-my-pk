import { describe, expect, test } from "bun:test";
import { type EvaluationRow, evaluate } from "./evaluate";
import { FAMILY, inputHash, policyFingerprint } from "./scorer";
import { DIMENSIONS, FORMAT_VERSION, MODEL } from "./titan";

const vector = Array.from({ length: DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
function row(i: number): EvaluationRow {
	const decision = {
		id: `c${i}`,
		group: `g${i}`,
		family: FAMILY,
		question: "Next?",
		state: "No errors",
		at: i * 10,
		choices: [{ id: "p", actionKey: "pass" as const, description: "continue" }],
	};
	return {
		split: i < 8 ? "train" : i < 10 ? "validation" : "test",
		decision,
		policy: {
			identity: policyFingerprint({}),
			scope: "public-demo",
			config: {},
			evaluation: { stallSeverity: 0, isThrashing: 0.1, blockerType: "none", confidence: 1, latencyMs: 5 },
		},
		embedding: { vector, model: MODEL, format: FORMAT_VERSION, inputHash: inputHash(decision) },
		incumbent: "pass",
		incumbentLatencyMs: 5,
		embeddingLatencyMs: 12,
		embeddingCostUsd: 0.001,
		outcome: i < 8 ? { action: "pass", success: i % 2 === 0, knownAt: i * 10 + 1 } : null,
		label: { action: "pass", reviewer: "reviewer", reviewedAt: i * 10 + 2, independent: true },
	};
}
describe("real data evaluation contract", () => {
	test("fits only prior training outcomes and reports held-out metrics", () => {
		const report = evaluate(Array.from({ length: 12 }, (_, i) => row(i)));
		expect(report.splitSizes).toEqual({ train: 8, observedTrain: 8, validation: 2, test: 2 });
		expect(report.counts.independentLabels).toBe(2);
		expect(report.counts.incumbentCorrect).toBe(2);
		expect(report.counts.hybridCorrect).toBe(2);
		expect(report.headBlocker).toBeNull();
		expect(report.qualityGate).toBe("unproven");
	});
	test("rejects related groups and incompatible vector manifests", () => {
		const rows = Array.from({ length: 12 }, (_, i) => row(i));
		rows[11]!.decision.group = rows[0]!.decision.group;
		expect(() => evaluate(rows)).toThrow("crosses splits");
		rows[11] = row(11);
		rows[11]!.embedding.format = "old";
		expect(() => evaluate(rows)).toThrow("incompatible embedding");
	});
	test("rejects outcomes and validation labels that became known after the next split began", () => {
		const rows = Array.from({ length: 12 }, (_, i) => row(i));
		rows[0]!.outcome!.knownAt = rows[8]!.decision.at;
		expect(() => evaluate(rows)).toThrow("training outcome was not known before evaluation");
		rows[0] = row(0);
		rows[8]!.label!.reviewedAt = rows[10]!.decision.at;
		expect(() => evaluate(rows)).toThrow("validation label was not known before testing");
	});
	test("reports insufficient outcomes instead of inventing a head or labels", () => {
		const rows = Array.from({ length: 12 }, (_, i) => row(i));
		for (const r of rows) {
			r.outcome = null;
			if (r.label) r.label.independent = false;
		}
		const report = evaluate(rows);
		expect(report.headBlocker).toBeTruthy();
		expect(report.counts.independentLabels).toBe(0);
		expect(report.counts.hybridAnswered).toBe(0);
		expect(report.answeredErrorRate).toBeNull();
	});
});
