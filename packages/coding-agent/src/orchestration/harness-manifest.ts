/**
 * Pinned Harness Manifest (A13) — frozen W1 contract surface.
 *
 * Resolves an immutable, content-hashed manifest from the selected harness.
 * Every field except manifestHash is hashed with the shared canonical encoder.
 * Restore a saved manifest by hash or block — missing pinned data never selects
 * current defaults.
 */

import {
	type ArtifactRefV1,
	canonicalJson,
	isHex64,
	isNonEmptyString,
	isPlainObject,
	isSafeNonNegativeInt,
	parseArtifactRefV1,
	sha256Hex,
	TOOL_CAPABILITY_SOURCES,
	type ToolCapabilitySource,
} from "../task/launch-contract";
import type { AgentHarness } from "./agent-harness";

export type HarnessProfile = "research" | "implementation" | "debugging" | "verification" | "planning";
export const KNOWN_HARNESS_PROFILES: readonly HarnessProfile[] = [
	"research",
	"implementation",
	"debugging",
	"verification",
	"planning",
] as const;

export interface HarnessToolRef {
	readonly source: ToolCapabilitySource;
	readonly name: string;
}

export interface ModelRouteStep {
	readonly provider: string;
	readonly model: string;
}

export interface HarnessManifestV1 {
	readonly schemaVersion: 1;
	readonly manifestHash: string;
	readonly harnessVersion: string;
	readonly profile: HarnessProfile;
	readonly kind: AgentHarness["kind"];
	readonly maxTools: readonly HarnessToolRef[];
	readonly skillPolicy: AgentHarness["skillPolicy"];
	readonly projectionVersion: 1;
	readonly observationPolicy: "raw-retained" | "reduced";
	readonly memoryPolicy: "local-only" | "project-partition" | "none";
	readonly checkpointContract: "durable" | "none";
	readonly modelRoute: readonly ModelRouteStep[];
	readonly returnSchemaRef: string;
	readonly skillRefs: readonly ArtifactRefV1[];
}

export function computeHarnessManifestHash(
	manifest: Omit<HarnessManifestV1, "manifestHash" | "harnessVersion">,
): string {
	const body = {
		schemaVersion: manifest.schemaVersion,
		profile: manifest.profile,
		kind: manifest.kind,
		maxTools: [...manifest.maxTools].sort((a, b) =>
			a.source === b.source ? (a.name < b.name ? -1 : 1) : a.source < b.source ? -1 : 1,
		),
		skillPolicy: manifest.skillPolicy,
		projectionVersion: manifest.projectionVersion,
		observationPolicy: manifest.observationPolicy,
		memoryPolicy: manifest.memoryPolicy,
		checkpointContract: manifest.checkpointContract,
		modelRoute: [...manifest.modelRoute],
		returnSchemaRef: manifest.returnSchemaRef,
		skillRefs: [...manifest.skillRefs].sort((a, b) => (a.artifactId < b.artifactId ? -1 : 1)),
	};
	return sha256Hex(canonicalJson(body));
}

export interface ResolveHarnessOptions {
	readonly modelRoute?: readonly ModelRouteStep[];
	readonly maxTools?: readonly HarnessToolRef[];
	readonly returnSchemaRef?: string;
	readonly skillRefs?: readonly ArtifactRefV1[];
	readonly observationPolicy?: "raw-retained" | "reduced";
	readonly memoryPolicy?: "local-only" | "project-partition" | "none";
	readonly checkpointContract?: "durable" | "none";
}

