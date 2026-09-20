/**
 * Durable graph, budget accounting, delivery, and scheduling types (A06/A07/A08)
 * — frozen W1 contract surface.
 */

import type { LifecycleExecutionContext } from "../orchestration/lifecycle-authority";
import type { VerificationReceiptV1 } from "../orchestration/snapshot-completion";
import { parseVerificationReceiptV1 } from "../orchestration/snapshot-completion";
import type {
	AgentRole,
	ArtifactRefV1,
	CompiledLaunchContract,
	DisclosureDomain,
	DisclosureKind,
	LaunchBinding,
	LaunchContract,
	LaunchContractDiagnostic,
	LifecycleFence,
	LifecycleHandoffV1,
	ObligationV1,
	ReservationVector,
	ResourceOperation,
	ResourceSelectorV1,
	RunLimitsV1,
	RuntimeGuaranteesV1,
	SnapshotRefV1,
} from "../task/launch-contract";
import {
	isHex64,
	isNonEmptyString,
	isPlainObject,
	isSafeNonNegativeInt,
	KNOWN_AGENT_ROLES,
	parseArtifactRefV1,
	parseLifecycleFence,
	parseObligationV1,
	parseReservationVector,
	parseRunLimitsV1,
	parseSnapshotRefV1,
} from "../task/launch-contract";
import type { PublicationReceipt } from "../task/lifecycle-publisher";
import { parsePublicationReceipt } from "../task/lifecycle-publisher";
import type { DurableJob } from "./types";

export type ExecutionDimension =
	| "queued"
	| "provisioning"
	| "running"
	| "stopping"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "timed-out";

export type CaptureDimension = "pending" | "durable" | "partial" | "capture-failed";
export type DeliveryDimension = "pending" | "delivered" | "consumed" | "superseded";
export type PublicationDimension = "not-requested" | "pending" | "integrated" | "conflicted" | "rejected" | "partial";
export type VerificationDimension = "not-required" | "pending" | "passed" | "failed" | "stale";
export type PlannerActivity = "ready" | "planning" | "waiting" | "blocked" | "quiescent";
export type LifecycleRunOutcome = "active" | "completed" | "partial" | "blocked" | "failed" | "cancelled";

export interface LifecycleAdmissionInput {
	readonly runId: string;
	readonly ownerNodeId: string;
	readonly nodeId: string | null;
	readonly idempotencyKey: string;
	readonly compiled: CompiledLaunchContract;
	readonly expectedPlanVersion: number;
	readonly expectedCancellationGeneration: number;
	readonly reservation: ReservationVector;
	readonly prerequisiteIds: readonly string[];
}

export type LifecycleAdmissionResult =
	| { readonly ok: true; readonly launch: LaunchContract; readonly job: DurableJob }
	| { readonly ok: false; readonly code: string; readonly message: string };

export interface LifecycleUsageInput {
	readonly eventId: string;
	readonly fence: LifecycleFence;
	readonly requestId: string;
	readonly provider: string;
	readonly model: string;
	readonly pricingVersion: string | null;
	readonly observed: ReservationVector;
}

export interface LifecycleSettlementInput {
	readonly fence: LifecycleFence;
	readonly idempotencyKey: string;
	readonly handoff: LifecycleHandoffV1;
	readonly execution: "succeeded" | "failed" | "cancelled" | "timed-out";
	readonly captureState: CaptureDimension;
	readonly manifest: ArtifactRefV1 | null;
	readonly observedUsageEventIds: readonly string[];
}

export type LifecycleSettlementResult =
	| { readonly ok: true; readonly status: "settled" | "already_settled" }
	| {
			readonly ok: false;
			readonly code: "fence_stale" | "cancellation_conflict" | "invalid_transition" | "settlement_conflict";
			readonly message: string;
	  };

export interface PlannerTurnInput {
	readonly ownerNodeId: string;
	readonly expectedPlanVersion: number;
	readonly maxEvents: number;
	readonly fence: LifecycleFence;
}

