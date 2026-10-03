import {
	MESH_SCHEMA,
	parseArtifactManifest,
	sha256CanonicalJson,
	toImmutableJson,
	type ArtifactManifestV1,
	type JsonRecord,
	type JsonValue,
} from "@pk-nerdsaver-ai/mesh-contracts";

export type CreateArtifactManifestInput = Omit<ArtifactManifestV1, "schemaVersion" | "manifestDigest">;

function asRecord(value: JsonValue): JsonRecord {
	if (value === null || Array.isArray(value) || typeof value !== "object") {
		throw new Error("artifact manifest input must be a JSON object");
	}
	return value;
}

/** Build a canonical, self-verifying artifact manifest around a previously stored blob. */
export function createArtifactManifest(input: CreateArtifactManifestInput): ArtifactManifestV1 {
	const immutableInput = asRecord(toImmutableJson(input));
	const base: Record<string, JsonValue> = {};
	for (const [key, value] of Object.entries(immutableInput)) {
		if (key === "schemaVersion" || key === "manifestDigest") {
			throw new Error(`artifact manifest input must not provide ${key}`);
		}
		base[key] = value;
	}
	base.schemaVersion = MESH_SCHEMA.artifact;
	base.manifestDigest = sha256CanonicalJson(base);
	return parseArtifactManifest(base);
}

/** Validate both the public contract and its canonical manifest digest. */
export function validateArtifactManifest(input: unknown): ArtifactManifestV1 {
	return parseArtifactManifest(input);
}
