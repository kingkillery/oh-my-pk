import { ContentHashMismatchError, sha256Bytes } from "@pk-nerdsaver-ai/mesh-artifacts";

export type BlossomTransportCapability = "blossom_put" | "blossom_get" | "nostr_authorization";

export interface BlossomUploadRequest {
	readonly content: Uint8Array;
	readonly sha256: string;
	readonly contentType: string;
}

export interface BlossomUploadReceipt {
	readonly sha256: string;
	readonly url: string;
	readonly storedAt: string;
}

/** Externally implemented HTTP/Nostr authorization boundary; no client is bundled here. */
export interface BlossomTransportClient {
	readonly capabilities: ReadonlySet<BlossomTransportCapability>;
	putBlob(request: BlossomUploadRequest): Promise<BlossomUploadReceipt>;
}

export class BlossomAdapterCapabilityError extends Error {
	readonly missing: readonly BlossomTransportCapability[];

	constructor(missing: readonly BlossomTransportCapability[]) {
		super(`Blossom transport is missing required capabilities: ${missing.join(", ")}`);
		this.name = "BlossomAdapterCapabilityError";
		this.missing = Object.freeze([...missing]);
	}
}

const REQUIRED_CAPABILITIES = ["blossom_put", "nostr_authorization"] as const;

function assertCapabilities(client: BlossomTransportClient): void {
	const missing = REQUIRED_CAPABILITIES.filter(capability => !client.capabilities.has(capability));
	if (missing.length > 0) throw new BlossomAdapterCapabilityError(missing);
}

/**
 * Sends already-addressed blob bytes to a configured Blossom client. The client
 * owns authorization and networking; this adapter validates only local content
 * identity and the receipt's returned digest.
 */
export class BlossomArtifactAdapter {
	readonly #client: BlossomTransportClient;

	constructor(client: BlossomTransportClient) {
		this.#client = client;
	}

	async upload(content: Uint8Array, expectedSha256: string, contentType: string): Promise<BlossomUploadReceipt> {
		assertCapabilities(this.#client);
		const actualSha256 = sha256Bytes(content);
		if (actualSha256 !== expectedSha256) throw new ContentHashMismatchError(expectedSha256, actualSha256);
		const receipt = await this.#client.putBlob({ content: new Uint8Array(content), sha256: actualSha256, contentType });
		if (receipt.sha256 !== actualSha256) throw new ContentHashMismatchError(actualSha256, receipt.sha256);
		return Object.freeze({ ...receipt });
	}
}
