/**
 * W1 freeze: serialization round-trips for every frozen lifecycle wire shape.
 *
 * Each shape must survive `JSON.parse(JSON.stringify(x))` unchanged, and each
 * parser must REJECT rather than coerce when a field is missing, wrongly
 * typed, unknown, version-invalid, non-integral, or hash-tampered. These are
 * the cases where a lenient parser silently manufactures evidence: a coerced
 * `"undefined"` hash, a `NaN` counter, or an unrecognised enum cast through
 * `as` all produce records that look authoritative and are not.
 */

import { describe, expect, it } from "bun:test";
import type {
	DeliveryEventV1,
	DeliveryRecordV1,
	LifecycleAttemptSnapshot,
	LifecycleNodeSnapshot,
	LifecycleRunSnapshot,
	RecoveryCapsuleV1,
} from "../../src/operational/lifecycle-types";
import {
	parseDeliveryEventV1,
	parseDeliveryRecordV1,
	parseLifecycleAttemptSnapshot,
	parseLifecycleDependencySnapshot,
	parseLifecycleNodeSnapshot,
	parseLifecycleRunSnapshot,
	parseRecoveryCapsuleV1,
} from "../../src/operational/lifecycle-types";
import {
	computeProjectionManifestHash,
	type ProjectionManifest,
	parseProjectionManifest,
} from "../../src/orchestration/context-projector";
import { parseHarnessManifestV1 } from "../../src/orchestration/harness-manifest";
import { parseVerificationReceiptV1 } from "../../src/orchestration/snapshot-completion";
import type {
	AuthorityEnvelopeV1,
	CompiledLaunchContract,
	GrantEventV1,
	LaunchAuthorityRefV1,
	LaunchAuthorizationSnapshotV1,
	LaunchBinding,
	LifecycleFence,
	LifecycleHandoffV1,
	MutationContractV1,
	ObligationV1,
} from "../../src/task/launch-contract";
import {
	bindLaunchContract,
	parseArtifactRefV1,
	parseAuthorityEnvelopeV1,
	parseCompiledLaunchContract,
	parseGrantEventV1,
	parseLaunchAuthorityRefV1,
	parseLaunchAuthorizationSnapshotV1,
	parseLaunchBinding,
	parseLaunchContract,
	parseLifecycleFence,
	parseLifecycleHandoff,
	parseMutationContractV1,
	parseObligationV1,
	parseReservationVector,
	parseRunLimitsV1,
	parseSnapshotRefV1,
} from "../../src/task/launch-contract";
import type { PublicationReceipt } from "../../src/task/lifecycle-publisher";
import { parsePublicationReceipt } from "../../src/task/lifecycle-publisher";
import {
	createTestArtifactRef,
	createTestAuthorizationSnapshot,
	createTestCompiledContract,
	createTestEnvelope,
	createTestHarnessManifest,
	createTestMutationContract,
	createTestRunLimits,
	createTestRuntimeGuarantees,
	createTestSnapshotRef,
	createTestVerificationReceipt,
	DUMMY_HASH_1,
	DUMMY_HASH_2,
} from "../helpers/lifecycle-fixtures";

/** Serialize then reparse, proving the shape survives a real storage trip. */
function roundTrip<T>(value: T, parse: (raw: unknown) => T): T {
	return parse(JSON.parse(JSON.stringify(value)));
}

const COMPILED: CompiledLaunchContract = createTestCompiledContract();

const AUTHORITY_REF: LaunchAuthorityRefV1 = Object.freeze({
	bindingId: "binding-1",
	principalId: COMPILED.childPrincipalId,
	attemptId: "att-1",
	contractId: COMPILED.contractId,
	contractRevision: COMPILED.contractRevision,
	contractDigest: COMPILED.contractDigest,
	policyEpoch: 1,
});

