import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { OperationalStore } from "../../src/operational/store";
import { createTestCompiledContract, createTestRunLimits } from "../helpers/lifecycle-fixtures";

// Scenario-specific budget: root plus two children exhausts maxNodes, which is
// the boundary these tests exercise. Do not raise it to make admission pass.
const CONTENTION_LIMITS = Object.freeze({
	...createTestRunLimits(),
	maxNodes: 3,
	maxDepth: 1,
	maxAttemptsPerNode: 1,
	maxOutstanding: 2,
	maxActiveCompute: 1,
	maxRequests: 5,
	maxRuntimeMs: 30_000,
	maxComputeRuntimeMs: 15_000,
	maxTokens: null,
	maxCostMicrounits: null,
	currency: null,
	maxHandoffBytes: 16_384,
	maxInboxEvents: 10,
});

function openRun() {
	const dbPath = path.join(os.tmpdir(), `contention-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const store = OperationalStore.open({ dbPath });
	const compiled = createTestCompiledContract({ objective: "Contention fixture" }, { limits: CONTENTION_LIMITS });
	const created = store.createLifecycleRun("run-1", compiled, CONTENTION_LIMITS, "key-root");
	if (!created.ok) throw new Error(`fixture run creation failed: ${created.code}`);
	return { store, compiled, limits: CONTENTION_LIMITS };
}

describe("Acceptance 3 — recursive ownership under contention", () => {
	it("returns the single existing allocation for a repeated idempotency key", () => {
		const { store, compiled } = openRun();
		try {
			const base = {
				runId: "run-1",
				ownerNodeId: "run-1-root",
				nodeId: null as string | null,
				idempotencyKey: "key-race-1",
				compiled,
				expectedPlanVersion: 1,
				expectedCancellationGeneration: 0,
				reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
				prerequisiteIds: [],
			};
			const first = store.admitLifecycleAttempt(base);
			const second = store.admitLifecycleAttempt(base);
			expect(first.ok).toBe(true);
			expect(second.ok).toBe(true);
			if (first.ok && second.ok) {
				expect(second.job.id).toBe(first.job.id);
				expect(second.launch.envelope.nodeId).toBe(first.launch.envelope.nodeId);
			}
			expect(store.listLifecycleNodes("run-1")).toHaveLength(2);
		} finally {
			store.close();
		}
	});

	it("rejects the same key with different inputs as a conflict", () => {
		const { store, compiled } = openRun();
		try {
			const base = {
				runId: "run-1",
				ownerNodeId: "run-1-root",
				nodeId: null as string | null,
				idempotencyKey: "key-race-2",
				compiled,
				expectedPlanVersion: 1,
				expectedCancellationGeneration: 0,
				reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
				prerequisiteIds: [],
			};
			expect(store.admitLifecycleAttempt(base).ok).toBe(true);
			const conflict = store.admitLifecycleAttempt({
				...base,
				reservation: { requests: 2, runtimeMs: 2000, tokens: null, costMicrounits: null },
			});
			expect(conflict.ok).toBe(false);
			if (!conflict.ok) expect(conflict.code).toBe("admission_conflict");
		} finally {
			store.close();
		}
	});
});

describe("Acceptance 10 — capacity conservation", () => {
	it("refuses new nodes once the run node limit is reached", () => {
		const { store, compiled } = openRun();
		try {
			const admit = (key: string) =>
				store.admitLifecycleAttempt({
					runId: "run-1",
					ownerNodeId: "run-1-root",
					nodeId: null,
					idempotencyKey: key,
					compiled,
					expectedPlanVersion: 1,
					expectedCancellationGeneration: 0,
					reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
					prerequisiteIds: [],
				});
			expect(admit("key-cap-1").ok).toBe(true);
			expect(admit("key-cap-2").ok).toBe(true);
			const exhausted = admit("key-cap-3");
			expect(exhausted.ok).toBe(false);
			if (!exhausted.ok) expect(exhausted.code).toBe("budget_exhausted");
		} finally {
			store.close();
		}
	});
});