export interface PlannerTurnRecord {
	readonly turnId: string;
	readonly inputEvents: readonly LifecycleHandoffV1[];
	readonly inputHash: string;
}

export type PlannerAction =
	| { readonly kind: "admit-child"; readonly input: LifecycleAdmissionInput }
	| { readonly kind: "add-dependency"; readonly nodeId: string; readonly prerequisiteId: string }
	| { readonly kind: "revise-contract"; readonly compiled: CompiledLaunchContract }
	| {
			readonly kind: "resolve-obligation";
			readonly obligationId: string;
			readonly evidenceReceiptIds: readonly string[];
			readonly waiverAuthorizationRef?: string | null;
	  }
	| { readonly kind: "wait" }
	| { readonly kind: "block"; readonly reason: string };

export interface PlannerTurnCommitInput {
	readonly turnId: string;
	readonly fence: LifecycleFence;
	readonly expectedPlanVersion: number;
	readonly result: ArtifactRefV1;
	readonly actions: readonly PlannerAction[];
}

export type PlannerTurnCommitResult =
	| { readonly ok: true; readonly newPlanVersion: number }
	| { readonly ok: false; readonly code: "version_conflict" | "stale_fence"; readonly message: string };

export interface ObligationTransitionInput {
	readonly obligationId: string;
	readonly expectedVersion: number;
	readonly state: "resolved" | "waived";
	readonly evidenceReceiptIds: readonly string[];
	readonly waiverAuthorizationRef: string | null;
}

export interface LifecycleCancellationInput {
	readonly runId: string;
	readonly expectedCancellationGeneration: number;
	readonly reason: string;
	readonly idempotencyKey: string;
}

export type LifecycleCancellationResult =
	| { readonly ok: true; readonly snapshot: LifecycleRunSnapshot }
	| { readonly ok: false; readonly code: "run_not_found" | "cancellation_conflict"; readonly message: string };

export interface LifecycleNodeSnapshot {
	readonly nodeId: string;
	readonly ownerNodeId: string | null;
	readonly depth: number;
	readonly role: AgentRole;
	readonly currentAttemptId: string | null;
	readonly sessionId: string | null;
	readonly sessionGeneration: number;
	readonly plannerActivity: PlannerActivity;
}

export interface LifecycleAttemptSnapshot {
	readonly attemptId: string;
	readonly nodeId: string;
	readonly jobId: string;
	/**
	 * Write-authentication token for this attempt. `null` when the attempt has
	 * been admitted but no lease owner has claimed it yet: an unclaimed attempt
	 * genuinely has no valid fence, and forging one would hand out a token that
	 * authenticates nothing.
	 */
	readonly fence: LifecycleFence | null;
	readonly execution: ExecutionDimension;
	readonly capture: CaptureDimension;
	readonly delivery: DeliveryDimension;
	readonly publication: PublicationDimension;
	readonly verification: VerificationDimension;
	readonly manifestRef: string | null;
}

export interface LifecycleDependencySnapshot {
	readonly nodeId: string;
	readonly prerequisiteId: string;
}

export interface LifecycleRunSnapshot {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly rootNodeId: string;
	readonly outcome: LifecycleRunOutcome;
	readonly planVersion: number;
	readonly cancellationGeneration: number;
	readonly limits: RunLimitsV1;
	readonly consumed: ReservationVector;
	readonly reserved: ReservationVector;
	readonly nodes: readonly LifecycleNodeSnapshot[];
	readonly attempts: readonly LifecycleAttemptSnapshot[];
	readonly dependencies: readonly LifecycleDependencySnapshot[];
	readonly obligations: readonly ObligationV1[];
	readonly publicationReceipts: readonly PublicationReceipt[];
	readonly verificationReceipts: readonly VerificationReceiptV1[];
	readonly pendingInboxEventIds: readonly string[];
	readonly projectionManifestRefs: readonly string[];
}

