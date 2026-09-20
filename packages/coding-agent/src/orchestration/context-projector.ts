/**
 * Pure lifecycle context projector (A04) — frozen W1 contract surface.
 *
 * Admits only fragments whose content matches their pinned source digest;
 * unknown provenance is denied for hierarchical requests. Required denied or
 * missing fragments block the request with a visible outcome — never silent
 * truncation.
 *
 * ProjectionManifest records version, hashes, admitted/denied fragment IDs
 * and tool schemas. Excluded text NEVER enters this record.
 */

import {
	canonicalJson,
	isHex64,
	isNonEmptyString,
	isPlainObject,
	isSafeNonNegativeInt,
	sha256Hex,
	TOOL_CAPABILITY_SOURCES,
	type ToolCapabilitySource,
} from "../task/launch-contract";

export type ContextClass =
	| "mission"
	| "project-invariant"
	| "granted-evidence"
	| "local-trajectory"
	| "owner-handoff"
	| "operational"
	| "institutional"
	| "held-out";

export type ProjectionPhase =
	| "launch"
	| "continue"
	| "tool-result"
	| "compact"
	| "recall"
	| "retry"
	| "resume"
	| "fork"
	| "queued"
	| "fallback"
	| "side-request";

export interface ContextFragment {
	readonly id: string;
	readonly contextClass: ContextClass;
	readonly sourceRef: string;
	readonly sourceHash: string;
	readonly ownerScope: string;
	readonly contentRef: string;
	readonly content: string;
	readonly required: boolean;
	readonly parentProvenanceIds: readonly string[];
}

export interface ProjectedToolRef {
	readonly source: ToolCapabilitySource;
	readonly name: string;
	readonly schemaHash: string;
}

export interface ProjectionManifest {
	readonly schemaVersion: 1;
	readonly manifestHash: string;
	readonly launchHash: string;
	readonly policyHash: string;
	readonly harnessHash: string;
	readonly grantGeneration: number;
	readonly phase: ProjectionPhase;
	readonly admitted: readonly { readonly fragmentId: string; readonly sourceHash: string }[];
	readonly rejected: readonly { readonly fragmentId: string; readonly code: string }[];
	readonly tools: readonly ProjectedToolRef[];
}

export interface ContextProjectionInput {
	readonly launchHash: string;
	readonly policyHash: string;
	readonly harnessHash: string;
	readonly grantGeneration: number;
	readonly phase: ProjectionPhase;
	readonly fragments: readonly ContextFragment[];
	readonly tools: readonly ProjectedToolRef[];
}

export type ContextProjectionResult =
	| {
			readonly ok: true;
			readonly context: { readonly messages: readonly string[]; readonly tools: readonly ProjectedToolRef[] };
			readonly manifest: ProjectionManifest;
	  }
	| {
			readonly ok: false;
			readonly code: "missing_required_input" | "untrusted_context";
			readonly fragmentIds: readonly string[];
	  };

export function computeProjectionManifestHash(manifest: Omit<ProjectionManifest, "manifestHash">): string {
	const body = {
		schemaVersion: manifest.schemaVersion,
		launchHash: manifest.launchHash,
		policyHash: manifest.policyHash,
		harnessHash: manifest.harnessHash,
		grantGeneration: manifest.grantGeneration,
		phase: manifest.phase,
		admitted: [...manifest.admitted].sort((a, b) => (a.fragmentId < b.fragmentId ? -1 : 1)),
		rejected: [...manifest.rejected].sort((a, b) => (a.fragmentId < b.fragmentId ? -1 : 1)),
		tools: [...manifest.tools].sort((a, b) =>
			a.source === b.source ? (a.name < b.name ? -1 : 1) : a.source < b.source ? -1 : 1,
		),
	};
	return sha256Hex(canonicalJson(body));
}

export function projectLifecycleContext(input: ContextProjectionInput): ContextProjectionResult {
	const rejected: { fragmentId: string; code: string }[] = [];
	const admittedMessages: string[] = [];
	const admittedEntries: { fragmentId: string; sourceHash: string }[] = [];
	const missingRequired: string[] = [];

	for (const fragment of input.fragments) {
		if (sha256Hex(fragment.content) !== fragment.sourceHash) {
			rejected.push({ fragmentId: fragment.id, code: "digest_mismatch" });
			if (fragment.required) missingRequired.push(fragment.id);
			continue;
		}
		admittedMessages.push(fragment.content);
		admittedEntries.push({ fragmentId: fragment.id, sourceHash: fragment.sourceHash });
	}

	if (missingRequired.length > 0) {
		return { ok: false, code: "missing_required_input", fragmentIds: missingRequired };
	}

	const baseManifest = {
		schemaVersion: 1 as const,
		launchHash: input.launchHash,
		policyHash: input.policyHash,
		harnessHash: input.harnessHash,
		grantGeneration: input.grantGeneration,
		phase: input.phase,
		admitted: Object.freeze(admittedEntries),
		rejected: Object.freeze(rejected),
		tools: Object.freeze([...input.tools]),
	};
	const manifestHash = computeProjectionManifestHash(baseManifest);
	const manifest: ProjectionManifest = Object.freeze({
		...baseManifest,
		manifestHash,
	});

	return {
		ok: true,
		context: { messages: Object.freeze(admittedMessages), tools: Object.freeze([...input.tools]) },
		manifest,
	};
}

const PROJECTION_PHASES: readonly ProjectionPhase[] = [
	"launch",
	"continue",
	"tool-result",
	"compact",
	"recall",
	"retry",
	"resume",
	"fork",
	"queued",
	"fallback",
	"side-request",
];