export function resolveHarnessManifest(
	harness: AgentHarness,
	profile: HarnessProfile,
	options: ResolveHarnessOptions = {},
): HarnessManifestV1 {
	const base = {
		schemaVersion: 1 as const,
		profile,
		kind: harness.kind,
		maxTools: Object.freeze([...(options.maxTools ?? [])]),
		skillPolicy: harness.skillPolicy,
		projectionVersion: 1 as const,
		observationPolicy: options.observationPolicy ?? "raw-retained",
		memoryPolicy: options.memoryPolicy ?? "local-only",
		checkpointContract: options.checkpointContract ?? "durable",
		modelRoute: Object.freeze([...(options.modelRoute ?? [{ provider: "default", model: "default" }])]),
		returnSchemaRef: options.returnSchemaRef ?? "schema://none",
		skillRefs: Object.freeze([...(options.skillRefs ?? [])]),
	};
	const manifestHash = computeHarnessManifestHash(base);
	return Object.freeze({
		...base,
		manifestHash,
		harnessVersion: manifestHash.slice(0, 16),
	});
}

export function verifyHarnessManifest(manifest: HarnessManifestV1): boolean {
	const expected = computeHarnessManifestHash(manifest);
	return expected === manifest.manifestHash;
}

const HARNESS_KINDS: readonly AgentHarness["kind"][] = ["simple", "standard", "full"];
const SKILL_MODES: readonly AgentHarness["skillPolicy"]["mode"][] = ["none", "allowlist", "all"];
const OBSERVATION_POLICIES: readonly HarnessManifestV1["observationPolicy"][] = ["raw-retained", "reduced"];
const MEMORY_POLICIES: readonly HarnessManifestV1["memoryPolicy"][] = ["local-only", "project-partition", "none"];
const CHECKPOINT_CONTRACTS: readonly HarnessManifestV1["checkpointContract"][] = ["durable", "none"];

const HARNESS_MANIFEST_KEYS = [
	"schemaVersion",
	"manifestHash",
	"harnessVersion",
	"profile",
	"kind",
	"maxTools",
	"skillPolicy",
	"projectionVersion",
	"observationPolicy",
	"memoryPolicy",
	"checkpointContract",
	"modelRoute",
	"returnSchemaRef",
	"skillRefs",
] as const;

/**
 * Strict parser: a restored harness manifest decides which tools and model
 * route a resumed run may use. Defaulting a missing `returnSchemaRef` or
 * `harnessVersion` would substitute current behaviour for pinned behaviour,
 * which is exactly what restore must refuse to do.
 */