export interface RecoveryCapsuleV1 {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly nodeId: string;
	readonly attemptId: string;
	readonly contractHash: string;
	readonly policyHash: string;
	readonly harnessHash: string;
	readonly baseline: SnapshotRefV1;
	readonly candidate: SnapshotRefV1 | null;
	readonly manifest: ArtifactRefV1 | null;
	readonly workingStateRefs: readonly string[];
	readonly unresolvedObligations: readonly ObligationV1[];
	readonly remainingReservation: ReservationVector;
	readonly fence: LifecycleFence;
}

const EXECUTION_DIMENSIONS: readonly ExecutionDimension[] = [
	"queued",
	"provisioning",
	"running",
	"stopping",
	"succeeded",
	"failed",
	"cancelled",
	"timed-out",
];
const CAPTURE_DIMENSIONS: readonly CaptureDimension[] = ["pending", "durable", "partial", "capture-failed"];
const DELIVERY_DIMENSIONS: readonly DeliveryDimension[] = ["pending", "delivered", "consumed", "superseded"];
const PUBLICATION_DIMENSIONS: readonly PublicationDimension[] = [
	"not-requested",
	"pending",
	"integrated",
	"conflicted",
	"rejected",
	"partial",
];
const VERIFICATION_DIMENSIONS: readonly VerificationDimension[] = [
	"not-required",
	"pending",
	"passed",
	"failed",
	"stale",
];
const PLANNER_ACTIVITIES: readonly PlannerActivity[] = ["ready", "planning", "waiting", "blocked", "quiescent"];
const RUN_OUTCOMES: readonly LifecycleRunOutcome[] = [
	"active",
	"completed",
	"partial",
	"blocked",
	"failed",
	"cancelled",
];

/**
 * Strict field readers. Every persisted lifecycle record is parsed through
 * these: absence, wrong type, unknown field and out-of-range values all reject
 * rather than coercing. `String(undefined)` producing `"undefined"` and
 * `Number(null)` producing `0` are exactly the silent corruptions these
 * replace.
 */
function record(value: unknown, label: string): Record<string, unknown> {
	if (!isPlainObject(value)) throw new Error(`invalid_${label}: expected object`);
	return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`unknown_field: ${label}.${key}`);
	}
}

function str(value: Record<string, unknown>, key: string, label: string): string {
	const raw = value[key];
	if (!isNonEmptyString(raw)) throw new Error(`invalid_${label}: ${key} must be a non-empty string`);
	return raw;
}

function nullableStr(value: Record<string, unknown>, key: string, label: string): string | null {
	const raw = value[key];
	if (raw === null) return null;
	if (!isNonEmptyString(raw)) throw new Error(`invalid_${label}: ${key} must be a non-empty string or null`);
	return raw;
}

function int(value: Record<string, unknown>, key: string, label: string): number {
	const raw = value[key];
	if (!isSafeNonNegativeInt(raw)) throw new Error(`invalid_${label}: ${key} must be a safe non-negative integer`);
	return raw;
}

function literal<T extends string>(
	value: Record<string, unknown>,
	key: string,
	allowed: readonly T[],
	label: string,
): T {
	const raw = value[key];
	if (typeof raw !== "string" || !allowed.includes(raw as T)) {
		throw new Error(`invalid_${label}: ${key} must be one of ${allowed.join("|")}`);
	}
	return raw as T;
}

function array(value: Record<string, unknown>, key: string, label: string): readonly unknown[] {
	const raw = value[key];
	if (!Array.isArray(raw)) throw new Error(`invalid_${label}: ${key} must be an array`);
	return raw;
}

function stringArray(value: Record<string, unknown>, key: string, label: string): readonly string[] {
	return Object.freeze(
		array(value, key, label).map((entry, index) => {
			if (!isNonEmptyString(entry)) {
				throw new Error(`invalid_${label}: ${key}[${index}] must be a non-empty string`);
			}
			return entry;
		}),
	);
}

const NODE_SNAPSHOT_KEYS = [
	"nodeId",
	"ownerNodeId",
	"depth",
	"role",
	"currentAttemptId",
	"sessionId",
	"sessionGeneration",
	"plannerActivity",
] as const;