const PROJECTION_MANIFEST_KEYS = [
	"schemaVersion",
	"manifestHash",
	"launchHash",
	"policyHash",
	"harnessHash",
	"grantGeneration",
	"phase",
	"admitted",
	"rejected",
	"tools",
] as const;

/**
 * Strict parser: the manifest is the audit record of what was admitted into a
 * model request, so a coerced field would silently rewrite that history.
 * `String(undefined)` producing `"undefined"` for a missing launch hash, or an
 * unvalidated `phase` cast, would both yield a manifest that hashes cleanly
 * while describing a projection that never happened.
 */
export function parseProjectionManifest(value: unknown): ProjectionManifest {
	if (!isPlainObject(value)) throw new Error("Invalid ProjectionManifest: expected object");
	for (const key of Object.keys(value)) {
		if (!PROJECTION_MANIFEST_KEYS.includes(key as (typeof PROJECTION_MANIFEST_KEYS)[number])) {
			throw new Error(`Invalid ProjectionManifest: unknown field '${key}'`);
		}
	}
	if (value.schemaVersion !== 1) throw new Error("Invalid ProjectionManifest: schemaVersion must be 1");
	if (!isHex64(value.manifestHash)) {
		throw new Error("Invalid ProjectionManifest: manifestHash must be 64-hex SHA-256");
	}
	for (const field of ["launchHash", "policyHash", "harnessHash"] as const) {
		if (!isHex64(value[field])) {
			throw new Error(`Invalid ProjectionManifest: ${field} must be 64-hex SHA-256`);
		}
	}
	if (!isSafeNonNegativeInt(value.grantGeneration)) {
		throw new Error("Invalid ProjectionManifest: grantGeneration must be a safe non-negative integer");
	}
	if (typeof value.phase !== "string" || !PROJECTION_PHASES.includes(value.phase as ProjectionPhase)) {
		throw new Error(`Invalid ProjectionManifest: unknown phase '${String(value.phase)}'`);
	}
	if (!Array.isArray(value.admitted) || !Array.isArray(value.rejected) || !Array.isArray(value.tools)) {
		throw new Error("Invalid ProjectionManifest: admitted, rejected, tools must be arrays");
	}
	const base = {
		schemaVersion: 1 as const,
		launchHash: value.launchHash as string,
		policyHash: value.policyHash as string,
		harnessHash: value.harnessHash as string,
		grantGeneration: value.grantGeneration,
		phase: value.phase as ProjectionPhase,
		admitted: Object.freeze(
			value.admitted.map((entry, index) => {
				if (!isPlainObject(entry)) throw new Error(`Invalid ProjectionManifest: admitted[${index}] must be object`);
				if (!isNonEmptyString(entry.fragmentId)) {
					throw new Error(`Invalid ProjectionManifest: admitted[${index}].fragmentId must be a non-empty string`);
				}
				if (!isHex64(entry.sourceHash)) {
					throw new Error(`Invalid ProjectionManifest: admitted[${index}].sourceHash must be 64-hex SHA-256`);
				}
				return { fragmentId: entry.fragmentId, sourceHash: entry.sourceHash };
			}),
		),
		rejected: Object.freeze(
			value.rejected.map((entry, index) => {
				if (!isPlainObject(entry)) throw new Error(`Invalid ProjectionManifest: rejected[${index}] must be object`);
				if (!isNonEmptyString(entry.fragmentId)) {
					throw new Error(`Invalid ProjectionManifest: rejected[${index}].fragmentId must be a non-empty string`);
				}
				if (!isNonEmptyString(entry.code)) {
					throw new Error(`Invalid ProjectionManifest: rejected[${index}].code must be a non-empty string`);
				}
				return { fragmentId: entry.fragmentId, code: entry.code };
			}),
		),
		tools: Object.freeze(
			value.tools.map((entry, index) => {
				if (!isPlainObject(entry)) throw new Error(`Invalid ProjectionManifest: tools[${index}] must be object`);
				if (
					typeof entry.source !== "string" ||
					!TOOL_CAPABILITY_SOURCES.includes(entry.source as ToolCapabilitySource)
				) {
					throw new Error(`Invalid ProjectionManifest: tools[${index}].source is not a known tool source`);
				}
				if (!isNonEmptyString(entry.name)) {
					throw new Error(`Invalid ProjectionManifest: tools[${index}].name must be a non-empty string`);
				}
				if (!isHex64(entry.schemaHash)) {
					throw new Error(`Invalid ProjectionManifest: tools[${index}].schemaHash must be 64-hex SHA-256`);
				}
				return { source: entry.source as ToolCapabilitySource, name: entry.name, schemaHash: entry.schemaHash };
			}),
		),
	};
	if (computeProjectionManifestHash(base) !== value.manifestHash) {
		throw new Error("Invalid ProjectionManifest: manifestHash does not match content");
	}
	return Object.freeze({ ...base, manifestHash: value.manifestHash });
}

export function buildFragment(
	id: string,
	contextClass: ContextClass,
	ownerScope: string,
	content: string,
	options: {
		required?: boolean;
		parentProvenanceIds?: readonly string[];
		sourceRef?: string;
		contentRef?: string;
	} = {},
): ContextFragment {
	const sourceHash = sha256Hex(content);
	return Object.freeze({
		id,
		contextClass,
		sourceRef: options.sourceRef ?? `fragment://${id}`,
		sourceHash,
		ownerScope,
		contentRef: options.contentRef ?? `content://${sourceHash}`,
		content,
		required: options.required ?? false,
		parentProvenanceIds: Object.freeze([...(options.parentProvenanceIds ?? [])]),
	});
}
