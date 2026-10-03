import type { JsonRecord, NodeAdvertisementV1, TrustZone } from "@pk-nerdsaver-ai/mesh-contracts";

export type NodeHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface MeshNodeCapacity {
	readonly totalSlots: number;
	readonly availableSlots: number;
	readonly cpuPressure: number;
	readonly memoryPressure: number;
}

/**
 * A normalized, scheduler-safe projection of a signed node advertisement.
 * The advertisement remains the wire contract; this projection deliberately
 * keeps volatile telemetry separate from durable mesh task state.
 */
export interface MeshNodePresence {
	readonly nodeId: string;
	readonly actorPubkey: string;
	readonly trustZone: TrustZone;
	readonly observedAt: string;
	readonly expiresAt: string;
	readonly interactive: boolean;
	readonly activeInteractiveUser: boolean;
	readonly draining: boolean;
	readonly health: NodeHealth;
	readonly capabilities: readonly string[];
	readonly executionProfiles: readonly string[];
	readonly capacity: MeshNodeCapacity;
	readonly profileVersion: string;
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(values.map(value => value.trim()).filter(Boolean))].sort());
}

function stringList(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return Object.freeze([]);
	return uniqueSorted(value.filter((entry): entry is string => typeof entry === "string"));
}

function finiteNonNegative(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
	return value;
}

function pressure(value: unknown): number {
	return Math.min(1, finiteNonNegative(value, 0));
}

function nodeHealth(value: unknown): NodeHealth {
	return value === "healthy" || value === "degraded" || value === "unhealthy" ? value : "unknown";
}

function readRecord(value: unknown): JsonRecord {
	return isRecord(value) ? value : Object.freeze({});
}

/**
 * Normalizes the explicitly named fields a node agent may expose in its
 * advertisement. Unknown fields intentionally remain transport metadata and
 * do not influence placement until a later schema version names them.
 */
export function projectNodeAdvertisement(advertisement: NodeAdvertisementV1): MeshNodePresence {
	const staticInfo = readRecord(advertisement.static);
	const dynamic = readRecord(advertisement.dynamic);
	const capabilities = readRecord(advertisement.capabilities);
	const totalSlots = Math.max(1, Math.floor(finiteNonNegative(staticInfo.totalSlots, 1)));
	const availableSlots = Math.min(totalSlots, Math.floor(finiteNonNegative(dynamic.availableSlots, 0)));

	return Object.freeze({
		nodeId: advertisement.nodeId,
		actorPubkey: advertisement.actorPubkey,
		trustZone: advertisement.trustZone,
		observedAt: advertisement.generatedAt,
		expiresAt: advertisement.expiresAt,
		interactive: advertisement.interactive,
		activeInteractiveUser: dynamic.activeInteractiveUser === true,
		draining: advertisement.draining,
		health: nodeHealth(dynamic.health),
		capabilities: stringList(capabilities.names),
		executionProfiles: stringList(capabilities.executionProfiles),
		capacity: Object.freeze({
			totalSlots,
			availableSlots,
			cpuPressure: pressure(dynamic.cpuPressure),
			memoryPressure: pressure(dynamic.memoryPressure),
		}),
		profileVersion: advertisement.profileVersion,
	});
}

/** True only while the signed advertisement is still within its lease. */
export function isNodePresenceFresh(presence: MeshNodePresence, nowEpochMs: number): boolean {
	const expiry = Date.parse(presence.expiresAt);
	return Number.isFinite(expiry) && expiry > nowEpochMs;
}
