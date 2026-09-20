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
	LifecycleAttemptSnapshot,
	LifecycleNodeSnapshot,
	LifecycleRunSnapshot,
	RecoveryCapsuleV1,
} from "../../src/operational/lifecycle-types";
import {
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
import type { LifecycleFence, LifecycleHandoffV1, ObligationV1 } from "../../src/task/launch-contract";
import {
	bindLaunchContract,
	parseArtifactRefV1,
	parseLaunchContract,
	parseLifecycleFence,
	parseLifecycleHandoff,
	parseObligationV1,
	parseReservationVector,
	parseRunLimitsV1,
	parseSnapshotRefV1,
} from "../../src/task/launch-contract";
import type { PublicationReceipt } from "../../src/task/lifecycle-publisher";
import { parsePublicationReceipt } from "../../src/task/lifecycle-publisher";
import {
	createTestArtifactRef,
	createTestCompiledContract,
	createTestHarnessManifest,
	createTestRunLimits,
	createTestSnapshotRef,
	createTestVerificationReceipt,
	DUMMY_HASH_1,
	DUMMY_HASH_2,
} from "../helpers/lifecycle-fixtures";

/** Serialize then reparse, proving the shape survives a real storage trip. */
function roundTrip<T>(value: T, parse: (raw: unknown) => T): T {
	return parse(JSON.parse(JSON.stringify(value)));
}

const FENCE: LifecycleFence = Object.freeze({
	runId: "run-1",
	nodeId: "node-1",
	attemptId: "att-1",
	leaseOwner: "owner-1",
	leaseEpoch: 1,
	cancellationGeneration: 0,
	contractVersion: 1,
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

		// Produced by the real binder rather than hand-assembled, so the test
		// cannot drift from the shape the runtime actually emits.
		const launch = bindLaunchContract(createTestCompiledContract(), {
			runId: "run-1",
			nodeId: "node-1",
			ownerNodeId: null,
			attemptId: "att-1",
			budgetReservationId: "res-1",
			leaseEpoch: 1,
			cancellationGeneration: 0,
		});
		expect(roundTrip(launch, parseLaunchContract)).toEqual(launch);
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
	});

	it("rejects non-hex digests where a SHA-256 is required", () => {
		expect(() => parseSnapshotRefV1({ ...createTestSnapshotRef(), manifestHash: "nope" })).toThrow();
		expect(() => parseArtifactRefV1({ ...createTestArtifactRef(), sha256: "nope" })).toThrow();
		expect(() => parseRecoveryCapsuleV1({ ...RECOVERY_CAPSULE, contractHash: "nope" })).toThrow(/contractHash/);
		expect(() => parseVerificationReceiptV1({ ...createTestVerificationReceipt(), candidateHash: "nope" })).toThrow(
			/candidateHash/,
		);
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
		]) {
			expect(() => parse(null)).toThrow();
			expect(() => parse([])).toThrow();
			expect(() => parse("string")).toThrow();
		}
	});
});
