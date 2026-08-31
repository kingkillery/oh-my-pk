import type { AssignmentLeaseV1, ExecutionReceiptV1, JsonRecord, TaskContractV1 } from "@pk-nerdsaver-ai/mesh-contracts";
import type { SignedMeshEnvelopeV1 } from "@pk-nerdsaver-ai/mesh-auth";
import type { ReceiptSignatureVerifier, SignedExecutionReceiptV1 } from "@pk-nerdsaver-ai/mesh-receipts";

export type MeshTaskState = "queued" | "leased" | "completed" | "failed" | "cancelled" | "lost";
export type MeshAssignmentState = "leased" | "completed" | "expired" | "fenced" | "cancelled";
export type OutboxState = "pending" | "in_flight" | "published";

export interface RuntimeTaskRecord {
	readonly task: TaskContractV1;
	state: MeshTaskState;
	currentAssignmentId?: string;
	latestFencingToken: number;
	createdAt: string;
	updatedAt: string;
}

export interface RuntimeAssignmentRecord {
	readonly lease: AssignmentLeaseV1;
	state: MeshAssignmentState;
	createdAt: string;
	updatedAt: string;
	/** Exact scheduler-verified delivery material, atomically committed with a new lease. */
	readonly delivery?: RuntimeAssignmentDelivery;
	receipt?: ExecutionReceiptV1;
	receiptVerification?: ReceiptVerificationRecord;
}

/**
 * The portable task plus its exact scheduler-signed lease envelope. This is
 * durable recovery material, not a transport message or another authority.
 */
export interface RuntimeAssignmentDelivery {
	readonly task: TaskContractV1;
	readonly signedAssignment: SignedMeshEnvelopeV1<AssignmentLeaseV1>;
	readonly idempotencyKey: string;
}

/** One-snapshot read used to resume delivery after controller process loss. */
export interface RuntimeAssignmentDeliveryRecovery {
	readonly record: RuntimeAssignmentRecord;
	readonly task: TaskContractV1;
	readonly signedAssignment: SignedMeshEnvelopeV1<AssignmentLeaseV1>;
	readonly idempotencyKey: string;
}

/** Immutable provenance for the verifier decision that admitted an execution receipt. */
export interface ReceiptVerificationRecord {
	readonly algorithm: string;
	readonly keyId: string;
	readonly workerPubkey: string;
	readonly nodeId: string;
	readonly verifiedAt: string;
	readonly signatureDigest: string;
}

/**
 * Outbox records are written in the same repository transaction as state changes.
 * Delivery occurs later, so a process death cannot lose the authoritative change.
 */
export interface OutboxMessage {
	readonly outboxId: string;
	readonly type: string;
	readonly aggregateId: string;
	readonly idempotencyKey: string;
	readonly payload: JsonRecord;
	readonly payloadDigest: string;
	state: OutboxState;
	attempts: number;
	availableAt: number;
	lockedUntil?: number;
	claimToken?: string;
	publishedAt?: string;
}

export interface DeliveryLedgerRecord {
	readonly idempotencyKey: string;
	readonly messageId: string;
	readonly payloadDigest: string;
	readonly receivedAt: string;
}

export interface SchedulerAuthorityState {
	epoch: number;
	ownerId?: string;
	leaseExpiresAt: number;
}

/** Latest trusted capacity observation for one worker; older observations never replace it. */
export interface WorkerCapacityObservation {
	/** The worker identity that advertised this capacity for the node. */
	readonly actorPubkey: string;
	readonly availableSlots: number;
	readonly observedAt: number;
	readonly expiresAt: number;
}

/**
 * The serialisable schema for the control-plane authority. A SQLite adapter can
 * persist it in normalized rows or as one transactionally-versioned document.
 */
export interface MeshRuntimeSnapshot {
	revision: number;
	tasks: Record<string, RuntimeTaskRecord>;
	assignments: Record<string, RuntimeAssignmentRecord>;
	outbox: Record<string, OutboxMessage>;
	deliveries: Record<string, DeliveryLedgerRecord>;
	workerCapacityObservations: Record<string, WorkerCapacityObservation>;
	scheduler: SchedulerAuthorityState;
}

