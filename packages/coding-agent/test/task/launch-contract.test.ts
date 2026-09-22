import { describe, expect, it } from "bun:test";
import type {
	CompiledLaunchContract,
	LaunchAuthorityRefV1,
	LaunchAuthorizationSnapshotV1,
	LaunchBinding,
	LaunchContract,
	RuntimePolicySnapshotV1,
} from "../../src/task/launch-contract";
import {
	bindLaunchContract,
	compileLaunchContract,
	computeCapabilityManifestRef,
	computeMissionHash,
	computePolicyHash,
	parseArchivalLaunchContractV1,
	parseCompiledLaunchContract,
	parseLaunchAuthorityRefV1,
	parseLaunchBinding,
	parseLaunchContract,
	parseLifecycleFence,
	parseLifecycleHandoff,
	parseMutationContractV1,
	parseObligationV1,
} from "../../src/task/launch-contract";
import {
	createTestArtifactRef,
	createTestAuthorizationSnapshot,
	createTestCapsule,
	createTestCompiledContract,
	createTestGrantRecord,
	createTestMutationContract,
	createTestPolicy,
	createTestRuntimeGuarantees,
	createTestSnapshotRef,
	DUMMY_HASH_1,
	DUMMY_HASH_2,
} from "../helpers/lifecycle-fixtures";

/**
 * Build an authorization snapshot whose issuer holds exactly `issuerGrantIds`
 * (defaulting to the child's own grants, i.e. a fully-covering issuer).
 * Passing a narrower set is how a test exercises parent narrowing.
 */
function authFor(policy: RuntimePolicySnapshotV1, issuerGrantIds?: readonly string[]): LaunchAuthorizationSnapshotV1 {
	return createTestAuthorizationSnapshot({
		sourceGrants: (issuerGrantIds ?? policy.grantRefs).map(grantId => createTestGrantRecord({ grantId })),
	});
}

const ATTEMPT_ID = "att-001";

/**
 * A durable `launch_bindings` record for the fixture contract, shaped the way
 * the store returns one.
 *
 * `bindingId` deliberately differs from `attemptId`: the two diverge on the
 * hierarchical path, and a wrapper that conflated them would hide exactly the
 * identity the runtime needs to resolve a binding.
 */
function durableBinding(compiled: CompiledLaunchContract, overrides: Partial<LaunchBinding> = {}): LaunchBinding {
	return Object.freeze({
		schemaVersion: 1 as const,
		bindingId: `binding-${compiled.contractId}-${compiled.contractRevision}-${ATTEMPT_ID}`,
		contractId: compiled.contractId,
		contractRevision: compiled.contractRevision,
		contractDigest: compiled.contractDigest,
		rootPrincipalId: compiled.rootPrincipalId,
		parentPrincipalId: compiled.parentPrincipalId,
		childPrincipalId: compiled.childPrincipalId,
		attemptId: ATTEMPT_ID,
		sessionId: null,
		processRef: null,
		policyEpoch: 1,
		contextGeneration: 0,
		state: "authorized" as const,
		grantBindings: Object.freeze([{ intentId: "intent-1", grantId: "grant-1", recordDigest: DUMMY_HASH_1 }]),
		serviceBindings: Object.freeze([
			{ kind: "workspace" as const, adapterId: "git-worktree", namespace: "repo:main", guarantee: "contained" },
		]),
		actualRuntimeGuarantees: null,
		guaranteeEvidenceRefs: Object.freeze([]),
		reservationId: null,
		lifecycle: Object.freeze({
			runId: "run-001",
			nodeId: "node-001",
			ownerNodeId: null,
			jobId: "job-001",
			leaseEpoch: 1,
			cancellationGeneration: 0,
		}),
		expiresAt: null,
		restoresBindingId: null,
		...overrides,
	});
}

/** A live binding: `active` requires measured guarantees plus their evidence. */
function activeBinding(compiled: CompiledLaunchContract): LaunchBinding {
	return durableBinding(compiled, {
		state: "active",
		actualRuntimeGuarantees: createTestRuntimeGuarantees(),
		guaranteeEvidenceRefs: Object.freeze([createTestArtifactRef("probe-1")]),
	});
}

function authorityRef(overrides: Partial<LaunchAuthorityRefV1> = {}): LaunchAuthorityRefV1 {
	return Object.freeze({
		bindingId: "binding-1",
		principalId: "principal-child",
		attemptId: "a1",
		contractId: "contract-1",
		contractRevision: 1,
		contractDigest: DUMMY_HASH_1,
		policyEpoch: 1,
		...overrides,
	});
}

function reserialize(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
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
});

