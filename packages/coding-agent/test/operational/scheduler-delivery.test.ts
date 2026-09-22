import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { schedulerTick } from "../../src/operational/lifecycle-scheduler";
import { OperationalStore } from "../../src/operational/store";
import { launchAuthorityRefFor } from "../../src/task/launch-contract";
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

			// The fence names the durable binding the hierarchical admission
			// persisted for this attempt — no hand-written authority.
			const rootBinding = created.launch.binding;
			expect(rootBinding.lifecycle).not.toBeNull();
			const fence = {
				runId: "run-1",
				nodeId: rootBinding.lifecycle?.nodeId ?? "",
				attemptId: rootBinding.attemptId,
				leaseOwner: "owner-1",
				leaseEpoch: 1,
				cancellationGeneration: 0,
				launchAuthority: launchAuthorityRefFor(rootBinding),
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

	it("claims dependency-ready attempts while keeping blocked attempts queued", () => {
		const dbPath = path.join(os.tmpdir(), `sched-deps-${Date.now()}.db`);
		const store = OperationalStore.open({ dbPath });
		try {
			const compiled = createTestCompiledContract(
				{ objective: "Dependency scheduling fixture" },
				{ limits: SCHEDULER_LIMITS },
			);
			const created = store.createLifecycleRun("run-deps", compiled, SCHEDULER_LIMITS, "key-deps-root");
			expect(created.ok).toBe(true);
			// Initial tick claims the root attempt
			const tick0 = schedulerTick(store, { leaseOwner: "root-worker" });
			expect(tick0.startedAttempts).toBe(1);

			// Admit child 1 (independent)
			const child1 = store.admitLifecycleAttempt({
				runId: "run-deps",
				ownerNodeId: "run-deps-root",
				nodeId: "node-child-1",
				idempotencyKey: "key-child-1",
				compiled,
				expectedPlanVersion: 1,
				expectedCancellationGeneration: 0,
				reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
				prerequisiteIds: [],
			});
			expect(child1.ok).toBe(true);

			// Admit child 2 (depends on child 1)
			const child2 = store.admitLifecycleAttempt({
				runId: "run-deps",
				ownerNodeId: "run-deps-root",
				nodeId: "node-child-2",
				idempotencyKey: "key-child-2",
				compiled,
				expectedPlanVersion: 1,
				expectedCancellationGeneration: 0,
				reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
				prerequisiteIds: ["node-child-1"],
			});
			expect(child2.ok).toBe(true);

			// First tick: child 1 is ready and claimed; child 2 is blocked by child 1
			const tick1 = schedulerTick(store, { leaseOwner: "worker-1" });
			expect(tick1.startedAttempts).toBe(1);

			// Second tick: child 2 still blocked, nothing new to start
			const tick2 = schedulerTick(store, { leaseOwner: "worker-1" });
			expect(tick2.startedAttempts).toBe(0);

			// Settle child 1 as succeeded
			const binding1 = child1.ok ? child1.launch.binding : null;
			if (!binding1) throw new Error("expected child 1 admission");
			const fence1 = {
				runId: "run-deps",
				nodeId: "node-child-1",
				attemptId: binding1.attemptId,
				leaseOwner: "worker-1",
				leaseEpoch: 1,
				cancellationGeneration: 0,
				launchAuthority: {
					schemaVersion: 1 as const,
					bindingId: binding1.bindingId,
					contractId: binding1.contractId,
					contractRevision: binding1.contractRevision,
					principalId: binding1.childPrincipalId,
					attemptId: binding1.attemptId,
					contractDigest: binding1.contractDigest,
					policyEpoch: binding1.policyEpoch,
				},
			};
			const settled1 = store.settleLifecycleAttempt({
				fence: fence1,
				idempotencyKey: "settle-child-1",
				handoff: {
					schemaVersion: 1,
					kind: "settled",
					eventId: `settled:${fence1.attemptId}`,
					fence: fence1,
					ownerNodeId: "run-deps-root",
					targetNodeId: null,
					correlationId: null,
					missionHash: compiled.missionHash,
					baseline: createTestSnapshotRef(),
					outcome: "completed",
					summary: "done child 1",
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
			expect(settled1.ok).toBe(true);

			// Third tick: child 1's success unlocks child 2!
			const tick3 = schedulerTick(store, { leaseOwner: "worker-2" });
			expect(tick3.startedAttempts).toBe(1);
			expect(tick3.deliveredHandoffs).toBe(1);
		} finally {
			store.close();
		}
	});

	it("reconciles expired running job leases so they can be re-claimed", () => {
		const dbPath = path.join(os.tmpdir(), `sched-recon-${Date.now()}.db`);
		const store = OperationalStore.open({ dbPath });
		try {
			const now = Date.now();
			const job = store.createJob({
				type: "native_task",
				payload: { task: "recon" },
			});
			// Claim the job with an expired lease
			const claimed = store.claimJobById(job.id, "worker-stale", 10);
			expect(claimed).not.toBeNull();

			// Tick with now + 50ms (lease expired)
			const tick = schedulerTick(store, { now: now + 50, leaseOwner: "worker-fresh" });
			expect(tick.reconciledLeases).toBe(1);
			// The job is re-claimed by the fresh worker
			expect(tick.startedAttempts).toBe(1);
		} finally {
			store.close();
		}
	});
});