/** The durable record the store returns for `COMPILED`. */
const BINDING: LaunchBinding = Object.freeze({
	schemaVersion: 1,
	bindingId: AUTHORITY_REF.bindingId,
	contractId: COMPILED.contractId,
	contractRevision: COMPILED.contractRevision,
	contractDigest: COMPILED.contractDigest,
	rootPrincipalId: COMPILED.rootPrincipalId,
	parentPrincipalId: COMPILED.parentPrincipalId,
	childPrincipalId: COMPILED.childPrincipalId,
	attemptId: "att-1",
	sessionId: null,
	processRef: null,
	policyEpoch: 1,
	contextGeneration: 0,
	state: "active",
	grantBindings: Object.freeze([{ intentId: "intent-1", grantId: "grant-1", recordDigest: DUMMY_HASH_1 }]),
	serviceBindings: Object.freeze([
		{ kind: "workspace" as const, adapterId: "git-worktree", namespace: "repo:main", guarantee: "contained" },
	]),
	actualRuntimeGuarantees: createTestRuntimeGuarantees(),
	guaranteeEvidenceRefs: Object.freeze([createTestArtifactRef("probe-1")]),
	reservationId: "reservation-1",
	lifecycle: Object.freeze({
		runId: "run-1",
		nodeId: "node-1",
		ownerNodeId: null,
		jobId: "job-1",
		leaseEpoch: 1,
		cancellationGeneration: 0,
	}),
	expiresAt: null,
	restoresBindingId: null,
});

const ENVELOPE: AuthorityEnvelopeV1 = createTestEnvelope();

const AUTHORIZATION_SNAPSHOT: LaunchAuthorizationSnapshotV1 = createTestAuthorizationSnapshot();

const GRANT_EVENT: GrantEventV1 = Object.freeze({
	eventId: "grant-evt-1",
	grantId: "grant-1",
	kind: "issued",
	actorPrincipalId: "principal-parent",
	policyEpoch: 1,
	reason: "granting worker scope",
	recordDigest: DUMMY_HASH_1,
	occurredAt: 1000,
});

const DELIVERY_RECORD: DeliveryRecordV1 = Object.freeze({
	schemaVersion: 1,
	deliveryId: "deliv-1",
	channelId: "chan-1",
	senderPrincipalId: "principal-parent",
	recipientPrincipalId: "principal-child",
	recipientBindingId: "binding-1",
	attemptId: "att-1",
	contractRevision: 1,
	policyEpoch: 1,
	contextGeneration: 0,
	payloadRef: createTestArtifactRef("payload-1"),
	resourceRefs: Object.freeze([
		Object.freeze({
			kind: "workspace",
			resourceId: "repo:main",
			versionDigest: null,
			scope: Object.freeze({
				roots: Object.freeze(["src/"]),
				exactIds: Object.freeze([]),
				maxBytes: null,
				range: null,
			}),
		}),
	]),
	domains: Object.freeze(["public-task"] as const),
	kind: "assignment",
	bytes: 128,
	requestDigest: DUMMY_HASH_1,
});

const DELIVERY_EVENT: DeliveryEventV1 = Object.freeze({
	eventId: "deliv-evt-1",
	deliveryId: "deliv-1",
	kind: "admitted",
	requestId: null,
	code: null,
	occurredAt: 1000,
});

const MUTATION: MutationContractV1 = createTestMutationContract();

const FENCE: LifecycleFence = Object.freeze({
	runId: "run-1",
	nodeId: "node-1",
	attemptId: "att-1",
	leaseOwner: "owner-1",
	leaseEpoch: 1,
	cancellationGeneration: 0,
	launchAuthority: AUTHORITY_REF,
});

const OBLIGATION: ObligationV1 = Object.freeze({
	schemaVersion: 1,
	obligationId: "obl-1",
	runId: "run-1",
	nodeId: "node-1",
	criterionId: "crit-1",
	kind: "mandatory_criterion",
	state: "open",
	evidenceReceiptIds: Object.freeze([]),
	waiverAuthorizationRef: null,
	version: 1,
});

const HANDOFF: LifecycleHandoffV1 = Object.freeze({
	schemaVersion: 1,
	kind: "settled",
	eventId: "settled:att-1",
	fence: FENCE,
	ownerNodeId: "node-0",
	targetNodeId: null,
	correlationId: null,
	missionHash: DUMMY_HASH_1,
	baseline: createTestSnapshotRef(),
	outcome: "completed",
	summary: "done",
	manifest: null,
	evidenceRefs: Object.freeze([]),
	observedExitCode: 0,
	changedPaths: Object.freeze([]),
	obligationIds: Object.freeze([]),
	proposedNextAction: null,
});