export function parseLifecycleNodeSnapshot(value: unknown): LifecycleNodeSnapshot {
	const node = record(value, "LifecycleNodeSnapshot");
	rejectUnknownKeys(node, NODE_SNAPSHOT_KEYS, "LifecycleNodeSnapshot");
	const role = literal(node, "role", KNOWN_AGENT_ROLES, "LifecycleNodeSnapshot");
	return Object.freeze({
		nodeId: str(node, "nodeId", "LifecycleNodeSnapshot"),
		ownerNodeId: nullableStr(node, "ownerNodeId", "LifecycleNodeSnapshot"),
		depth: int(node, "depth", "LifecycleNodeSnapshot"),
		role,
		currentAttemptId: nullableStr(node, "currentAttemptId", "LifecycleNodeSnapshot"),
		sessionId: nullableStr(node, "sessionId", "LifecycleNodeSnapshot"),
		sessionGeneration: int(node, "sessionGeneration", "LifecycleNodeSnapshot"),
		plannerActivity: literal(node, "plannerActivity", PLANNER_ACTIVITIES, "LifecycleNodeSnapshot"),
	});
}

const ATTEMPT_SNAPSHOT_KEYS = [
	"attemptId",
	"nodeId",
	"jobId",
	"fence",
	"execution",
	"capture",
	"delivery",
	"publication",
	"verification",
	"manifestRef",
] as const;

export function parseLifecycleAttemptSnapshot(value: unknown): LifecycleAttemptSnapshot {
	const attempt = record(value, "LifecycleAttemptSnapshot");
	rejectUnknownKeys(attempt, ATTEMPT_SNAPSHOT_KEYS, "LifecycleAttemptSnapshot");
	const rawFence = attempt.fence;
	if (rawFence === undefined) throw new Error("invalid_LifecycleAttemptSnapshot: fence must be present or null");
	return Object.freeze({
		attemptId: str(attempt, "attemptId", "LifecycleAttemptSnapshot"),
		nodeId: str(attempt, "nodeId", "LifecycleAttemptSnapshot"),
		jobId: str(attempt, "jobId", "LifecycleAttemptSnapshot"),
		fence: rawFence === null ? null : parseLifecycleFence(rawFence),
		execution: literal(attempt, "execution", EXECUTION_DIMENSIONS, "LifecycleAttemptSnapshot"),
		capture: literal(attempt, "capture", CAPTURE_DIMENSIONS, "LifecycleAttemptSnapshot"),
		delivery: literal(attempt, "delivery", DELIVERY_DIMENSIONS, "LifecycleAttemptSnapshot"),
		publication: literal(attempt, "publication", PUBLICATION_DIMENSIONS, "LifecycleAttemptSnapshot"),
		verification: literal(attempt, "verification", VERIFICATION_DIMENSIONS, "LifecycleAttemptSnapshot"),
		manifestRef: nullableStr(attempt, "manifestRef", "LifecycleAttemptSnapshot"),
	});
}

const DEPENDENCY_SNAPSHOT_KEYS = ["nodeId", "prerequisiteId"] as const;

export function parseLifecycleDependencySnapshot(value: unknown): LifecycleDependencySnapshot {
	const dependency = record(value, "LifecycleDependencySnapshot");
	rejectUnknownKeys(dependency, DEPENDENCY_SNAPSHOT_KEYS, "LifecycleDependencySnapshot");
	return Object.freeze({
		nodeId: str(dependency, "nodeId", "LifecycleDependencySnapshot"),
		prerequisiteId: str(dependency, "prerequisiteId", "LifecycleDependencySnapshot"),
	});
}

const RECOVERY_CAPSULE_KEYS = [
	"schemaVersion",
	"runId",
	"nodeId",
	"attemptId",
	"contractHash",
	"policyHash",
	"harnessHash",
	"baseline",
	"candidate",
	"manifest",
	"workingStateRefs",
	"unresolvedObligations",
	"remainingReservation",
	"fence",
] as const;

