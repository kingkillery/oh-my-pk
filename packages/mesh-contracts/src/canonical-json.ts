import { createHash } from "node:crypto";

import { MeshValidationError } from "./errors";
import type { JsonRecord, JsonValue } from "./types";

function fail(path: string, message: string): never {
	throw new MeshValidationError([{ code: "invalid_value", path, message }]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function normalize(value: unknown, path: string, ancestors: ReadonlySet<object>): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Object.is(value, -0)) fail(path, "must be a finite, non-negative-zero JSON number");
		return value;
	}
	if (Array.isArray(value)) {
		if (Object.keys(value).length !== value.length) fail(path, "must not contain sparse array entries");
		if (ancestors.has(value)) fail(path, "must not contain a reference cycle");
		const nextAncestors = new Set(ancestors);
		nextAncestors.add(value);
		return Object.freeze(value.map((entry, index) => normalize(entry, `${path}[${index}]`, nextAncestors)));
	}
	if (!isPlainRecord(value)) fail(path, "must be a JSON primitive, array, or plain object");
	if (ancestors.has(value)) fail(path, "must not contain a reference cycle");
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(value);
	const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
	for (const key of Object.keys(value).sort()) {
		if (value[key] === undefined) fail(`${path}.${key}`, "must not be undefined");
		result[key] = normalize(value[key], `${path}.${key}`, nextAncestors);
	}
	return Object.freeze(result) as JsonRecord;
}

/** Canonical JSON with recursively ordered object keys and preserved array order. */
export function canonicalizeJson(value: unknown): string {
	return JSON.stringify(normalize(value, "$", new Set()));
}

/** SHA-256 over canonical JSON, encoded as lowercase hexadecimal. */
export function sha256CanonicalJson(value: unknown): string {
	return createHash("sha256").update(canonicalizeJson(value)).digest("hex");
}

export function toImmutableJson(value: unknown): JsonValue {
	return normalize(value, "$", new Set());
}