const NODE_SNAPSHOT: LifecycleNodeSnapshot = Object.freeze({
	nodeId: "node-1",
	ownerNodeId: null,
	depth: 0,
	role: "root-planner",
	currentAttemptId: null,
	sessionId: null,
	sessionGeneration: 0,
	plannerActivity: "ready",
});

const ATTEMPT_SNAPSHOT: LifecycleAttemptSnapshot = Object.freeze({
	attemptId: "att-1",
	nodeId: "node-1",
	jobId: "job-1",
	fence: FENCE,
	execution: "queued",
	capture: "pending",
	delivery: "pending",
	publication: "not-requested",
	verification: "not-required",
	manifestRef: null,
});

const PUBLICATION_RECEIPT: PublicationReceipt = Object.freeze({
	schemaVersion: 1,
	publicationId: "pub-1",
	state: "pending",
	candidate: createTestSnapshotRef(),
	mutatedRepositories: Object.freeze([]),
	changesApplied: false,
	recoveryRefs: Object.freeze([]),
	obligationIds: Object.freeze([]),
});

const RUN_SNAPSHOT: LifecycleRunSnapshot = Object.freeze({
	schemaVersion: 1,
	runId: "run-1",
	rootNodeId: "node-1",
	outcome: "active",
	planVersion: 1,
	cancellationGeneration: 0,
	limits: createTestRunLimits(),
	consumed: { requests: 0, runtimeMs: 0, tokens: null, costMicrounits: null },
	reserved: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
	nodes: Object.freeze([NODE_SNAPSHOT]),
	attempts: Object.freeze([ATTEMPT_SNAPSHOT]),
	dependencies: Object.freeze([{ nodeId: "node-1", prerequisiteId: "node-0" }]),
	obligations: Object.freeze([OBLIGATION]),
	publicationReceipts: Object.freeze([PUBLICATION_RECEIPT]),
	verificationReceipts: Object.freeze([createTestVerificationReceipt()]),
	pendingInboxEventIds: Object.freeze(["evt-1"]),
	projectionManifestRefs: Object.freeze(["proj-1"]),
});

const RECOVERY_CAPSULE: RecoveryCapsuleV1 = Object.freeze({
	schemaVersion: 1,
	runId: "run-1",
	nodeId: "node-1",
	attemptId: "att-1",
	contractHash: DUMMY_HASH_1,
	policyHash: DUMMY_HASH_2,
	harnessHash: DUMMY_HASH_1,
	baseline: createTestSnapshotRef(),
	candidate: null,
	manifest: null,
	workingStateRefs: Object.freeze([]),
	unresolvedObligations: Object.freeze([OBLIGATION]),
	remainingReservation: { requests: 1, runtimeMs: 500, tokens: 100, costMicrounits: 250 },
	fence: FENCE,
});

function validProjectionManifest(): ProjectionManifest {
	const base = {
		schemaVersion: 1 as const,
		launchHash: DUMMY_HASH_1,
		policyHash: DUMMY_HASH_2,
		harnessHash: DUMMY_HASH_1,
		grantGeneration: 0,
		phase: "launch" as const,
		admitted: Object.freeze([{ fragmentId: "frag-1", sourceHash: DUMMY_HASH_1 }]),
		rejected: Object.freeze([{ fragmentId: "frag-2", code: "untrusted_context" }]),
		tools: Object.freeze([{ source: "builtin" as const, name: "read", schemaHash: DUMMY_HASH_2 }]),
	};
	return Object.freeze({ ...base, manifestHash: computeProjectionManifestHash(base) });
}

