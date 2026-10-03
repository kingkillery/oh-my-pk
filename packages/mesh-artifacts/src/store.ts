import { access, link, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ContentHashMismatchError, ContentIntegrityError } from "./errors";
import { assertContentSha256, sha256Bytes } from "./hash";

export interface StoredBlob {
	readonly sha256: string;
	readonly sizeBytes: number;
}

export interface PutBlobResult extends StoredBlob {
	readonly inserted: boolean;
}

export interface ContentAddressedStore {
	put(content: Uint8Array, expectedSha256?: string): Promise<PutBlobResult>;
	get(sha256: string): Promise<Uint8Array | null>;
	has(sha256: string): Promise<boolean>;
}

function result(sha256: string, sizeBytes: number, inserted: boolean): PutBlobResult {
	return Object.freeze({ sha256, sizeBytes, inserted });
}

function verifiedContent(content: Uint8Array, expectedSha256?: string): { readonly content: Uint8Array; readonly sha256: string } {
	const immutableCopy = new Uint8Array(content);
	const sha256 = sha256Bytes(immutableCopy);
	if (expectedSha256 !== undefined) {
		assertContentSha256(expectedSha256);
		if (expectedSha256 !== sha256) throw new ContentHashMismatchError(expectedSha256, sha256);
	}
	return Object.freeze({ content: immutableCopy, sha256 });
}

/**
 * Process-local implementation with atomic map mutation. It is suitable for
 * tests and single-process use; a persistent backend must offer the same
 * compare-before-insert result contract.
 */
export class InMemoryContentAddressedStore implements ContentAddressedStore {
	#blobs = new Map<string, Uint8Array>();

	async put(content: Uint8Array, expectedSha256?: string): Promise<PutBlobResult> {
		const verified = verifiedContent(content, expectedSha256);
		const existing = this.#blobs.get(verified.sha256);
		if (existing) return result(verified.sha256, existing.byteLength, false);
		this.#blobs.set(verified.sha256, verified.content);
		return result(verified.sha256, verified.content.byteLength, true);
	}

	async get(sha256: string): Promise<Uint8Array | null> {
		assertContentSha256(sha256);
		const content = this.#blobs.get(sha256);
		return content ? new Uint8Array(content) : null;
	}

	async has(sha256: string): Promise<boolean> {
		assertContentSha256(sha256);
		return this.#blobs.has(sha256);
	}
}

/**
 * Local disk CAS. A completed blob is published only by atomically linking a
 * verified temporary file into place, so readers never observe a partial file
 * and competing writers cannot overwrite an already-published blob.
 */
export class AtomicFileContentAddressedStore implements ContentAddressedStore {
	readonly #rootDirectory: string;

	constructor(rootDirectory: string) {
		if (rootDirectory.trim().length === 0) throw new Error("content-addressed store root must not be empty");
		this.#rootDirectory = rootDirectory;
	}

	async put(content: Uint8Array, expectedSha256?: string): Promise<PutBlobResult> {
		const verified = verifiedContent(content, expectedSha256);
		const existing = await this.get(verified.sha256);
		if (existing) return result(verified.sha256, existing.byteLength, false);

		const target = this.#pathFor(verified.sha256);
		const directory = dirname(target);
		await mkdir(directory, { recursive: true });
		const temporary = join(directory, `.${verified.sha256}.${crypto.randomUUID()}.part`);
		await Bun.write(temporary, verified.content);
		try {
			await link(temporary, target);
		} catch (error) {
			const concurrent = await this.get(verified.sha256);
			if (concurrent) return result(verified.sha256, concurrent.byteLength, false);
			throw error;
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
		return result(verified.sha256, verified.content.byteLength, true);
	}

	async get(sha256: string): Promise<Uint8Array | null> {
		assertContentSha256(sha256);
		const path = this.#pathFor(sha256);
		try {
			await access(path);
		} catch {
			return null;
		}
		const content = new Uint8Array(await Bun.file(path).arrayBuffer());
		if (sha256Bytes(content) !== sha256) throw new ContentIntegrityError(sha256);
		return content;
	}

	async has(sha256: string): Promise<boolean> {
		return (await this.get(sha256)) !== null;
	}

	#pathFor(sha256: string): string {
		return join(this.#rootDirectory, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
	}
}