export function parseRecoveryCapsuleV1(value: unknown): RecoveryCapsuleV1 {
	const capsule = record(value, "RecoveryCapsuleV1");
	rejectUnknownKeys(capsule, RECOVERY_CAPSULE_KEYS, "RecoveryCapsuleV1");
	if (capsule.schemaVersion !== 1) throw new Error("invalid_RecoveryCapsuleV1: schemaVersion must be 1");
	for (const key of ["contractHash", "policyHash", "harnessHash"] as const) {
		if (!isHex64(capsule[key])) throw new Error(`invalid_RecoveryCapsuleV1: ${key} must be a 64-char hex digest`);
	}
	if (capsule.candidate === undefined) throw new Error("invalid_RecoveryCapsuleV1: candidate must be present or null");
	if (capsule.manifest === undefined) throw new Error("invalid_RecoveryCapsuleV1: manifest must be present or null");
	return Object.freeze({
		schemaVersion: 1 as const,
		runId: str(capsule, "runId", "RecoveryCapsuleV1"),
		nodeId: str(capsule, "nodeId", "RecoveryCapsuleV1"),
		attemptId: str(capsule, "attemptId", "RecoveryCapsuleV1"),
		contractHash: capsule.contractHash as string,
		policyHash: capsule.policyHash as string,
		harnessHash: capsule.harnessHash as string,
		baseline: parseSnapshotRefV1(capsule.baseline, "RecoveryCapsuleV1.baseline"),
		candidate:
			capsule.candidate === null ? null : parseSnapshotRefV1(capsule.candidate, "RecoveryCapsuleV1.candidate"),
		manifest: capsule.manifest === null ? null : parseArtifactRefV1(capsule.manifest, "RecoveryCapsuleV1.manifest"),
		workingStateRefs: stringArray(capsule, "workingStateRefs", "RecoveryCapsuleV1"),
		unresolvedObligations: Object.freeze(
			array(capsule, "unresolvedObligations", "RecoveryCapsuleV1").map(entry => parseObligationV1(entry)),
		),
		remainingReservation: parseReservationVector(
			capsule.remainingReservation,
			"RecoveryCapsuleV1.remainingReservation",
		),
		fence: parseLifecycleFence(capsule.fence),
	});
}

const RUN_SNAPSHOT_KEYS = [
	"schemaVersion",
	"runId",
	"rootNodeId",
	"outcome",
	"planVersion",
	"cancellationGeneration",
	"limits",
	"consumed",
	"reserved",
	"nodes",
	"attempts",
	"dependencies",
	"obligations",
	"publicationReceipts",
	"verificationReceipts",
	"pendingInboxEventIds",
	"projectionManifestRefs",
] as const;

