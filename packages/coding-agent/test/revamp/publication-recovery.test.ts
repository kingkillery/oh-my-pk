import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { schedulerTick } from "../../src/operational/lifecycle-scheduler";
import { OperationalStore } from "../../src/operational/store";
import { prepareLifecycleLaunch } from "../../src/task/launch-admission";
import {
	type LaunchAuthorityRefV1,
	launchAuthorityRefFor,
	type RuntimePolicySnapshotV1,
} from "../../src/task/launch-contract";
import { createSpawnPlan } from "../../src/task/spawn-plan";
import {
	createTestAuthorizationSnapshot,
	createTestCapsule,
	createTestCompiledContract,
	createTestPolicy,
	createTestRunLimits,
	createTestSnapshotRef,
} from "../helpers/lifecycle-fixtures";

// Scenario-specific budget: room for a root plus one settled child.
const RECOVERY_LIMITS = Object.freeze({
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

function makeCapsule() {
	return createTestCapsule({ objective: "Recovery fixture" });
}

function makePolicy(overrides: Partial<RuntimePolicySnapshotV1> = {}): RuntimePolicySnapshotV1 {
	return createTestPolicy({ limits: RECOVERY_LIMITS, ...overrides });
}

describe("Acceptance 6 — declared confinement", () => {
	it("returns required_isolation_unavailable with zero provisioned resources", () => {
		const dbPath = path.join(os.tmpdir(), `confined-${Date.now()}.db`);
		const store = OperationalStore.open({ dbPath });
		try {
			const planned = createSpawnPlan({
				correlationId: "corr-confined",
				agentName: "oracle",
				assignment: "Confined mission",
				modelPatterns: ["pi/smol"],
			});
			if (!planned.ok) throw new Error("spawn fixture failed");
			const result = prepareLifecycleLaunch(store, {
				spawnPlan: planned.plan,
				compileInput: {
					capsule: makeCapsule(),
					policy: makePolicy({ isolationLevel: "confined" }),
					authorization: createTestAuthorizationSnapshot(),
					requiredInputIds: [],
				},
				owner: null,
				idempotencyKey: "key-confined",
				reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
				prerequisiteIds: [],
				services: { confinedBackend: null },
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.diagnostics[0]?.code).toBe("required_isolation_unavailable");
			expect(() => store.getLifecycleRunSnapshot("run-1")).toThrowError(
				expect.objectContaining({ code: "run_not_found" }),
			);
		} finally {
			store.close();
		}
	});
});

describe("Acceptance 12/13 — durable delivery and stale attempts", () => {
	it("survives close/reopen with exactly-once delivery and rejects stale fences", () => {
		const dbPath = path.join(os.tmpdir(), `recovery-${Date.now()}.db`);
		const compiled = createTestCompiledContract({ objective: "Recovery fixture" }, { limits: RECOVERY_LIMITS });
		const first = OperationalStore.open({ dbPath });
		let attemptId = "";
		// Captured from the durable binding the run admission persisted, so the
		// reopened process fences against the real authority rather than a
		// literal restated in the test.
		let launchAuthority: LaunchAuthorityRefV1 | null = null;
		try {
			const created = first.createLifecycleRun("run-1", compiled, RECOVERY_LIMITS, "key-root");
			if (!created.ok) throw new Error(`fixture run failed: ${created.code}`);
			const rootBinding = created.launch.binding;
			attemptId = rootBinding.attemptId;
			launchAuthority = launchAuthorityRefFor(rootBinding);
			const fence = {
				runId: "run-1",
				nodeId: rootBinding.lifecycle?.nodeId ?? "",
				attemptId,
				leaseOwner: "owner-1",
				leaseEpoch: 1,
				cancellationGeneration: 0,
				launchAuthority,
			};
			const settled = first.settleLifecycleAttempt({
				fence,
				idempotencyKey: "settle-1",
				handoff: {
					schemaVersion: 1,
					kind: "settled",
					eventId: `settled:${attemptId}`,
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
		} finally {
			first.close();
		}

		const second = OperationalStore.open({ dbPath });
		try {
			const tick = schedulerTick(second);
			expect(tick.deliveredHandoffs).toBe(1);
			expect(schedulerTick(second).deliveredHandoffs).toBe(0);

			const stale = second.settleLifecycleAttempt({
				fence: {
					runId: "run-1",
					nodeId: "node-x",
					attemptId,
					leaseOwner: "owner-1",
					leaseEpoch: 99,
					cancellationGeneration: 0,
					launchAuthority: launchAuthority!,
				},
				idempotencyKey: "settle-stale",
				handoff: {
					schemaVersion: 1,
					kind: "settled",
					eventId: `settled:${attemptId}:retry`,
					fence: {
						runId: "run-1",
						nodeId: "node-x",
						attemptId,
						leaseOwner: "owner-1",
						leaseEpoch: 99,
						cancellationGeneration: 0,
						launchAuthority: launchAuthority!,
					},
					ownerNodeId: "run-1-root",
					targetNodeId: null,
					correlationId: null,
					missionHash: compiled.missionHash,
					baseline: createTestSnapshotRef(),
					outcome: "completed",
					summary: "late",
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
			expect(stale.ok).toBe(false);
		} finally {
			second.close();
		}
	});
});
