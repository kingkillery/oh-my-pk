import { canonicalizeJson } from "@pk-nerdsaver-ai/mesh-contracts";

import type { MeshOutboxRecord, OutboxDestination } from "./types";
import { assertOutboxIdentifier, assertOutboxTimestamp, eventEnvelopeDigest, parseMeshEventEnvelope } from "./validation";

export interface CreateOutboxRecordInput {
	readonly outboxId: string;
	readonly destination: OutboxDestination;
	readonly event: MeshOutboxRecord["event"];
	readonly createdAt: string;
	readonly availableAt?: string;
}

function parseDestination(input: OutboxDestination): OutboxDestination {
	if ((input.transport !== "nostr" && input.transport !== "iroh" && input.transport !== "local") || input.target.trim().length === 0) {
		throw new Error("outbox destination must identify a supported transport and non-empty target");
	}
	return Object.freeze({ transport: input.transport, target: input.target });
}

/** Adapt a validated event to a transactionally persisted outbox row. */
export function createOutboxRecord(input: CreateOutboxRecordInput): MeshOutboxRecord {
	const event = parseMeshEventEnvelope(input.event);
	const createdAt = assertOutboxTimestamp(input.createdAt, "$.createdAt");
	const availableAt = assertOutboxTimestamp(input.availableAt ?? createdAt, "$.availableAt");
	return Object.freeze({
		outboxId: assertOutboxIdentifier(input.outboxId, "$.outboxId"),
		destination: parseDestination(input.destination),
		event,
		eventDigest: eventEnvelopeDigest(event),
		createdAt,
		availableAt,
		attemptCount: 0,
		state: "pending",
	});
}

/** The canonical payload handed to a transport adapter; no transport runs commands from it. */
export function serializeOutboxEvent(record: MeshOutboxRecord): string {
	return canonicalizeJson(record.event);
}

export function markOutboxAttempt(
	record: MeshOutboxRecord,
	state: "in_flight" | "delivered" | "dead_letter",
): MeshOutboxRecord {
	return Object.freeze({
		...record,
		attemptCount: record.attemptCount + 1,
		state,
	});
}