export function parseLifecycleRunSnapshot(value: unknown): LifecycleRunSnapshot {
	const snapshot = record(value, "LifecycleRunSnapshot");
	rejectUnknownKeys(snapshot, RUN_SNAPSHOT_KEYS, "LifecycleRunSnapshot");
	if (snapshot.schemaVersion !== 1) throw new Error("invalid_LifecycleRunSnapshot: schemaVersion must be 1");
	return Object.freeze({
		schemaVersion: 1 as const,
		runId: str(snapshot, "runId", "LifecycleRunSnapshot"),
		rootNodeId: str(snapshot, "rootNodeId", "LifecycleRunSnapshot"),
		outcome: literal(snapshot, "outcome", RUN_OUTCOMES, "LifecycleRunSnapshot"),
		planVersion: int(snapshot, "planVersion", "LifecycleRunSnapshot"),
		cancellationGeneration: int(snapshot, "cancellationGeneration", "LifecycleRunSnapshot"),
		limits: parseRunLimitsV1(snapshot.limits, "LifecycleRunSnapshot.limits"),
		consumed: parseReservationVector(snapshot.consumed, "LifecycleRunSnapshot.consumed"),
		reserved: parseReservationVector(snapshot.reserved, "LifecycleRunSnapshot.reserved"),
		nodes: Object.freeze(
			array(snapshot, "nodes", "LifecycleRunSnapshot").map(entry => parseLifecycleNodeSnapshot(entry)),
		),
		attempts: Object.freeze(
			array(snapshot, "attempts", "LifecycleRunSnapshot").map(entry => parseLifecycleAttemptSnapshot(entry)),
		),
		dependencies: Object.freeze(
			array(snapshot, "dependencies", "LifecycleRunSnapshot").map(entry => parseLifecycleDependencySnapshot(entry)),
		),
		obligations: Object.freeze(
			array(snapshot, "obligations", "LifecycleRunSnapshot").map(entry => parseObligationV1(entry)),
		),
		publicationReceipts: Object.freeze(
			array(snapshot, "publicationReceipts", "LifecycleRunSnapshot").map(entry => parsePublicationReceipt(entry)),
		),
		verificationReceipts: Object.freeze(
			array(snapshot, "verificationReceipts", "LifecycleRunSnapshot").map(entry =>
				parseVerificationReceiptV1(entry),
			),
		),
		pendingInboxEventIds: stringArray(snapshot, "pendingInboxEventIds", "LifecycleRunSnapshot"),
		projectionManifestRefs: stringArray(snapshot, "projectionManifestRefs", "LifecycleRunSnapshot"),
	});
}

// ---------------------------------------------------------------------------
// Launch authority operations (§14.5) — persisted records and their inputs.
//
// Every mutation is runtime-private and carries a LaunchMutationGuard holding
// an authenticated actor. A serialized guard cannot authenticate, so these
// shapes are never reachable from tool arguments or SDK surface.
// ---------------------------------------------------------------------------

/**
 * Authenticates a mutation.
 *
 * `expectedPolicyEpoch` refers to the binding named by the operation. The
 * issuer's own currentness is checked separately through actor registration,
 * so a stale issuer cannot ride in on a fresh recipient epoch.
 */
export interface LaunchMutationGuard {
	readonly actor: LifecycleExecutionContext;
	readonly expectedPolicyEpoch: number;
	readonly idempotencyKey: string;
}

export interface GrantIssueRequest {
	readonly idempotencyKey: string;
	readonly recipientBindingId: string;
	readonly resource: ResourceSelectorV1;
	readonly operations: readonly ResourceOperation[];
	readonly delegableOperations: readonly ResourceOperation[];
	readonly recipientConstraints: readonly string[];
	/** Each derivation decrements every source bound; zero forbids onward issuance. */
	readonly remainingDelegationDepth: number;
	readonly domains: readonly DisclosureDomain[];
	readonly sourceGrantIds: readonly string[];
	readonly contractRevision: number;
	readonly attemptId: string;
	readonly expiresAt: number | null;
	readonly purpose: string;
}

/** Grant handle. Serialization alone is inert; use requires host registration. */
export interface RuntimeGrantRef {
	readonly grantId: string;
	readonly recordDigest: string;
}

/** Shared failure shape for every authority operation. */
export interface LaunchAuthorityFailure {
	readonly ok: false;
	readonly code: string;
	readonly diagnostics: readonly LaunchContractDiagnostic[];
}

export type GrantIssueResult = { readonly ok: true; readonly grant: RuntimeGrantRef } | LaunchAuthorityFailure;

export interface ContextDeliveryRequest {
	readonly deliveryId: string;
	readonly channelId: string;
	readonly recipientBindingId: string;
	readonly expectedPolicyEpoch: number;
	readonly attemptId: string;
	readonly contractRevision: number;
	readonly contextGeneration: number;
	readonly grantRefs: readonly { readonly grantId: string; readonly recordDigest: string }[];
	readonly payloadRef: ArtifactRefV1;
	readonly resourceRefs: readonly ResourceSelectorV1[];
	readonly domains: readonly DisclosureDomain[];
	readonly kind: DisclosureKind;
}

/**
 * One admitted disclosure. Admission is the commit point: an atomic
 * insertion into the recipient's durable context inbox plus channel-budget
 * consumption.
 */
