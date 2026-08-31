import type { AssignmentLeaseV1, ExecutionReceiptV1, JsonRecord, TaskContractV1 } from "@pk-nerdsaver-ai/mesh-contracts";

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
	receipt?: ExecutionReceiptV1;
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
	readonly now?: number;
}

export interface SchedulerLeaseGrant {
	readonly schedulerId: string;
	readonly epoch: number;
	readonly leaseExpiresAt: string;
}

export interface AssignmentRequest {
	readonly assignment: AssignmentLeaseV1 | unknown;
	readonly now?: number;
}

export interface ReceiptRequest {
	readonly receipt: ExecutionReceiptV1 | unknown;
	readonly now?: number;
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
		scheduler: {
			epoch: 0,
			leaseExpiresAt: 0,
		},
	};
}
