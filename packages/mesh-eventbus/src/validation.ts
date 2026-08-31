import {
	parseEventEnvelope,
	sha256CanonicalJson,
	toImmutableJson,
	type EventEnvelopeV1,
	type JsonRecord,
	type JsonValue,
} from "@pk-nerdsaver-ai/mesh-contracts";

import type { EventProvenance, EventVerificationState, MeshEventTransport } from "./types";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const TRANSPORTS = new Set<MeshEventTransport>(["local", "nostr", "iroh", "blossom", "manual_import"]);
const VERIFICATION_STATES = new Set<EventVerificationState>(["not_applicable", "unverified", "verified"]);

/** Safe-to-log boundary error: it deliberately never contains payload values. */
export class EventBusValidationError extends Error {
	readonly path: string;

	constructor(path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "EventBusValidationError";
		this.path = path;
	}
}

function fail(path: string, message: string): never {
	throw new EventBusValidationError(path, message);
}

function asRecord(value: JsonValue, path: string): JsonRecord {
	if (value === null || Array.isArray(value) || typeof value !== "object") fail(path, "must be an object");
	return value;
}

function optionalNonEmptyString(record: JsonRecord, field: string, path: string): string | undefined {
	const value = record[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) fail(`${path}.${field}`, "must be a non-empty string");
	return value;
}

function timestamp(value: JsonValue | undefined, path: string): string {
	if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
		fail(path, "must be an ISO-8601 timestamp with timezone");
	}
	return value;
}

/** Parse the protocol envelope before it enters a durable log. */
export function parseMeshEventEnvelope(input: unknown): EventEnvelopeV1 {
	return parseEventEnvelope(input);
}

/**
 * Provenance remains separate from the signed/protocol envelope. That prevents a
 * relay, endpoint, or local receipt from pretending to be application authority.
 */
export function parseEventProvenance(input: unknown): EventProvenance {
	const record = asRecord(toImmutableJson(input), "$.provenance");
	const allowed = new Set(["transport", "receivedAt", "verification", "sourceNodeId", "transportEventId", "relay"]);
	for (const key of Object.keys(record)) if (!allowed.has(key)) fail(`$.provenance.${key}`, "is not permitted");

	const transport = record.transport;
	if (typeof transport !== "string" || !TRANSPORTS.has(transport as MeshEventTransport)) {
		fail("$.provenance.transport", "must be a supported mesh transport");
	}
	const verification = record.verification;
	if (typeof verification !== "string" || !VERIFICATION_STATES.has(verification as EventVerificationState)) {
		fail("$.provenance.verification", "must be a supported verification state");
	}

	return Object.freeze({
		transport: transport as MeshEventTransport,
		receivedAt: timestamp(record.receivedAt, "$.provenance.receivedAt"),
		verification: verification as EventVerificationState,
		sourceNodeId: optionalNonEmptyString(record, "sourceNodeId", "$.provenance"),
		transportEventId: optionalNonEmptyString(record, "transportEventId", "$.provenance"),
		relay: optionalNonEmptyString(record, "relay", "$.provenance"),
	});
}

export function eventEnvelopeDigest(envelope: EventEnvelopeV1): string {
	return sha256CanonicalJson(envelope);
}

export function assertOutboxIdentifier(value: string, path: string): string {
	if (value.trim().length < 3 || value.length > 200) fail(path, "must be a 3-200 character identifier");
	return value;
}

export function assertOutboxTimestamp(value: string, path: string): string {
	return timestamp(value, path);
}