export interface DeliveryRecordV1 {
	readonly schemaVersion: 1;
	readonly deliveryId: string;
	readonly channelId: string;
	readonly senderPrincipalId: string;
	readonly recipientPrincipalId: string;
	readonly recipientBindingId: string;
	readonly attemptId: string;
	readonly contractRevision: number;
	readonly policyEpoch: number;
	readonly contextGeneration: number;
	readonly payloadRef: ArtifactRefV1;
	readonly resourceRefs: readonly ResourceSelectorV1[];
	readonly domains: readonly DisclosureDomain[];
	readonly kind: DisclosureKind;
	readonly bytes: number;
	readonly requestDigest: string;
}

/**
 * Delivery audit states.
 *
 * `included` and the two provider outcomes are separate from `admitted`
 * because a provider timeout leaves the outcome genuinely unknown: it must
 * not refund the disclosure or imply exactly-once processing. Distinct model
 * requests may include the same admitted delivery without debiting the
 * channel twice.
 */
export type DeliveryEventKind =
	| "requested"
	| "authorized"
	| "admitted"
	| "rejected"
	| "included"
	| "provider-known"
	| "provider-unknown";

export interface DeliveryEventV1 {
	readonly eventId: string;
	readonly deliveryId: string;
	readonly kind: DeliveryEventKind;
	readonly requestId: string | null;
	readonly code: string | null;
	readonly occurredAt: number;
}

export type ContextDeliveryResult =
	| { readonly ok: true; readonly delivery: DeliveryRecordV1; readonly replayed: boolean }
	| LaunchAuthorityFailure;

export type DisclosurePhaseResult =
	| {
			readonly ok: true;
			readonly bindingId: string;
			readonly channelId: string;
			readonly policyEpoch: number;
			readonly replayed: boolean;
	  }
	| LaunchAuthorityFailure;

export type ReleaseResult =
	| { readonly ok: true; readonly releaseId: string; readonly replayed: boolean }
	| LaunchAuthorityFailure;

export interface LaunchAuthorityAdmissionInput {
	readonly guard: LaunchMutationGuard;
	readonly compiled: CompiledLaunchContract;
	readonly reservation: ReservationVector;
	/** Null for authority-only (legacy or helper) execution with no scheduler job. */
	readonly lifecycle: {
		readonly runId: string;
		readonly nodeId: string;
		readonly ownerNodeId: string | null;
		readonly jobId: string;
		readonly attemptId: string;
		readonly leaseEpoch: number;
		readonly cancellationGeneration: number;
		readonly reservationId: string;
	} | null;
	readonly restoresBindingId: string | null;
}

export type LaunchAuthorityAdmissionResult =
	| { readonly ok: true; readonly launch: LaunchContract; readonly replayed: boolean }
	| LaunchAuthorityFailure;

/**
 * authorized to bound stores probe results; bound to active revalidates
 * identity, epoch and evidence before the child becomes externally visible.
 */
export interface LaunchBindingActivationInput {
	readonly guard: LaunchMutationGuard;
	readonly bindingId: string;
	readonly expectedState: "authorized" | "bound";
	readonly sessionId: string;
	readonly processRef: string | null;
	readonly serviceBindings: LaunchBinding["serviceBindings"];
	readonly actualRuntimeGuarantees: RuntimeGuaranteesV1;
	readonly guaranteeEvidenceRefs: readonly ArtifactRefV1[];
}

export type LaunchBindingActivationResult = LaunchAuthorityAdmissionResult;

/**
 * Every authority change creates an immutable revision plus a new
 * attempt/binding. The delta is computed from the old and new canonical
 * records, never taken from the caller.
 */
export interface LaunchRevisionRequest {
	readonly bindingId: string;
	readonly expectedContractDigest: string;
	readonly expectedRevision: number;
	readonly expectedPolicyEpoch: number;
	readonly compiled: CompiledLaunchContract;
	readonly reason: string;
	readonly idempotencyKey: string;
}
