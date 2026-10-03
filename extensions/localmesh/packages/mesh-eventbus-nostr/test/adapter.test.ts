import { expect, test } from "bun:test";

import { NostrAdapterCapabilityError, NostrEventBusAdapter, type NostrTransportClient } from "../src";

test("fails closed when the configured client cannot provide private transport", async () => {
	const client: NostrTransportClient = {
		capabilities: new Set(["relay_write"]),
		async publishGiftWrapped() {
			throw new Error("must not be called without required capabilities");
		},
	};
	const adapter = new NostrEventBusAdapter(client);
	const record = {
		outboxId: "out_alpha",
		destination: { transport: "nostr" as const, target: "mesh-control" },
	};

	await expect(adapter.publish(record as never)).rejects.toBeInstanceOf(NostrAdapterCapabilityError);
});
