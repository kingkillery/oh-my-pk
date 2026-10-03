import type { MeshCliJson, MeshCliJsonObject } from "./types";

const REDACTED = "[REDACTED]";

/**
 * Converts unknown service output into a serializable, deterministic JSON
 * value. It sorts object keys and avoids leaking exception internals.
 */
export function toMeshCliJson(value: unknown, active: WeakSet<object> = new WeakSet<object>()): MeshCliJson {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "undefined") return null;
	if (typeof value === "symbol" || typeof value === "function") return "[unsupported_value]";
	if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value.toISOString();
	if (value instanceof Error) {
		return Object.freeze({
			message: redactMeshCliError(value.message),
			name: value.name || "Error",
		});
	}
	if (typeof value !== "object") return "[unsupported_value]";
	if (active.has(value)) return "[circular]";
	active.add(value);
	try {
		if (Array.isArray(value)) return Object.freeze(Array.from(value, item => toMeshCliJson(item, active)));
		const result: Record<string, MeshCliJson> = {};
		for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
			try {
				result[key] = toMeshCliJson((value as Record<string, unknown>)[key], active);
			} catch {
				result[key] = "[unavailable]";
			}
		}
		return Object.freeze(result) as MeshCliJsonObject;
	} finally {
		active.delete(value);
	}
}

/** Redacts common credential shapes before an error crosses the CLI boundary. */
export function redactMeshCliError(message: string): string {
	return message
		.replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi, `Authorization: Bearer ${REDACTED}`)
		.replace(
			/\b(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret|authorization)\s*([:=])\s*([^\s,;]+)/gi,
			(_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
		)
		.replace(/\b(Bearer\s+)([^\s,;]+)/gi, (_match, prefix: string) => `${prefix}${REDACTED}`)
		.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,}|nsec1[A-Za-z0-9]+)\b/g, REDACTED);
}

export function isMeshCliJsonObject(value: MeshCliJson): value is MeshCliJsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
