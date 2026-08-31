import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AtomicFileContentAddressedStore, ContentHashMismatchError, InMemoryContentAddressedStore, sha256Bytes } from "../src";

describe("InMemoryContentAddressedStore", () => {
	test("rejects content whose supplied address does not match", async () => {
		const store = new InMemoryContentAddressedStore();
		const content = new TextEncoder().encode("immutable artifact");

		await expect(store.put(content, "0".repeat(64))).rejects.toBeInstanceOf(ContentHashMismatchError);
	});

	test("stores a blob once and reports a deterministic idempotent retry", async () => {
		const store = new InMemoryContentAddressedStore();
		const content = new TextEncoder().encode("immutable artifact");
		const sha256 = sha256Bytes(content);
		const first = await store.put(content, sha256);
		const second = await store.put(content, sha256);

		expect(first).toEqual({ sha256, sizeBytes: content.byteLength, inserted: true });
		expect(second).toEqual({ sha256, sizeBytes: content.byteLength, inserted: false });
		const returned = await store.get(sha256);
		expect(new TextDecoder().decode(returned)).toBe("immutable artifact");
	});

	test("atomically publishes a local blob once under concurrent puts", async () => {
		const root = await mkdtemp(join(tmpdir(), "localmesh-cas-"));
		try {
			const store = new AtomicFileContentAddressedStore(root);
			const content = new TextEncoder().encode("atomic artifact");
			const sha256 = sha256Bytes(content);
			const results = await Promise.all([store.put(content, sha256), store.put(content, sha256)]);

			expect(results.filter(result => result.inserted)).toHaveLength(1);
			expect(results.filter(result => !result.inserted)).toHaveLength(1);
			expect(new TextDecoder().decode(await store.get(sha256))).toBe("atomic artifact");
			const shard = await readdir(join(root, sha256.slice(0, 2), sha256.slice(2, 4)));
			expect(shard).toEqual([sha256]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