describe("Frozen lifecycle wire shapes round-trip", () => {
	it("preserves every shape across serialize and reparse", () => {
		expect(roundTrip(createTestSnapshotRef(), parseSnapshotRefV1)).toEqual(createTestSnapshotRef());
		expect(roundTrip(createTestArtifactRef(), parseArtifactRefV1)).toEqual(createTestArtifactRef());
		expect(roundTrip(createTestRunLimits(), parseRunLimitsV1)).toEqual(createTestRunLimits());
		expect(roundTrip(RECOVERY_CAPSULE.remainingReservation, parseReservationVector)).toEqual(
			RECOVERY_CAPSULE.remainingReservation,
		);
		expect(roundTrip(FENCE, parseLifecycleFence)).toEqual(FENCE);
		expect(roundTrip(OBLIGATION, parseObligationV1)).toEqual(OBLIGATION);
		expect(roundTrip(HANDOFF, parseLifecycleHandoff)).toEqual(HANDOFF);
		expect(roundTrip(NODE_SNAPSHOT, parseLifecycleNodeSnapshot)).toEqual(NODE_SNAPSHOT);
		expect(roundTrip(ATTEMPT_SNAPSHOT, parseLifecycleAttemptSnapshot)).toEqual(ATTEMPT_SNAPSHOT);
		expect(roundTrip({ nodeId: "node-1", prerequisiteId: "node-0" }, parseLifecycleDependencySnapshot)).toEqual({
			nodeId: "node-1",
			prerequisiteId: "node-0",
		});
		expect(roundTrip(PUBLICATION_RECEIPT, parsePublicationReceipt)).toEqual(PUBLICATION_RECEIPT);
		expect(roundTrip(createTestVerificationReceipt(), parseVerificationReceiptV1)).toEqual(
			createTestVerificationReceipt(),
		);
		expect(roundTrip(RUN_SNAPSHOT, parseLifecycleRunSnapshot)).toEqual(RUN_SNAPSHOT);
		expect(roundTrip(RECOVERY_CAPSULE, parseRecoveryCapsuleV1)).toEqual(RECOVERY_CAPSULE);
		expect(roundTrip(validProjectionManifest(), parseProjectionManifest)).toEqual(validProjectionManifest());
		expect(roundTrip(createTestHarnessManifest(), parseHarnessManifestV1)).toEqual(createTestHarnessManifest());

		expect(roundTrip(MUTATION, parseMutationContractV1)).toEqual(MUTATION);
		expect(roundTrip(AUTHORITY_REF, parseLaunchAuthorityRefV1)).toEqual(AUTHORITY_REF);
		expect(roundTrip(COMPILED, parseCompiledLaunchContract)).toEqual(COMPILED);
		expect(roundTrip(BINDING, parseLaunchBinding)).toEqual(BINDING);

		// Produced by the real binder rather than hand-assembled, so the test
		// cannot drift from the shape the runtime actually emits.
		const launch = bindLaunchContract(COMPILED, BINDING);
		expect(launch.schemaVersion).toBe(2);
		expect(roundTrip(launch, parseLaunchContract)).toEqual(launch);

		expect(roundTrip(ENVELOPE, parseAuthorityEnvelopeV1)).toEqual(ENVELOPE);
		expect(roundTrip(AUTHORIZATION_SNAPSHOT, parseLaunchAuthorizationSnapshotV1)).toEqual(AUTHORIZATION_SNAPSHOT);
		expect(roundTrip(GRANT_EVENT, parseGrantEventV1)).toEqual(GRANT_EVENT);
		expect(roundTrip(DELIVERY_RECORD, parseDeliveryRecordV1)).toEqual(DELIVERY_RECORD);
		expect(roundTrip(DELIVERY_EVENT, parseDeliveryEventV1)).toEqual(DELIVERY_EVENT);
	});
	it("rejects an unknown schemaVersion instead of accepting a future record", () => {
		for (const [label, parse, valid] of [
			["fence", parseLifecycleFence, FENCE],
			["obligation", parseObligationV1, OBLIGATION],
			["run snapshot", parseLifecycleRunSnapshot, RUN_SNAPSHOT],
			["recovery capsule", parseRecoveryCapsuleV1, RECOVERY_CAPSULE],
			["publication receipt", parsePublicationReceipt, PUBLICATION_RECEIPT],
			["verification receipt", parseVerificationReceiptV1, createTestVerificationReceipt()],
			["projection manifest", parseProjectionManifest, validProjectionManifest()],
			["harness manifest", parseHarnessManifestV1, createTestHarnessManifest()],
		] as const) {
			// The fence is the one shape with no schemaVersion field; skip it.
			if (label === "fence") continue;
			expect(() => parse({ ...valid, schemaVersion: 2 } as unknown as never), label).toThrow();
		}
		// The compiled contract is v2 and its binding is v1; neither may read a
		// future record as if it were the current one.
		expect(() => parseCompiledLaunchContract({ ...COMPILED, schemaVersion: 3 })).toThrow(/schemaVersion/);
		expect(() => parseLaunchBinding({ ...BINDING, schemaVersion: 2 })).toThrow(/schemaVersion/);
		expect(() => parseMutationContractV1({ ...MUTATION, schemaVersion: 2 })).toThrow(/unknown_version/);
		expect(() => parseLaunchContract({ ...bindLaunchContract(COMPILED, BINDING), schemaVersion: 3 })).toThrow(
			/unknown version/,
		);
		expect(() => parseAuthorityEnvelopeV1({ ...ENVELOPE, schemaVersion: 2 })).toThrow(/schemaVersion/);
		expect(() => parseLaunchAuthorizationSnapshotV1({ ...AUTHORIZATION_SNAPSHOT, schemaVersion: 2 })).toThrow(
			/schemaVersion/,
		);
		expect(() => parseDeliveryRecordV1({ ...DELIVERY_RECORD, schemaVersion: 2 })).toThrow(/schemaVersion/);
	});

	it("rejects unknown extra fields rather than dropping them silently", () => {
		expect(() => parseLifecycleFence({ ...FENCE, extra: 1 })).toThrow();
		expect(() => parseObligationV1({ ...OBLIGATION, extra: 1 })).toThrow();
		expect(() => parseLifecycleRunSnapshot({ ...RUN_SNAPSHOT, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseRecoveryCapsuleV1({ ...RECOVERY_CAPSULE, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseLifecycleNodeSnapshot({ ...NODE_SNAPSHOT, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseLifecycleAttemptSnapshot({ ...ATTEMPT_SNAPSHOT, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parsePublicationReceipt({ ...PUBLICATION_RECEIPT, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseVerificationReceiptV1({ ...createTestVerificationReceipt(), extra: 1 })).toThrow(
			/unknown field/,
		);
		expect(() => parseProjectionManifest({ ...validProjectionManifest(), extra: 1 })).toThrow(/unknown field/);
		expect(() => parseHarnessManifestV1({ ...createTestHarnessManifest(), extra: 1 })).toThrow(/unknown field/);
		expect(() => parseMutationContractV1({ ...MUTATION, extra: 1 })).toThrow(/unknown_authority_field/);
		expect(() => parseLaunchAuthorityRefV1({ ...AUTHORITY_REF, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseCompiledLaunchContract({ ...COMPILED, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseLaunchBinding({ ...BINDING, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseAuthorityEnvelopeV1({ ...ENVELOPE, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseLaunchAuthorizationSnapshotV1({ ...AUTHORIZATION_SNAPSHOT, extra: 1 })).toThrow(
			/unknown_field/,
		);
		expect(() => parseGrantEventV1({ ...GRANT_EVENT, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseDeliveryRecordV1({ ...DELIVERY_RECORD, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseDeliveryEventV1({ ...DELIVERY_EVENT, extra: 1 })).toThrow(/unknown_field/);
	});

	it("rejects missing required fields instead of coercing them to defaults", () => {
		const { runId: _runId, ...fenceMissingRun } = FENCE;
		expect(() => parseLifecycleFence(fenceMissingRun)).toThrow();

		const { rootNodeId: _root, ...snapshotMissingRoot } = RUN_SNAPSHOT;
		// String(undefined) would have produced the literal "undefined" here.
		expect(() => parseLifecycleRunSnapshot(snapshotMissingRoot)).toThrow(/rootNodeId/);

		const { startedAt: _started, ...receiptMissingStart } = createTestVerificationReceipt();
		// Number(undefined) would have produced NaN here.
		expect(() => parseVerificationReceiptV1(receiptMissingStart)).toThrow(/startedAt/);

		const { launchHash: _launch, ...manifestMissingLaunch } = validProjectionManifest();
		expect(() => parseProjectionManifest(manifestMissingLaunch)).toThrow(/launchHash/);

		const { returnSchemaRef: _schema, ...harnessMissingSchema } = createTestHarnessManifest();
		// This previously defaulted to "schema://none", substituting current
		// behaviour for the pinned contract.
		expect(() => parseHarnessManifestV1(harnessMissingSchema)).toThrow(/returnSchemaRef/);

		const { attemptId: _attemptId, ...refMissingAttempt } = AUTHORITY_REF;
		expect(() => parseLaunchAuthorityRefV1(refMissingAttempt)).toThrow(/attemptId/);

		const { childPrincipalId: _child, ...bindingMissingChild } = BINDING;
		expect(() => parseLaunchBinding(bindingMissingChild)).toThrow(/childPrincipalId/);

		const { authority: _authority, ...compiledMissingAuthority } = COMPILED;
		expect(() => parseCompiledLaunchContract(compiledMissingAuthority)).toThrow(/authority/);

		const { budget: _budget, ...envelopeMissingBudget } = ENVELOPE;
		expect(() => parseAuthorityEnvelopeV1(envelopeMissingBudget)).toThrow(/budget/);

		const { reason: _reason, ...authzMissingReason } = AUTHORIZATION_SNAPSHOT;
		expect(() => parseLaunchAuthorizationSnapshotV1(authzMissingReason)).toThrow(/reason/);

		const { grantId: _grantId, ...grantEventMissingId } = GRANT_EVENT;
		expect(() => parseGrantEventV1(grantEventMissingId)).toThrow(/grantId/);

		const { deliveryId: _delivId, ...delivRecMissingId } = DELIVERY_RECORD;
		expect(() => parseDeliveryRecordV1(delivRecMissingId)).toThrow(/deliveryId/);

		const { kind: _delivKind, ...delivEventMissingKind } = DELIVERY_EVENT;
		expect(() => parseDeliveryEventV1(delivEventMissingKind)).toThrow(/kind/);
	});

	it("rejects wrongly typed and non-integral numeric fields", () => {
		expect(() => parseLifecycleFence({ ...FENCE, leaseEpoch: "1" })).toThrow();
		expect(() => parseLifecycleFence({ ...FENCE, leaseEpoch: 1.5 })).toThrow();
		expect(() => parseLifecycleFence({ ...FENCE, leaseEpoch: -1 })).toThrow();
		expect(() => parseLifecycleFence({ ...FENCE, leaseEpoch: Number.NaN })).toThrow();
		expect(() => parseLifecycleFence({ ...FENCE, leaseEpoch: Number.POSITIVE_INFINITY })).toThrow();

		expect(() => parseLifecycleRunSnapshot({ ...RUN_SNAPSHOT, planVersion: "1" })).toThrow();
		expect(() => parseLifecycleRunSnapshot({ ...RUN_SNAPSHOT, nodes: "not-an-array" })).toThrow();
		expect(() => parseVerificationReceiptV1({ ...createTestVerificationReceipt(), exitCode: 1.5 })).toThrow();
		expect(() => parseProjectionManifest({ ...validProjectionManifest(), grantGeneration: -1 })).toThrow();
		expect(() =>
			parseHarnessManifestV1({
				...createTestHarnessManifest(),
				skillPolicy: { mode: "none", allowNames: [], maxSkills: -1 },
			}),
		).toThrow();
		expect(() => parseLaunchAuthorityRefV1({ ...AUTHORITY_REF, policyEpoch: 1.5 })).toThrow(/policyEpoch/);
		expect(() => parseLaunchBinding({ ...BINDING, contextGeneration: Number.NaN })).toThrow(/contextGeneration/);
		expect(() => parseCompiledLaunchContract({ ...COMPILED, contractRevision: 0 })).toThrow(/contractRevision/);
		expect(() => parseLaunchAuthorizationSnapshotV1({ ...AUTHORIZATION_SNAPSHOT, contractRevision: 0 })).toThrow(
			/contractRevision/,
		);
		expect(() => parseLaunchAuthorizationSnapshotV1({ ...AUTHORIZATION_SNAPSHOT, issuerPolicyEpoch: 1.5 })).toThrow(
			/issuerPolicyEpoch/,
		);
		expect(() => parseGrantEventV1({ ...GRANT_EVENT, policyEpoch: -1 })).toThrow(/policyEpoch/);
		expect(() => parseGrantEventV1({ ...GRANT_EVENT, occurredAt: 1.5 })).toThrow(/occurredAt/);
		expect(() => parseDeliveryRecordV1({ ...DELIVERY_RECORD, contractRevision: 0 })).toThrow(/contractRevision/);
		expect(() => parseDeliveryRecordV1({ ...DELIVERY_RECORD, bytes: -1 })).toThrow(/bytes/);
		expect(() => parseDeliveryRecordV1({ ...DELIVERY_RECORD, bytes: 1.5 })).toThrow(/bytes/);
		expect(() => parseDeliveryEventV1({ ...DELIVERY_EVENT, occurredAt: -1 })).toThrow(/occurredAt/);
		expect(() => parseDeliveryEventV1({ ...DELIVERY_EVENT, occurredAt: 1.5 })).toThrow(/occurredAt/);
	});

	it("rejects unknown enum values rather than casting them through", () => {
		expect(() => parseLifecycleNodeSnapshot({ ...NODE_SNAPSHOT, role: "overlord" })).toThrow(/role/);
		expect(() => parseLifecycleNodeSnapshot({ ...NODE_SNAPSHOT, plannerActivity: "vibing" })).toThrow(
			/plannerActivity/,
		);
		expect(() => parseLifecycleAttemptSnapshot({ ...ATTEMPT_SNAPSHOT, execution: "almost-done" })).toThrow(
			/execution/,
		);
		expect(() => parseLifecycleRunSnapshot({ ...RUN_SNAPSHOT, outcome: "probably-fine" })).toThrow(/outcome/);
		expect(() => parsePublicationReceipt({ ...PUBLICATION_RECEIPT, state: "mostly-integrated" })).toThrow(/state/);
		expect(() => parseProjectionManifest({ ...validProjectionManifest(), phase: "whenever" })).toThrow(/phase/);
		expect(() => parseHarnessManifestV1({ ...createTestHarnessManifest(), kind: "enormous" })).toThrow(/kind/);
		expect(() => parseVerificationReceiptV1({ ...createTestVerificationReceipt(), outcome: "probably" })).toThrow(
			/outcome/,
		);
		expect(() => parseLaunchBinding({ ...BINDING, state: "half-bound" })).toThrow(/state/);
		expect(() =>
			parseLaunchBinding({
				...BINDING,
				actualRuntimeGuarantees: { ...createTestRuntimeGuarantees(), network: "open" },
			}),
		).toThrow(/network/);
		expect(() => parseGrantEventV1({ ...GRANT_EVENT, kind: "settled" as unknown as never })).toThrow(/kind/);
		expect(() => parseDeliveryEventV1({ ...DELIVERY_EVENT, kind: "flying" as unknown as never })).toThrow(/kind/);
		expect(() => parseDeliveryRecordV1({ ...DELIVERY_RECORD, kind: "chat" as unknown as never })).toThrow(/kind/);
	});

	it("rejects tampered content hashes", () => {
		expect(() => parseProjectionManifest({ ...validProjectionManifest(), manifestHash: DUMMY_HASH_2 })).toThrow(
			/does not match content/,
		);
		// Changing hashed content without recomputing the digest must also fail.
		expect(() => parseProjectionManifest({ ...validProjectionManifest(), grantGeneration: 7 })).toThrow(
			/does not match content/,
		);
		expect(() => parseHarnessManifestV1({ ...createTestHarnessManifest(), manifestHash: DUMMY_HASH_2 })).toThrow(
			/does not match content/,
		);
		expect(() => parseHarnessManifestV1({ ...createTestHarnessManifest(), profile: "research" })).toThrow(
			/does not match content/,
		);
		// The contract digest covers the whole compiled body, so editing any
		// part of it without recompiling must reject.
		expect(() => parseCompiledLaunchContract({ ...COMPILED, contractDigest: DUMMY_HASH_2 })).toThrow(
			/contract_digest_mismatch/,
		);
		expect(() =>
			parseCompiledLaunchContract({ ...COMPILED, provenance: { ...COMPILED.provenance, reason: "widen me" } }),
		).toThrow(/contract_digest_mismatch/);
		// A durable binding for a different contract cannot be paired with it.
		expect(() => bindLaunchContract(COMPILED, { ...BINDING, contractDigest: DUMMY_HASH_2 })).toThrow(
			/launch_binding_identity_mismatch/,
		);
	});

	it("rejects non-hex digests where a SHA-256 is required", () => {
		expect(() => parseSnapshotRefV1({ ...createTestSnapshotRef(), manifestHash: "nope" })).toThrow();
		expect(() => parseArtifactRefV1({ ...createTestArtifactRef(), sha256: "nope" })).toThrow();
		expect(() => parseRecoveryCapsuleV1({ ...RECOVERY_CAPSULE, contractHash: "nope" })).toThrow(/contractHash/);
		expect(() => parseVerificationReceiptV1({ ...createTestVerificationReceipt(), candidateHash: "nope" })).toThrow(
			/candidateHash/,
		);
		expect(() => parseLaunchAuthorityRefV1({ ...AUTHORITY_REF, contractDigest: "nope" })).toThrow(/contractDigest/);
		expect(() => parseLaunchBinding({ ...BINDING, contractDigest: "nope" })).toThrow(/contractDigest/);
		expect(() => parseGrantEventV1({ ...GRANT_EVENT, recordDigest: "nope" })).toThrow(/recordDigest/);
		expect(() => parseDeliveryRecordV1({ ...DELIVERY_RECORD, requestDigest: "nope" })).toThrow(/requestDigest/);
		expect(() =>
			parseLaunchAuthorizationSnapshotV1({ ...AUTHORIZATION_SNAPSHOT, toolCatalogDigest: "nope" }),
		).toThrow(/toolCatalogDigest/);
		expect(() =>
			parseLaunchAuthorizationSnapshotV1({ ...AUTHORIZATION_SNAPSHOT, priorContractDigest: "nope" }),
		).toThrow(/priorContractDigest/);
	});

	it("keeps null and absent distinct for nullable fields", () => {
		// null fence means "admitted but unclaimed" and must round-trip as null.
		const unclaimed = { ...ATTEMPT_SNAPSHOT, fence: null };
		expect(roundTrip(unclaimed, parseLifecycleAttemptSnapshot).fence).toBeNull();

		// Absent is not the same as null and must reject.
		const { fence: _fence, ...missingFence } = ATTEMPT_SNAPSHOT;
		expect(() => parseLifecycleAttemptSnapshot(missingFence)).toThrow(/fence/);

		const { candidate: _candidate, ...missingCandidate } = RECOVERY_CAPSULE;
		expect(() => parseRecoveryCapsuleV1(missingCandidate)).toThrow(/candidate/);

		// A binding with no scheduler job and no measured probes is a valid
		// `authorized` row; an absent lifecycle key is not the same as null.
		const unbound = { ...BINDING, state: "authorized" as const, lifecycle: null };
		expect(roundTrip(unbound, parseLaunchBinding).lifecycle).toBeNull();
		const { lifecycle: _lifecycle, ...missingLifecycle } = BINDING;
		expect(() => parseLaunchBinding(missingLifecycle)).toThrow(/lifecycle/);

		// A reservation dimension of null (no bound) differs from 0 (no budget).
		const zeroed = roundTrip({ requests: 0, runtimeMs: 0, tokens: 0, costMicrounits: 0 }, parseReservationVector);
		expect(zeroed.tokens).toBe(0);
		const unbounded = roundTrip(
			{ requests: 0, runtimeMs: 0, tokens: null, costMicrounits: null },
			parseReservationVector,
		);
		expect(unbounded.tokens).toBeNull();
	});

	it("rejects a receipt whose finish precedes its start", () => {
		expect(() =>
			parseVerificationReceiptV1({ ...createTestVerificationReceipt(), startedAt: 2000, finishedAt: 1000 }),
		).toThrow(/finishedAt/);
	});

	it("rejects non-object and array inputs at every parser", () => {
		for (const parse of [
			parseLifecycleFence,
			parseObligationV1,
			parseLifecycleRunSnapshot,
			parseRecoveryCapsuleV1,
			parsePublicationReceipt,
			parseVerificationReceiptV1,
			parseProjectionManifest,
			parseHarnessManifestV1,
			parseLifecycleNodeSnapshot,
			parseLifecycleAttemptSnapshot,
			parseLaunchAuthorityRefV1,
			parseCompiledLaunchContract,
			parseLaunchBinding,
			parseLaunchContract,
			parseMutationContractV1,
			parseAuthorityEnvelopeV1,
			parseLaunchAuthorizationSnapshotV1,
			parseGrantEventV1,
			parseDeliveryRecordV1,
			parseDeliveryEventV1,
		]) {
			expect(() => parse(null)).toThrow();
			expect(() => parse([])).toThrow();
			expect(() => parse("string")).toThrow();
		}
	});
});
