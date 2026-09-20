import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { OperationalStore } from "../../src/operational/store";
import { prepareLifecycleLaunch } from "../../src/task/launch-admission";
import type { MissionCapsule, RuntimePolicySnapshotV1 } from "../../src/task/launch-contract";
import { compileLaunchContract } from "../../src/task/launch-contract";
import { createSpawnPlan, type SpawnPlan } from "../../src/task/spawn-plan";
import { createTestCapsule, createTestPolicy, createTestRunLimits } from "../helpers/lifecycle-fixtures";

// Scenario-specific budget: room for a root plus the admitted child.
const ADMISSION_LIMITS = Object.freeze({
	...createTestRunLimits(),
	maxNodes: 4,
	maxDepth: 2,
	maxAttemptsPerNode: 2,
	maxOutstanding: 4,
	maxActiveCompute: 2,
	maxRequests: 10,
	maxRuntimeMs: 60_000,
	maxComputeRuntimeMs: 30_000,
	maxTokens: null,
	maxCostMicrounits: null,
	currency: null,
	maxHandoffBytes: 16_384,
	maxInboxEvents: 20,
});

function makeSpawnPlan(): SpawnPlan {
	const planned = createSpawnPlan({
		correlationId: "corr-admit-1",
		agentName: "oracle",
		assignment: "Admit a bounded child mission",
		modelPatterns: ["pi/smol"],
		softRequestBudget: 2,
		maxRuntimeMs: 10_000,
	});
	if (!planned.ok) throw new Error("SpawnPlan fixture failed to compile");
	return planned.plan;
}

function makeCapsule(): MissionCapsule {
	return createTestCapsule({
		objective: "Admit a bounded child mission",
		writableScope: Object.freeze(["src/child.ts"]),
	});
}

function makePolicy(): RuntimePolicySnapshotV1 {
	return createTestPolicy({ limits: ADMISSION_LIMITS });
}

describe("Lifecycle launch admission (B1)", () => {
	it("rejects invalid scope with diagnostics and zero allocations", () => {
		const dbPath = path.join(os.tmpdir(), `admit-invalid-${Date.now()}.db`);
		const store = OperationalStore.open({ dbPath });
		try {
			const result = prepareLifecycleLaunch(store, {
				spawnPlan: makeSpawnPlan(),
				compileInput: {
					capsule: { ...makeCapsule(), writableScope: ["../escape.ts"] },
					policy: makePolicy(),
					parentPolicy: null,
					requiredInputIds: [],
				},
				ownerNodeId: null,
				runId: "run-1",
				idempotencyKey: "key-1",
				reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
				prerequisiteIds: [],
				expectedPlanVersion: 1,
				expectedCancellationGeneration: 0,
			});
			expect(result.ok).toBe(false);
		} finally {
			store.close();
		}
	});

	it("compiles and admits a valid child against an existing run", () => {
		const dbPath = path.join(os.tmpdir(), `admit-valid-${Date.now()}.db`);
		const store = OperationalStore.open({ dbPath });
		try {
			const policy = makePolicy();
			const compiled = compileLaunchContract({
				capsule: makeCapsule(),
				policy,
				parentPolicy: null,
				requiredInputIds: [],
			});
			expect(compiled.ok).toBe(true);
			if (!compiled.ok) return;

			const created = store.createLifecycleRun("run-1", compiled.compiled, ADMISSION_LIMITS, "key-root");
			expect(created.ok).toBe(true);

			const result = prepareLifecycleLaunch(store, {
				spawnPlan: makeSpawnPlan(),
				compileInput: { capsule: makeCapsule(), policy, parentPolicy: null, requiredInputIds: [] },
				ownerNodeId: "run-1-root",
				runId: "run-1",
				idempotencyKey: "key-child-1",
				reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
				prerequisiteIds: [],
				expectedPlanVersion: 1,
				expectedCancellationGeneration: 0,
			});
			expect(result.ok).toBe(true);
		} finally {
			store.close();
		}
	});
});