export interface MeshRuntimeTransaction {
	readonly snapshot: MeshRuntimeSnapshot;
}

/**
 * Durable authority boundary. Production adapters implement this with real
 * database transactions; callers never use transport state as the source of truth.
 */
export interface MeshRuntimeRepository {
	read<T>(select: (snapshot: MeshRuntimeSnapshot) => T | Promise<T>): Promise<T>;
	transaction<T>(operation: (transaction: MeshRuntimeTransaction) => T | Promise<T>): Promise<T>;
}

export interface SchedulerLeaseRequest {
	/** Stable scheduler actor key; it must match AssignmentLeaseV1.scheduler.pubkey. */
	readonly schedulerId: string;
	readonly durationMs: number;
	/** Deterministic trusted lower bound; durable authority always reads its clock at transaction entry. */
	readonly now?: number;
}

export interface SchedulerLeaseGrant {
	readonly schedulerId: string;
	readonly epoch: number;
	readonly leaseExpiresAt: string;
}

export interface AssignmentRequest {
	readonly assignment: AssignmentLeaseV1 | unknown;
	/** Optional only for the initial scheduler-issued commit; never overwritten on replay. */
	readonly delivery?: {
		readonly task: TaskContractV1 | unknown;
		readonly signedAssignment: SignedMeshEnvelopeV1<AssignmentLeaseV1> | unknown;
	};
	/** Deterministic trusted lower bound; durable authority always reads its clock at transaction entry. */
	readonly now?: number;
}

/**
 * A scheduler-derived capacity fact that is durably monotonic per worker.
 * Callers must pass only provenance-verified local presence; the durable
 * runtime owns ordering and admission, not presence signature verification.
 */
export interface WorkerCapacityObservationRequest {
	readonly workerNodeId: string;
	readonly actorPubkey: string;
	readonly availableSlots: number;
	readonly observedAt: number;
	readonly expiresAt: number;
}

export interface ReceiptRequest {
	/** A signed envelope, never a bare receipt. */
	readonly signedReceipt: SignedExecutionReceiptV1 | unknown;
}

/** Resolves only from an authoritative lease; untrusted receipt metadata never selects trust. */
export interface ReceiptVerifierResolver {
	resolve(assignment: AssignmentLeaseV1): ReceiptSignatureVerifier | undefined | Promise<ReceiptSignatureVerifier | undefined>;
}

/** Durable authority time for scheduler leases, assignment commits, and receipt admission. */
export interface MeshOrchestratorClock {
	nowEpochMs(): number;
}

export interface MeshOrchestratorOptions {
	readonly receiptVerifierResolver: ReceiptVerifierResolver;
	readonly clock: MeshOrchestratorClock;
}

export interface ReapResult {
	readonly expiredAssignments: readonly string[];
	readonly recoveredOutboxMessages: readonly string[];
	readonly schedulerLeaseExpired: boolean;
}

export interface MeshOutboxPublisher {
	publish(message: Readonly<OutboxMessage>): Promise<void>;
}

export interface OutboxDrainResult {
	readonly published: readonly string[];
	readonly failed: readonly string[];
}

export interface MeshInboundDelivery {
	readonly messageId: string;
	readonly idempotencyKey: string;
	readonly payload: JsonRecord;
	readonly receivedAt?: string;
}

export interface DeliveryAcceptance {
	readonly status: "accepted" | "duplicate";
	readonly record: DeliveryLedgerRecord;
}

export function createEmptyRuntimeSnapshot(): MeshRuntimeSnapshot {
	return {
		revision: 0,
		tasks: {},
		assignments: {},
		outbox: {},
		deliveries: {},
		workerCapacityObservations: {},
		scheduler: {
			epoch: 0,
			leaseExpiresAt: 0,
		},
	};
}
