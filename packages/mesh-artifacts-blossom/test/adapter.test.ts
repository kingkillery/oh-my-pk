import { expect, test } from "bun:test";

import { BlossomAdapterCapabilityError, BlossomArtifactAdapter, type BlossomTransportClient } from "../src";

test("fails closed before calling a Blossom client without authorization capability", async () => {
	const client: BlossomTransportClient = {
		capabilities: new Set(["blossom_put"]),
		async putBlob() {
			throw new Error("must not be called without required capabilities");
		},
	};
	const adapter = new BlossomArtifactAdapter(client);

	await expect(adapter.upload(new Uint8Array([1]), "0".repeat(64), "application/octet-stream")).rejects.toBeInstanceOf(
		BlossomAdapterCapabilityError,
	);
});