export function parseHarnessManifestV1(value: unknown): HarnessManifestV1 {
	if (!isPlainObject(value)) throw new Error("Invalid HarnessManifestV1: expected object");
	for (const key of Object.keys(value)) {
		if (!HARNESS_MANIFEST_KEYS.includes(key as (typeof HARNESS_MANIFEST_KEYS)[number])) {
			throw new Error(`Invalid HarnessManifestV1: unknown field '${key}'`);
		}
	}
	if (value.schemaVersion !== 1) throw new Error("Invalid HarnessManifestV1: schemaVersion must be 1");
	if (value.projectionVersion !== 1) throw new Error("Invalid HarnessManifestV1: projectionVersion must be 1");
	if (!isHex64(value.manifestHash)) {
		throw new Error("Invalid HarnessManifestV1: manifestHash must be 64-hex SHA-256");
	}
	if (!isNonEmptyString(value.harnessVersion)) {
		throw new Error("Invalid HarnessManifestV1: harnessVersion must be a non-empty string");
	}
	if (!isNonEmptyString(value.returnSchemaRef)) {
		throw new Error("Invalid HarnessManifestV1: returnSchemaRef must be a non-empty string");
	}
	if (typeof value.profile !== "string" || !KNOWN_HARNESS_PROFILES.includes(value.profile as HarnessProfile)) {
		throw new Error(`Invalid HarnessManifestV1: unknown profile '${String(value.profile)}'`);
	}
	if (typeof value.kind !== "string" || !HARNESS_KINDS.includes(value.kind as AgentHarness["kind"])) {
		throw new Error(`Invalid HarnessManifestV1: unknown kind '${String(value.kind)}'`);
	}
	for (const [field, allowed] of [
		["observationPolicy", OBSERVATION_POLICIES],
		["memoryPolicy", MEMORY_POLICIES],
		["checkpointContract", CHECKPOINT_CONTRACTS],
	] as const) {
		const actual = value[field];
		if (typeof actual !== "string" || !(allowed as readonly string[]).includes(actual)) {
			throw new Error(`Invalid HarnessManifestV1: ${field} must be one of ${allowed.join("|")}`);
		}
	}
	if (!isPlainObject(value.skillPolicy)) {
		throw new Error("Invalid HarnessManifestV1: skillPolicy must be an object");
	}
	const skillPolicy = value.skillPolicy;
	if (
		typeof skillPolicy.mode !== "string" ||
		!SKILL_MODES.includes(skillPolicy.mode as AgentHarness["skillPolicy"]["mode"])
	) {
		throw new Error(`Invalid HarnessManifestV1: unknown skillPolicy.mode '${String(skillPolicy.mode)}'`);
	}
	if (!Array.isArray(skillPolicy.allowNames) || !skillPolicy.allowNames.every(n => isNonEmptyString(n))) {
		throw new Error("Invalid HarnessManifestV1: skillPolicy.allowNames must be non-empty strings");
	}
	if (!isSafeNonNegativeInt(skillPolicy.maxSkills)) {
		throw new Error("Invalid HarnessManifestV1: skillPolicy.maxSkills must be a safe non-negative integer");
	}
	if (!Array.isArray(value.maxTools) || !Array.isArray(value.modelRoute) || !Array.isArray(value.skillRefs)) {
		throw new Error("Invalid HarnessManifestV1: maxTools, modelRoute, skillRefs must be arrays");
	}
	const parsed: HarnessManifestV1 = {
		schemaVersion: 1,
		manifestHash: value.manifestHash,
		harnessVersion: value.harnessVersion,
		profile: value.profile as HarnessProfile,
		kind: value.kind as AgentHarness["kind"],
		maxTools: Object.freeze(
			value.maxTools.map((entry, index) => {
				if (!isPlainObject(entry)) throw new Error(`Invalid HarnessManifestV1: maxTools[${index}] must be object`);
				if (
					typeof entry.source !== "string" ||
					!TOOL_CAPABILITY_SOURCES.includes(entry.source as ToolCapabilitySource)
				) {
					throw new Error(`Invalid HarnessManifestV1: maxTools[${index}].source is not a known tool source`);
				}
				if (!isNonEmptyString(entry.name)) {
					throw new Error(`Invalid HarnessManifestV1: maxTools[${index}].name must be a non-empty string`);
				}
				return { source: entry.source as ToolCapabilitySource, name: entry.name };
			}),
		),
		skillPolicy: Object.freeze({
			mode: skillPolicy.mode as AgentHarness["skillPolicy"]["mode"],
			allowNames: Object.freeze([...(skillPolicy.allowNames as string[])]),
			maxSkills: skillPolicy.maxSkills,
		}),
		projectionVersion: 1,
		observationPolicy: value.observationPolicy as HarnessManifestV1["observationPolicy"],
		memoryPolicy: value.memoryPolicy as HarnessManifestV1["memoryPolicy"],
		checkpointContract: value.checkpointContract as HarnessManifestV1["checkpointContract"],
		modelRoute: Object.freeze(
			value.modelRoute.map((entry, index) => {
				if (!isPlainObject(entry))
					throw new Error(`Invalid HarnessManifestV1: modelRoute[${index}] must be object`);
				if (!isNonEmptyString(entry.provider) || !isNonEmptyString(entry.model)) {
					throw new Error(`Invalid HarnessManifestV1: modelRoute[${index}] needs provider and model strings`);
				}
				return { provider: entry.provider, model: entry.model };
			}),
		),
		returnSchemaRef: value.returnSchemaRef,
		skillRefs: Object.freeze(
			value.skillRefs.map((entry, index) => parseArtifactRefV1(entry, `HarnessManifestV1.skillRefs[${index}]`)),
		),
	};
	if (!verifyHarnessManifest(parsed)) {
		throw new Error("Invalid HarnessManifestV1: manifestHash does not match content");
	}
	return Object.freeze(parsed);
}
