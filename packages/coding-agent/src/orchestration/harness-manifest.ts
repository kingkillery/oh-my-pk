/**
 * Pinned Harness Manifest (A13).
 *
 * An immutable, content-hashed description of the harness a bound child runs
 * under. The context projector applies its `maxTools` as an extra tool
 * ceiling and records its hash in every projection manifest. Every field
 * except manifestHash is hashed with the shared canonical encoder.
 */

import { type ArtifactRefV1, canonicalJson, sha256Hex, type ToolCapabilitySource } from "../task/launch-contract";
import type { AgentHarness } from "./agent-harness";

export type HarnessProfile = "research" | "implementation" | "debugging" | "verification" | "planning";

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
