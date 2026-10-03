import type { EventEnvelopeV1 } from "@pk-nerdsaver-ai/mesh-contracts";

/** A transport name describes delivery, never authority or permission to execute. */
export type MeshEventTransport = "local" | "nostr" | "iroh" | "blossom" | "manual_import";

/** Reported by the boundary that performed verification; this package never fabricates a signature result. */
export type EventVerificationState = "not_applicable" | "unverified" | "verified";

export interface EventProvenance {
	readonly transport: MeshEventTransport;
	readonly receivedAt: string;
	readonly verification: EventVerificationState;
	readonly sourceNodeId?: string;
	readonly transportEventId?: string;
	readonly relay?: string;
}

export interface InboundMeshEvent {
	readonly envelope: EventEnvelopeV1;
	readonly provenance: EventProvenance;
}

/**
 * `envelopeDigest` makes an event identity tamper-evident without claiming
 * signatures. A durable backend must enforce eventId and idempotency uniqueness
 * atomically before making this record visible.
 */
export interface StoredMeshEvent extends InboundMeshEvent {
	readonly storedAt: string;
	readonly envelopeDigest: string;
}

export interface EventAppendResult {
	readonly status: "appended" | "duplicate";
	readonly record: StoredMeshEvent;
}

export interface DurableEventLog {
	append(input: InboundMeshEvent): Promise<EventAppendResult>;
	find(eventId: string): Promise<StoredMeshEvent | null>;
	listByType(type: string): Promise<readonly StoredMeshEvent[]>;
}

export type OutboxDestination =
	| {
			readonly transport: "nostr";
			readonly target: string;
		}
	| {
			readonly transport: "iroh";
			readonly target: string;
		}
	| {
			readonly transport: "local";
			readonly target: string;
		};

export type OutboxState = "pending" | "in_flight" | "delivered" | "dead_letter";

/**
 * A database outbox row. This package intentionally does not persist it: the
 * orchestrator owns the transaction that writes domain state and its outbox row.
 */
export interface MeshOutboxRecord {
	readonly outboxId: string;
	readonly destination: OutboxDestination;
	readonly event: EventEnvelopeV1;
	readonly eventDigest: string;
	readonly createdAt: string;
	readonly availableAt: string;
	readonly attemptCount: number;
	readonly state: OutboxState;
}
