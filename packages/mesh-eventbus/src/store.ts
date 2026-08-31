import type { EventEnvelopeV1 } from "@pk-nerdsaver-ai/mesh-contracts";

import { eventEnvelopeDigest, parseEventProvenance, parseMeshEventEnvelope } from "./validation";
import type { DurableEventLog, EventAppendResult, InboundMeshEvent, StoredMeshEvent } from "./types";

/** The same eventId or idempotency key must never resolve to different content. */
export class EventConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EventConflictError";
	}
}

function idempotencyIndexKey(envelope: EventEnvelopeV1): string {
	return `${envelope.actor.pubkey}\u0000${envelope.idempotencyKey}`;
}

function freezeRecord(
	envelope: EventEnvelopeV1,
	provenance: InboundMeshEvent["provenance"],
	storedAt: string,
	envelopeDigest: string,
): StoredMeshEvent {
	return Object.freeze({ envelope, provenance, storedAt, envelopeDigest });
}

/**
 * A deterministic test/runtime adapter. Production implementations satisfy the
 * same interface with a database unique constraint on eventId and actor/idempotencyKey.
 */
export class InMemoryDurableEventLog implements DurableEventLog {
	#byEventId = new Map<string, StoredMeshEvent>();
	#byIdempotency = new Map<string, string>();
	#byType = new Map<string, string[]>();

	async append(input: InboundMeshEvent): Promise<EventAppendResult> {
		const envelope = parseMeshEventEnvelope(input.envelope);
		const provenance = parseEventProvenance(input.provenance);
		const envelopeDigest = eventEnvelopeDigest(envelope);
		const existing = this.#byEventId.get(envelope.eventId);
		if (existing) {
			if (existing.envelopeDigest !== envelopeDigest) {
				throw new EventConflictError(`event ${envelope.eventId} already exists with different content`);
			}
			// Retain first-received provenance: a later transport cannot rewrite history.
			return Object.freeze({ status: "duplicate", record: existing });
		}

		const idempotencyKey = idempotencyIndexKey(envelope);
		const priorEventId = this.#byIdempotency.get(idempotencyKey);
		if (priorEventId) {
			throw new EventConflictError(
				`idempotency key for actor ${envelope.actor.pubkey} already belongs to event ${priorEventId}`,
			);
		}

		const record = freezeRecord(envelope, provenance, new Date().toISOString(), envelopeDigest);
		this.#byEventId.set(envelope.eventId, record);
		this.#byIdempotency.set(idempotencyKey, envelope.eventId);
		const ids = this.#byType.get(envelope.type) ?? [];
		ids.push(envelope.eventId);
		this.#byType.set(envelope.type, ids);
		return Object.freeze({ status: "appended", record });
	}

	async find(eventId: string): Promise<StoredMeshEvent | null> {
		return this.#byEventId.get(eventId) ?? null;
	}

	async listByType(type: string): Promise<readonly StoredMeshEvent[]> {
		const ids = this.#byType.get(type) ?? [];
		return Object.freeze(ids.flatMap(id => {
			const record = this.#byEventId.get(id);
			return record ? [record] : [];
		}));
	}
}
