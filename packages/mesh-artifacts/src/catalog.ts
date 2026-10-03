import { assertMeshId, canonicalizeJson, type ArtifactManifestV1, type JsonRecord } from "@pk-nerdsaver-ai/mesh-contracts";

import { ArtifactContentMissingError, ArtifactContentSizeMismatchError, ArtifactManifestConflictError, ContentHashMismatchError } from "./errors";
import { sha256Bytes } from "./hash";
import { validateArtifactManifest } from "./manifest";
import type { ContentAddressedStore } from "./store";

/**
 * A non-destructive retention snapshot. The catalog preserves this metadata but
 * deliberately does not schedule or execute garbage collection.
 */
export interface ArtifactRetentionMetadata {
	readonly artifactId: string;
	readonly taskId?: string;
	readonly policy: JsonRecord;
	readonly state: "retained";
	readonly destructiveGarbageCollection: false;
}

export interface ArtifactRegistrationResult {
	readonly manifest: ArtifactManifestV1;
	readonly retention: ArtifactRetentionMetadata;
	readonly inserted: boolean;
}

interface CatalogEntry {
	readonly manifest: ArtifactManifestV1;
	readonly retention: ArtifactRetentionMetadata;
}

function retentionMetadata(manifest: ArtifactManifestV1): ArtifactRetentionMetadata {
	const metadata: {
		artifactId: string;
		taskId?: string;
		policy: JsonRecord;
		state: "retained";
		destructiveGarbageCollection: false;
	} = {
		artifactId: manifest.artifactId,
		policy: manifest.retention,
		state: "retained",
		destructiveGarbageCollection: false,
	};
	if (manifest.taskId !== undefined) metadata.taskId = manifest.taskId;
	return Object.freeze(metadata);
}

function registrationResult(entry: CatalogEntry, inserted: boolean): ArtifactRegistrationResult {
	return Object.freeze({ manifest: entry.manifest, retention: entry.retention, inserted });
}

function manifestsAreIdentical(left: ArtifactManifestV1, right: ArtifactManifestV1): boolean {
	return left.manifestDigest === right.manifestDigest && canonicalizeJson(left) === canonicalizeJson(right);
}

/**
 * Reference artifact catalog for a single process. It is intentionally a
 * registry boundary only: it verifies published CAS bytes, preserves immutable
 * manifest snapshots, and leaves retention/garbage collection to a future
 * durable backend.
 */
export class InMemoryArtifactCatalog {
	readonly #contentStore: ContentAddressedStore;
	readonly #entries = new Map<string, CatalogEntry>();
	readonly #artifactIdsByTask = new Map<string, string[]>();

	constructor(contentStore: ContentAddressedStore) {
		this.#contentStore = contentStore;
	}

	/**
	 * Registers a self-validating manifest only when its declared CAS content is
	 * currently available and agrees with both content hash and byte size.
	 */
	async register(input: unknown): Promise<ArtifactRegistrationResult> {
		const manifest = validateArtifactManifest(input);
		const content = await this.#contentStore.get(manifest.contentSha256);
		if (content === null) throw new ArtifactContentMissingError(manifest.artifactId, manifest.contentSha256);

		const actualSha256 = sha256Bytes(content);
		if (actualSha256 !== manifest.contentSha256) {
			throw new ContentHashMismatchError(manifest.contentSha256, actualSha256);
		}
		if (content.byteLength !== manifest.sizeBytes) {
			throw new ArtifactContentSizeMismatchError(manifest.artifactId, manifest.sizeBytes, content.byteLength);
		}

		const existing = this.#entries.get(manifest.artifactId);
		if (existing !== undefined) {
			if (manifestsAreIdentical(existing.manifest, manifest)) return registrationResult(existing, false);
			throw new ArtifactManifestConflictError(manifest.artifactId, existing.manifest.manifestDigest, manifest.manifestDigest);
		}

		const entry = Object.freeze({ manifest, retention: retentionMetadata(manifest) });
		this.#entries.set(manifest.artifactId, entry);
		if (manifest.taskId !== undefined) {
			const artifactIds = this.#artifactIdsByTask.get(manifest.taskId) ?? [];
			artifactIds.push(manifest.artifactId);
			this.#artifactIdsByTask.set(manifest.taskId, artifactIds);
		}
		return registrationResult(entry, true);
	}

	get(artifactId: string): ArtifactManifestV1 | null {
		assertMeshId(artifactId, "artifact", "$.artifactId");
		return this.#entries.get(artifactId)?.manifest ?? null;
	}

	listForTask(taskId: string): readonly ArtifactManifestV1[] {
		assertMeshId(taskId, "task", "$.taskId");
		const artifacts: ArtifactManifestV1[] = [];
		for (const artifactId of this.#artifactIdsByTask.get(taskId) ?? []) {
			const entry = this.#entries.get(artifactId);
			if (entry !== undefined) artifacts.push(entry.manifest);
		}
		return Object.freeze(artifacts);
	}

	getRetention(artifactId: string): ArtifactRetentionMetadata | null {
		assertMeshId(artifactId, "artifact", "$.artifactId");
		return this.#entries.get(artifactId)?.retention ?? null;
	}
}
