import { describe, expect, it } from "bun:test";
import {
	bindLaunchContract,
	compileLaunchContract,
	computeMissionHash,
	computePolicyHash,
	parseLaunchContract,
	parseLifecycleFence,
	parseLifecycleHandoff,
	parseObligationV1,
} from "../../src/task/launch-contract";
import {
	createTestArtifactRef,
	createTestAuthorizationSnapshot,
	createTestCapsule,
	createTestGrantRecord,
	createTestPolicy,
	createTestSnapshotRef,
	DUMMY_HASH_1,
} from "../helpers/lifecycle-fixtures";

/**
 * Build an authorization snapshot whose issuer holds exactly `issuerGrantIds`
 * (defaulting to the child's own grants, i.e. a fully-covering issuer).
 * Passing a narrower set is how a test exercises parent narrowing.
 */
function authFor(
	policy: ReturnType<typeof createTestPolicy>,
	issuerGrantIds?: readonly string[],
): ReturnType<typeof createTestAuthorizationSnapshot> {
	return createTestAuthorizationSnapshot({
		sourceGrants: (issuerGrantIds ?? policy.grantRefs).map(grantId => createTestGrantRecord({ grantId })),
	});
}

describe("Launch Contract (A02)", () => {
	it("compiles valid mission and policy into frozen immutable contract", () => {
		const capsule = createTestCapsule();
		const policy = createTestPolicy();
		const res = compileLaunchContract({
			capsule,
			policy,
			authorization: authFor(policy),
			requiredInputIds: ["art-1"],
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		expect(res.compiled.schemaVersion).toBe(2);
		expect(res.compiled.contractRevision).toBe(1);
		expect(res.compiled.missionHash).toBe(computeMissionHash(res.compiled.capsule));
		expect(res.compiled.policyHash).toBe(computePolicyHash(res.compiled.policy));
		expect(Object.isFrozen(res.compiled)).toBe(true);
		expect(Object.isFrozen(res.compiled.capsule)).toBe(true);
		expect(Object.isFrozen(res.compiled.policy)).toBe(true);
	});

	it("retains array order and visible fields in mission hash", () => {
		const capA = createTestCapsule({
			acceptance: [
				{ id: "c1", description: "First" },
				{ id: "c2", description: "Second" },
			],
		});
		const capB = createTestCapsule({
			acceptance: [
				{ id: "c2", description: "Second" },
				{ id: "c1", description: "First" },
			],
		});
		// Array order is semantically significant and must not be locale-sorted away
		expect(computeMissionHash(capA)).not.toBe(computeMissionHash(capB));
	});

	it("rejects mission with traversal escape in writableScope or readableScope", () => {
		const capsuleBadWrite = createTestCapsule({
			writableScope: ["src/../../escape.ts"],
		});
		const res1 = compileLaunchContract({
			capsule: capsuleBadWrite,
			policy: createTestPolicy(),
			authorization: authFor(createTestPolicy()),
			requiredInputIds: [],
		});
		expect(res1.ok).toBe(false);
		if (!res1.ok) {
			expect(res1.diagnostics.some(d => d.code === "invalid_scope_escape")).toBe(true);
		}

		const capsuleDrive = createTestCapsule({
			writableScope: ["C:\\Windows\\System32"],
		});
		const res2 = compileLaunchContract({
			capsule: capsuleDrive,
			policy: createTestPolicy(),
			authorization: authFor(createTestPolicy()),
			requiredInputIds: [],
		});
		expect(res2.ok).toBe(false);

		const capsuleUri = createTestCapsule({
			readableScope: ["s3://bucket/key"],
		});
		const res3 = compileLaunchContract({
			capsule: capsuleUri,
			policy: createTestPolicy(),
			authorization: authFor(createTestPolicy()),
			requiredInputIds: [],
		});
		expect(res3.ok).toBe(false);
		if (!res3.ok) {
			expect(res3.diagnostics.some(d => d.code === "unknown_scope_backend")).toBe(true);
		}
	});

	it("rejects mission when required input is missing or not granted", () => {
		const capsule = createTestCapsule({
			inputs: [{ artifact: createTestArtifactRef("art-1"), description: "doc", grantId: "grant-ungranted" }],
		});
		const policy = createTestPolicy({ grantRefs: ["grant-other"] });
		const res = compileLaunchContract({
			capsule,
			policy,
			authorization: authFor(policy),
			requiredInputIds: ["art-1"],
		});
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.diagnostics.some(d => d.code === "missing_required_input")).toBe(true);
		}
	});

	it("rejects child scope when not a proven subset of parent", () => {
		const parentPolicy = createTestPolicy({
			grantRefs: ["grant-parent"],
		});
		const childPolicy = createTestPolicy({
			grantRefs: ["grant-parent", "grant-unauthorized"],
		});
		const res = compileLaunchContract({
			capsule: createTestCapsule(),
			policy: childPolicy,
			authorization: authFor(childPolicy, parentPolicy.grantRefs),
			requiredInputIds: [],
		});
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.diagnostics.some(d => d.code === "scope_not_proven_subset")).toBe(true);
		}
	});

	it("binds compiled launch contract with runtime authority and content-addressed capability manifest", () => {
		const compiledRes = compileLaunchContract({
			capsule: createTestCapsule(),
			policy: createTestPolicy(),
			authorization: authFor(createTestPolicy()),
			requiredInputIds: [],
		});
		expect(compiledRes.ok).toBe(true);
		if (!compiledRes.ok) return;

		const bound = bindLaunchContract(compiledRes.compiled, {
			runId: "run-001",
			nodeId: "node-001",
			ownerNodeId: null,
			attemptId: "att-001",
			budgetReservationId: "res-001",
			leaseEpoch: 1,
			cancellationGeneration: 0,
		});

		expect(bound.envelope.runId).toBe("run-001");
		expect(bound.envelope.nodeId).toBe("node-001");
		expect(bound.envelope.capabilityManifestRef.startsWith("cap-")).toBe(true);
		expect(bound.contractVersion).toBe(1);
		expect(bound.policySchemaVersion).toBe(1);
		expect(bound.harnessSchemaVersion).toBe(1);

		// parseLaunchContract strictly revalidates
		const parsed = parseLaunchContract(bound);
		expect(parsed.envelope.missionHash).toBe(bound.envelope.missionHash);
		expect(parsed.envelope.policyHash).toBe(bound.envelope.policyHash);

		// Tampering with hash must reject
		const tampered = {
			...bound,
			envelope: {
				...bound.envelope,
				missionHash: "badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad",
			},
		};
		expect(() => parseLaunchContract(tampered)).toThrow();
	});

	it("strictly validates LifecycleFence, LifecycleHandoff, and ObligationV1", () => {
		const fence = parseLifecycleFence({
			runId: "r1",
			nodeId: "n1",
			attemptId: "a1",
			leaseOwner: "owner1",
			leaseEpoch: 1,
			cancellationGeneration: 0,
			contractVersion: 1,
		});
		expect(fence.runId).toBe("r1");

		expect(() =>
			parseLifecycleFence({
				runId: "",
				nodeId: "n1",
				attemptId: "a1",
				leaseOwner: "owner1",
				leaseEpoch: 1,
				cancellationGeneration: 0,
				contractVersion: 1,
			}),
		).toThrow();

		const handoff = parseLifecycleHandoff({
			schemaVersion: 1,
			kind: "settled",
			eventId: "settled:a1",
			fence,
			ownerNodeId: null,
			targetNodeId: null,
			correlationId: null,
			missionHash: DUMMY_HASH_1,
			baseline: createTestSnapshotRef(),
			outcome: "completed",
			summary: "All tests green",
			manifest: null,
			evidenceRefs: [],
			observedExitCode: 0,
			changedPaths: ["src/a.ts"],
			obligationIds: [],
			proposedNextAction: null,
		});
		expect(handoff.kind).toBe("settled");
		expect(handoff.outcome).toBe("completed");

		// Mismatched settled eventId must throw
		expect(() =>
			parseLifecycleHandoff({
				...handoff,
				eventId: "settled:wrong-attempt",
			}),
		).toThrow();

		const obligation = parseObligationV1({
			schemaVersion: 1,
			obligationId: "ob-1",
			runId: "r1",
			nodeId: "n1",
			criterionId: "crit-1",
			kind: "mandatory_criterion",
			state: "resolved",
			evidenceReceiptIds: ["rcpt-1"],
			waiverAuthorizationRef: null,
			version: 1,
		});
		expect(obligation.state).toBe("resolved");

		// Resolved without evidence must throw
		expect(() =>
			parseObligationV1({
				...obligation,
				evidenceReceiptIds: [],
			}),
		).toThrow();
	});
});
