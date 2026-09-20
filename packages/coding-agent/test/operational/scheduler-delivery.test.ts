import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { schedulerTick } from "../../src/operational/lifecycle-scheduler";
import { OperationalStore } from "../../src/operational/store";
import {
	createTestArtifactRef,
	createTestCompiledContract,
	createTestRunLimits,
	createTestSnapshotRef,
} from "../helpers/lifecycle-fixtures";

// Scenario-specific budget: this run needs room for a root plus one settled
// child, and a bounded inbox so delivery is observable.
const SCHEDULER_LIMITS = Object.freeze({
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

describe("Lifecycle scheduler and durable delivery (C1)", () => {
	it("delivers a settled handoff exactly once through the scheduler", () => {
		const dbPath = path.join(os.tmpdir(), `sched-${Date.now()}.db`);
		const store = OperationalStore.open({ dbPath });
		try {
			const compiled = createTestCompiledContract(
				{ objective: "Scheduler delivery fixture" },
				{ limits: SCHEDULER_LIMITS },
			);

			const created = store.createLifecycleRun("run-1", compiled, SCHEDULER_LIMITS, "key-root");
			expect(created.ok).toBe(true);
			if (!created.ok) return;

			const fence = {
				runId: "run-1",
				nodeId: created.launch.envelope.nodeId,
				attemptId: created.launch.envelope.attemptId,
				leaseOwner: "owner-1",
				leaseEpoch: 1,
				cancellationGeneration: 0,
				contractVersion: 1,
			};
			const settled = store.settleLifecycleAttempt({
				fence,
				idempotencyKey: "settle-1",
				handoff: {
					schemaVersion: 1,
					kind: "settled",
					eventId: `settled:${fence.attemptId}`,
					fence,
					ownerNodeId: "run-1-root",
					targetNodeId: null,
					correlationId: null,
					missionHash: compiled.missionHash,
					baseline: createTestSnapshotRef(),
					outcome: "completed",
					summary: "done",
					manifest: null,
					evidenceRefs: [],
					observedExitCode: 0,
					changedPaths: [],
					obligationIds: [],
					proposedNextAction: null,
				},
				execution: "succeeded",
				captureState: "durable",
				manifest: null,
				observedUsageEventIds: [],
			});
			expect(settled.ok).toBe(true);

			const first = schedulerTick(store);
			expect(first.deliveredHandoffs).toBe(1);
			const second = schedulerTick(store);
			expect(second.deliveredHandoffs).toBe(0);

			const turn = store.prepareLifecyclePlannerTurn({
				ownerNodeId: "run-1-root",
				expectedPlanVersion: 1,
				maxEvents: 10,
				fence: { ...fence, nodeId: "run-1-root", attemptId: "planner-att" },
			});
			expect(turn.inputEvents).toHaveLength(1);

			const commit = store.commitLifecyclePlannerTurn({
				turnId: turn.turnId,
				fence: { ...fence, nodeId: "run-1-root", attemptId: "planner-att" },
				expectedPlanVersion: 1,
				result: createTestArtifactRef("planner-result-1"),
				actions: [{ kind: "wait" }],
			});
			expect(commit.ok).toBe(true);
		} finally {
			store.close();
		}
	});
});
