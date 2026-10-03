import { describe, expect, test } from "bun:test";

import type { ArtifactManifestV1 } from "@pk-nerdsaver-ai/mesh-contracts";

import {
	ArtifactContentMissingError,
	ArtifactContentSizeMismatchError,
	ArtifactManifestConflictError,
	ContentHashMismatchError,
	createArtifactManifest,
	InMemoryArtifactCatalog,
	InMemoryContentAddressedStore,
	sha256Bytes,
	type ContentAddressedStore,
} from "../src";

const encoder = new TextEncoder();

function manifestFor(content: Uint8Array, options: { readonly artifactId: string; readonly taskId?: string; readonly name?: string }): ArtifactManifestV1 {
	const base = {
		artifactId: options.artifactId,
		createdAt: "2026-08-31T00:00:00Z",
		createdBy: { pubkey: "f".repeat(64), role: "worker" as const },
		name: options.name ?? "artifact.txt",
		contentType: "text/plain",
		sizeBytes: content.byteLength,
		contentSha256: sha256Bytes(content),
		encryption: { mode: "none" },
		locations: [],
		retention: { class: "project" },
		safety: { classification: "internal" },
	};
	return options.taskId === undefined
		? createArtifactManifest(base)
		: createArtifactManifest({ ...base, taskId: options.taskId });
}

class MisaddressedContentStore implements ContentAddressedStore {
	readonly #content: Uint8Array;

	constructor(content: Uint8Array) {
		this.#content = content;
	}

	async put(): Promise<never> {
		throw new Error("not implemented for this test store");
	}

	async get(): Promise<Uint8Array> {
		return new Uint8Array(this.#content);
	}

	async has(): Promise<boolean> {
		return true;
	}
}

describe("InMemoryArtifactCatalog", () => {
	test("rejects a valid manifest when its content has not been published to the CAS", async () => {
		const content = encoder.encode("missing content");
		const catalog = new InMemoryArtifactCatalog(new InMemoryContentAddressedStore());

		await expect(catalog.register(manifestFor(content, { artifactId: "art_missing-content-001" }))).rejects.toBeInstanceOf(
			ArtifactContentMissingError,
		);
	});

	test("rejects CAS bytes whose declared hash or size disagrees with the manifest", async () => {
		const expected = encoder.encode("expected content");
		const wrongSameSize = encoder.encode("mismatcH content");
		const hashMismatchCatalog = new InMemoryArtifactCatalog(new MisaddressedContentStore(wrongSameSize));

		await expect(hashMismatchCatalog.register(manifestFor(expected, { artifactId: "art_hash-mismatch-001" }))).rejects.toBeInstanceOf(
			ContentHashMismatchError,
		);

		const store = new InMemoryContentAddressedStore();
		await store.put(expected);
		const sizeMismatchManifest = manifestFor(expected, { artifactId: "art_size-mismatch-001" });
		const { schemaVersion: _schemaVersion, manifestDigest: _manifestDigest, ...sizeMismatchInput } = {
			...sizeMismatchManifest,
			sizeBytes: sizeMismatchManifest.sizeBytes + 1,
		};
		const resignedSizeMismatch = createArtifactManifest(sizeMismatchInput);
		const sizeMismatchCatalog = new InMemoryArtifactCatalog(store);

		await expect(sizeMismatchCatalog.register(resignedSizeMismatch)).rejects.toBeInstanceOf(ArtifactContentSizeMismatchError);
	});

	test("returns the same immutable record for an identical retry and rejects an ID conflict", async () => {
		const content = encoder.encode("stable artifact content");
		const store = new InMemoryContentAddressedStore();
		await store.put(content);
		const catalog = new InMemoryArtifactCatalog(store);
		const firstManifest = manifestFor(content, { artifactId: "art_idempotent-001", taskId: "task_idempotent-001" });
		const first = await catalog.register(firstManifest);
		const second = await catalog.register(JSON.parse(JSON.stringify(firstManifest)));

		expect(first.inserted).toBe(true);
		expect(second.inserted).toBe(false);
		expect(second.manifest).toBe(first.manifest);
		expect(second.retention).toBe(first.retention);
		expect(Object.isFrozen(first.manifest)).toBe(true);
		expect(Object.isFrozen(first.manifest.retention)).toBe(true);

		const conflict = manifestFor(content, {
			artifactId: "art_idempotent-001",
			taskId: "task_idempotent-001",
			name: "a-different-name.txt",
		});
		await expect(catalog.register(conflict)).rejects.toBeInstanceOf(ArtifactManifestConflictError);
	});

	test("lists immutable manifests by task and retains policy metadata without garbage collection", async () => {
		const taskA = "task_catalog-list-a";
		const taskB = "task_catalog-list-b";
		const store = new InMemoryContentAddressedStore();
		const firstContent = encoder.encode("first");
		const secondContent = encoder.encode("second");
		const thirdContent = encoder.encode("third");
		await Promise.all([store.put(firstContent), store.put(secondContent), store.put(thirdContent)]);

		const catalog = new InMemoryArtifactCatalog(store);
		const first = manifestFor(firstContent, { artifactId: "art_catalog-list-001", taskId: taskA });
		const second = manifestFor(secondContent, { artifactId: "art_catalog-list-002", taskId: taskA });
		const third = manifestFor(thirdContent, { artifactId: "art_catalog-list-003", taskId: taskB });
		await catalog.register(first);
		await catalog.register(second);
		await catalog.register(third);

		expect(catalog.listForTask(taskA).map(manifest => manifest.artifactId)).toEqual([
			"art_catalog-list-001",
			"art_catalog-list-002",
		]);
		expect(catalog.get("art_catalog-list-003")?.taskId).toBe(taskB);
		expect(catalog.getRetention("art_catalog-list-001")).toEqual({
			artifactId: "art_catalog-list-001",
			taskId: taskA,
			policy: { class: "project" },
			state: "retained",
			destructiveGarbageCollection: false,
		});
	});
});
