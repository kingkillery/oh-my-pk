import { describe, expect, it } from "bun:test";
import { type ExperimentManifestV1, LifecycleLab } from "../../src/autoresearch/lifecycle-lab";
import { parseEvaluateManifest } from "../../src/task/evaluate-manifest";
import { recordObservation, validateReduction } from "../../src/task/lifecycle-observations";

import {
	createTestArtifactRef,
	createTestRunLimits,
	createTestSnapshotRef,
	DUMMY_HASH_1,
} from "../helpers/lifecycle-fixtures";

function makeManifest(): ExperimentManifestV1 {
	return {
		schemaVersion: 1,
		experimentId: "exp-1",
		hypothesis: "Reducer preserves exact evidence",
		mechanismVersion: "reducer-v1",
		source: createTestSnapshotRef(),
		allowedPaths: ["src/"],
		trainingSetRefs: [createTestArtifactRef("train-1")],
		heldoutGrantId: "heldout-grant-1",
		harnessRef: "harness-v1",
		environmentRef: "env-local",
		limits: createTestRunLimits(),
		reservation: { requests: 10, runtimeMs: 30_000, tokens: null, costMicrounits: null },
		rollbackRef: createTestArtifactRef("rollback-1"),
		imageDigest: `sha256:${DUMMY_HASH_1}`,
		resourceLimits: { cpuMillis: 1000, memoryBytes: 512 * 1024 * 1024, pids: 64, timeoutMs: 30_000 },
		acceptancePolicyHash: DUMMY_HASH_1,
	};
}

describe("Observation receipts (A16)", () => {
	it("rejects corrupt hash/quote/span/exit and retains raw access", () => {
		const { record, raw } = recordObservation({
			runId: "run-1",
			nodeId: "node-1",
			attemptId: "att-1",
			toolCallId: "call-1",
			rawBytes: "exact bytes here",
			exitCode: 0,
			provenance: ["run-1/node-1"],
		});
		const good = validateReduction(record, raw, { quotes: [{ start: 0, end: 5, text: "exact" }], exitCode: 0 });
		expect(good.ok).toBe(true);

		expect(validateReduction(record, "tampered bytes", { quotes: [], exitCode: 0 }).ok).toBe(false);
		expect(validateReduction(record, raw, { quotes: [{ start: 0, end: 5, text: "WRONG" }], exitCode: 0 }).ok).toBe(
			false,
		);
		expect(validateReduction(record, raw, { quotes: [{ start: -1, end: 99, text: "x" }], exitCode: 0 }).ok).toBe(
			false,
		);
		expect(validateReduction(record, raw, { quotes: [], exitCode: 1 }).ok).toBe(false);
	});

	it("never turns a nonzero exit into a pass", () => {
		const { record, raw } = recordObservation({
			runId: "run-1",
			nodeId: "node-1",
			attemptId: "att-1",
			toolCallId: "call-2",
			rawBytes: "failing output",
			exitCode: 2,
			provenance: [],
		});
		const reduced = validateReduction(record, raw, { quotes: [], exitCode: 2 });
		expect(reduced.ok).toBe(true);
		if (reduced.ok) expect(reduced.reduced.exitCode).toBe(2);
	});
});

describe("Evaluation manifest parsing", () => {
	it("rejects manifests without pinned tasks and budgets", () => {
		expect(() => parseEvaluateManifest({})).toThrow();
		expect(() =>
			parseEvaluateManifest({
				candidateLabel: "c",
				baselineLabel: "b",
				tasks: [],
				seeds: [1],
				limits: { timeoutMs: 1000 },
				acceptancePolicy: "p",
			}),
		).toThrow();
	});

	it("accepts a fully pinned manifest", () => {
		const manifest = parseEvaluateManifest({
			candidateLabel: "c",
			baselineLabel: "b",
			tasks: ["test/a.test.ts"],
			seeds: [7],
			limits: { timeoutMs: 1000 },
			acceptancePolicy: "p",
		});
		expect(manifest.tasks).toEqual(["test/a.test.ts"]);
	});
});

describe("Research isolation boundary (A17)", () => {
	it("refuses lab runs without a verified confined backend", () => {
		const lab = new LifecycleLab({ confinedBackendAvailable: false });
		expect(lab.prepareExperiment(makeManifest()).ok).toBe(true);
		const training = lab.runTraining("exp-1");
		expect(training.ok).toBe(false);
		if (!training.ok) expect(training.code).toBe("required_isolation_unavailable");
	});

	it("runs the full prepare/train/freeze/evaluate/promote cycle with exact-hash approval", () => {
		const lab = new LifecycleLab({ confinedBackendAvailable: true });
		expect(lab.prepareExperiment(makeManifest()).ok).toBe(true);
		expect(lab.runTraining("exp-1").ok).toBe(true);
		expect(lab.freezeCandidate("exp-1").ok).toBe(true);
		expect(lab.evaluateHeldOut("exp-1", true).ok).toBe(true);
		const stale = lab.applyApprovedPromotion("exp-1", "approval-1", "wrong-hash");
		expect(stale.ok).toBe(false);
		const promoted = lab.applyApprovedPromotion("exp-1", "approval-1", DUMMY_HASH_1);
		expect(promoted.ok).toBe(true);
	});
});