describe("Launch Contract v2 wire (§14.2)", () => {
	it("binds a compiled contract to its durable binding without inventing identity", () => {
		const compiled = createTestCompiledContract();
		const binding = durableBinding(compiled);
		const bound = bindLaunchContract(compiled, binding);

		expect(bound.schemaVersion).toBe(2);
		expect(Object.isFrozen(bound)).toBe(true);
		expect(Object.keys(bound).sort()).toEqual(["binding", "compiled", "schemaVersion"]);

		// Every runtime identity comes from the persisted record, not from a
		// synthesized envelope.
		expect(bound.binding.bindingId).toBe(binding.bindingId);
		expect(bound.binding.attemptId).toBe(ATTEMPT_ID);
		expect(bound.binding.bindingId).not.toBe(bound.binding.attemptId);
		expect(bound.binding.lifecycle?.runId).toBe("run-001");
		expect(bound.binding.lifecycle?.nodeId).toBe("node-001");
		expect(bound.compiled.contractDigest).toBe(compiled.contractDigest);

		// The capability manifest ref stays content-addressed and derivable
		// from the bound policy rather than stored on a wire envelope.
		expect(computeCapabilityManifestRef(bound.compiled.policy).startsWith("cap-")).toBe(true);
	});

	it("survives serialization and reparses through the same identity proof", () => {
		const compiled = createTestCompiledContract();
		const bound = bindLaunchContract(compiled, activeBinding(compiled));
		expect(parseLaunchContract(reserialize(bound))).toEqual(bound);
	});

	it("rejects a binding that names a different contract identity", () => {
		const compiled = createTestCompiledContract();
		for (const override of [
			{ contractId: "contract-other" },
			{ contractRevision: 2 },
			{ contractDigest: DUMMY_HASH_2 },
			{ rootPrincipalId: "principal-other-root" },
			{ parentPrincipalId: "principal-other-parent" },
			{ childPrincipalId: "principal-other-child" },
		] satisfies Partial<LaunchBinding>[]) {
			expect(() => bindLaunchContract(compiled, durableBinding(compiled, override))).toThrow(
				/launch_binding_identity_mismatch/,
			);
		}
	});

	it("rejects a compiled body whose content no longer reproduces its hashes", () => {
		const compiled = createTestCompiledContract();
		const binding = durableBinding(compiled);

		const retargeted = { ...compiled, capsule: { ...compiled.capsule, objective: "Exfiltrate secrets" } };
		expect(() => bindLaunchContract(retargeted, binding)).toThrow(/contract_hash_mismatch/);

		// A widened capability set with an untouched digest must not bind:
		// the digest covers the authority, so this is the case a mission/policy
		// hash check alone would miss.
		const widened = {
			...compiled,
			authority: {
				...compiled.authority,
				usableCapabilities: [
					...compiled.authority.usableCapabilities,
					{ source: "builtin" as const, name: "bash" },
				],
			},
		};
		expect(() => bindLaunchContract(widened, binding)).toThrow(/contract_hash_mismatch/);
	});

	it("rejects a live binding that advertises guarantees nobody measured", () => {
		const compiled = createTestCompiledContract();
		expect(() => bindLaunchContract(compiled, durableBinding(compiled, { state: "active" }))).toThrow(
			/requires measured runtime guarantees/,
		);
		expect(() =>
			bindLaunchContract(
				compiled,
				durableBinding(compiled, { state: "bound", actualRuntimeGuarantees: createTestRuntimeGuarantees() }),
			),
		).toThrow(/requires guarantee evidence/);
		expect(bindLaunchContract(compiled, activeBinding(compiled)).binding.state).toBe("active");
	});

	it("reads an archived v1 record without letting it stand in for a runtime contract", () => {
		const compiled = createTestCompiledContract();
		const archival = {
			capsule: compiled.capsule,
			envelope: {
				schemaVersion: 1,
				version: 1,
				runId: "run-001",
				nodeId: "node-001",
				ownerNodeId: null,
				attemptId: ATTEMPT_ID,
				role: compiled.policy.role,
				topology: compiled.policy.topology,
				missionHash: computeMissionHash(compiled.capsule),
				policyHash: computePolicyHash(compiled.policy),
				harnessVersion: compiled.policy.harnessRef,
				capabilityManifestRef: computeCapabilityManifestRef(compiled.policy),
				budgetReservationId: "res-001",
				executionEnvironmentRef: compiled.policy.environmentRef,
				leaseEpoch: 1,
				cancellationGeneration: 0,
			},
			policy: compiled.policy,
			contractVersion: 1,
			policySchemaVersion: 1,
			harnessSchemaVersion: 1,
		};

		const parsed = parseArchivalLaunchContractV1(archival);
		expect(parsed.contractVersion).toBe(1);
		expect(parsed.envelope.attemptId).toBe(ATTEMPT_ID);

		// Tamper evidence survives on the archival path too.
		expect(() =>
			parseArchivalLaunchContractV1({
				...archival,
				envelope: { ...archival.envelope, missionHash: DUMMY_HASH_2 },
			}),
		).toThrow(/contract_hash_mismatch/);

		// A complete, valid archived record is still not a runtime contract —
		// at runtime it has no envelope the v2 parser accepts, and at compile
		// time it is not assignable to `LaunchContract`.
		expect(() => parseLaunchContract(archival)).toThrow(/unknown field/);
		// @ts-expect-error archival v1 must never satisfy the runtime v2 wire
		const asRuntime: LaunchContract = parsed;
		expect(asRuntime).toBeDefined();
	});

	it("rejects a v1 record and an unknown wrapper version at parseLaunchContract", () => {
		const compiled = createTestCompiledContract();
		const bound = bindLaunchContract(compiled, durableBinding(compiled));

		expect(() => parseLaunchContract({ ...bound, schemaVersion: 1 })).toThrow(/unknown version/);
		expect(() => parseLaunchContract({ ...bound, schemaVersion: 3 })).toThrow(/unknown version/);
		expect(() => parseLaunchContract({ ...bound, extra: true })).toThrow(/unknown field/);
		// The precursor v1 shape must not pass the runtime parser.
		expect(() =>
			parseLaunchContract({
				capsule: compiled.capsule,
				envelope: {},
				policy: compiled.policy,
				contractVersion: 1,
				policySchemaVersion: 1,
				harnessSchemaVersion: 1,
			}),
		).toThrow(/unknown field/);
		expect(() => parseLaunchContract(null)).toThrow();
		expect(() => parseLaunchContract([])).toThrow();
	});
});

describe("Strict record parsers (§14.2)", () => {
	it("round-trips and strictly validates parseCompiledLaunchContract", () => {
		const compiled = createTestCompiledContract();
		expect(parseCompiledLaunchContract(reserialize(compiled))).toEqual(compiled);

		expect(() => parseCompiledLaunchContract({ ...compiled, contractDigest: DUMMY_HASH_1 })).toThrow(
			/contract_digest_mismatch/,
		);
		expect(() => parseCompiledLaunchContract({ ...compiled, schemaVersion: 1 })).toThrow(/schemaVersion must be 2/);
		expect(() => parseCompiledLaunchContract({ ...compiled, policyVersion: 2 })).toThrow(/policyVersion must be 1/);
		expect(() => parseCompiledLaunchContract({ ...compiled, contractRevision: 0 })).toThrow(
			/contractRevision must be >= 1/,
		);
		expect(() => parseCompiledLaunchContract({ ...compiled, contractRevision: 1.5 })).toThrow(/contractRevision/);
		expect(() => parseCompiledLaunchContract({ ...compiled, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseCompiledLaunchContract({ ...compiled, missionHash: DUMMY_HASH_2 })).toThrow(/missionHash/);
		expect(() => parseCompiledLaunchContract({ ...compiled, policyHash: "nope" })).toThrow(/policyHash/);

		const { provenance: _provenance, ...missingProvenance } = compiled;
		expect(() => parseCompiledLaunchContract(missingProvenance)).toThrow(/provenance/);

		// An authority whose capability set was widened after compilation keeps
		// a stale digest and must be rejected, not quietly accepted.
		expect(() =>
			parseCompiledLaunchContract({
				...compiled,
				authority: {
					...compiled.authority,
					usableCapabilities: [{ source: "builtin", name: "bash" }],
				},
			}),
		).toThrow(/contract_digest_mismatch/);
		expect(() =>
			parseCompiledLaunchContract({
				...compiled,
				authority: { ...compiled.authority, launchClass: "root" },
			}),
		).toThrow(/launchClass/);
		expect(() =>
			parseCompiledLaunchContract({
				...compiled,
				authority: { ...compiled.authority, spawn: { ...compiled.authority.spawn, maxDepth: -1 } },
			}),
		).toThrow(/maxDepth/);
		expect(() =>
			parseCompiledLaunchContract({
				...compiled,
				authority: {
					...compiled.authority,
					requiredRuntimeGuarantees: { ...compiled.authority.requiredRuntimeGuarantees, evalState: "shared" },
				},
			}),
		).toThrow(/evalState/);
	});

	it("round-trips and strictly validates parseLaunchBinding", () => {
		const compiled = createTestCompiledContract();
		const binding = activeBinding(compiled);
		expect(parseLaunchBinding(reserialize(binding))).toEqual(binding);
		expect(Object.isFrozen(parseLaunchBinding(reserialize(binding)))).toBe(true);

		expect(() => parseLaunchBinding({ ...binding, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseLaunchBinding({ ...binding, schemaVersion: 2 })).toThrow(/schemaVersion must be 1/);
		expect(() => parseLaunchBinding({ ...binding, state: "mostly-active" })).toThrow(/state/);
		expect(() => parseLaunchBinding({ ...binding, contractDigest: "nope" })).toThrow(/contractDigest/);
		expect(() => parseLaunchBinding({ ...binding, policyEpoch: 1.5 })).toThrow(/policyEpoch/);
		expect(() => parseLaunchBinding({ ...binding, contextGeneration: -1 })).toThrow(/contextGeneration/);
		expect(() => parseLaunchBinding({ ...binding, sessionId: "" })).toThrow(/sessionId/);
		expect(() => parseLaunchBinding({ ...binding, lifecycle: { ...binding.lifecycle, jobId: null } })).toThrow(
			/jobId/,
		);

		// Absent is not null: a missing reservation must not read as "no reservation".
		const { reservationId: _reservationId, ...missingReservation } = binding;
		expect(() => parseLaunchBinding(missingReservation)).toThrow(/reservationId/);

		// An unclaimed binding legitimately has no lifecycle block or guarantees.
		const authorized = durableBinding(compiled, { lifecycle: null });
		expect(parseLaunchBinding(reserialize(authorized))).toEqual(authorized);

		expect(() => parseLaunchBinding(null)).toThrow();
		expect(() => parseLaunchBinding([])).toThrow();
	});

	it("round-trips and strictly validates parseMutationContractV1", () => {
		const mutation = createTestMutationContract();
		expect(parseMutationContractV1(JSON.parse(JSON.stringify(mutation)))).toEqual(mutation);

		expect(() => parseMutationContractV1({ ...mutation, extra: 1 })).toThrow(/unknown_authority_field/);
		expect(() => parseMutationContractV1({ ...mutation, schemaVersion: 2 })).toThrow(/unknown_version/);
		// An omitted flag must never default to a permission.
		const { allowPush: _allowPush, ...missingFlag } = mutation;
		expect(() => parseMutationContractV1(missingFlag)).toThrow(/invalid_mutation_contract/);
		expect(() => parseMutationContractV1({ ...mutation, allowCommit: "yes" })).toThrow(/invalid_mutation_contract/);
		expect(() => parseMutationContractV1({ ...mutation, approvalRef: "" })).toThrow(/invalid_mutation_contract/);
		expect(() => parseMutationContractV1(null)).toThrow();
	});

	it("round-trips and strictly validates parseLaunchAuthorityRefV1", () => {
		const ref = authorityRef();
		expect(parseLaunchAuthorityRefV1(JSON.parse(JSON.stringify(ref)))).toEqual(ref);

		expect(() => parseLaunchAuthorityRefV1({ ...ref, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseLaunchAuthorityRefV1({ ...ref, contractRevision: 0 })).toThrow(/contractRevision/);
		expect(() => parseLaunchAuthorityRefV1({ ...ref, contractDigest: "nope" })).toThrow(/contractDigest/);
		expect(() => parseLaunchAuthorityRefV1({ ...ref, policyEpoch: -1 })).toThrow(/policyEpoch/);
		const { bindingId: _bindingId, ...missingBinding } = ref;
		expect(() => parseLaunchAuthorityRefV1(missingBinding)).toThrow(/bindingId/);
		expect(() => parseLaunchAuthorityRefV1(null)).toThrow();
	});
});

describe("Lifecycle wire records", () => {
	it("strictly validates LifecycleFence, LifecycleHandoff, and ObligationV1", () => {
		const fence = parseLifecycleFence({
			runId: "r1",
			nodeId: "n1",
			attemptId: "a1",
			leaseOwner: "owner1",
			leaseEpoch: 1,
			cancellationGeneration: 0,
			launchAuthority: authorityRef(),
		});
		expect(fence.runId).toBe("r1");
		expect(fence.launchAuthority.bindingId).toBe("binding-1");

		expect(() =>
			parseLifecycleFence({
				runId: "",
				nodeId: "n1",
				attemptId: "a1",
				leaseOwner: "owner1",
				leaseEpoch: 1,
				cancellationGeneration: 0,
				launchAuthority: authorityRef(),
			}),
		).toThrow();

		// The precursor `contractVersion` is no longer part of the fence and
		// must not be accepted as an unknown extra.
		expect(() => parseLifecycleFence({ ...fence, contractVersion: 1 })).toThrow();
		// A fence must not carry another attempt's authority.
		expect(() => parseLifecycleFence({ ...fence, launchAuthority: authorityRef({ attemptId: "a2" }) })).toThrow(
			/does not fence attempt/,
		);
		const { launchAuthority: _launchAuthority, ...missingAuthority } = fence;
		expect(() => parseLifecycleFence(missingAuthority)).toThrow();

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
		expect(handoff.fence.launchAuthority.contractDigest).toBe(DUMMY_HASH_1);

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
