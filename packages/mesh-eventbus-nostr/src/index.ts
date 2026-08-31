import {
	parseMeshEventEnvelope,
	serializeOutboxEvent,
	type DurableEventLog,
	type EventAppendResult,
	type InboundMeshEvent,
	type MeshOutboxRecord,
} from "@pk-nerdsaver-ai/mesh-eventbus";

export type NostrTransportCapability = "relay_write" | "nip44" | "gift_wrap";

export interface NostrPublishRequest {
	readonly outboxId: string;
	readonly canonicalEvent: string;
}

export interface NostrPublishReceipt {
	readonly transportEventId: string;
	readonly acceptedAt: string;
	readonly relay: string;
}

/**
 * Implemented by a separately configured Nostr client. The adapter does not
 * create keys, encrypt payloads, establish network connections, or execute
 * commands. `publishGiftWrapped` is where a real client performs that work.
 */
export interface NostrTransportClient {
	readonly capabilities: ReadonlySet<NostrTransportCapability>;
	publishGiftWrapped(request: NostrPublishRequest): Promise<NostrPublishReceipt>;
}

export class NostrAdapterCapabilityError extends Error {
	readonly missing: readonly NostrTransportCapability[];

	constructor(missing: readonly NostrTransportCapability[]) {
		super(`Nostr transport is missing required capabilities: ${missing.join(", ")}`);
		this.name = "NostrAdapterCapabilityError";
		this.missing = Object.freeze([...missing]);
	}
}

const REQUIRED_CAPABILITIES = ["relay_write", "nip44", "gift_wrap"] as const;

function assertCapabilities(client: NostrTransportClient): void {
	const missing = REQUIRED_CAPABILITIES.filter(capability => !client.capabilities.has(capability));
	if (missing.length > 0) throw new NostrAdapterCapabilityError(missing);
}

/**
 * Narrow Nostr bridge. It only hands canonical event data to a capable external
 * client and accepts already-verified inbound events for durable deduplication.
 */
export class NostrEventBusAdapter {
	readonly #client: NostrTransportClient;

	constructor(client: NostrTransportClient) {
		this.#client = client;
	}

	async publish(record: MeshOutboxRecord): Promise<NostrPublishReceipt> {
		if (record.destination.transport !== "nostr") {
			throw new Error("Nostr adapter can only publish Nostr outbox records");
		}
		assertCapabilities(this.#client);
		return this.#client.publishGiftWrapped({
			outboxId: record.outboxId,
			canonicalEvent: serializeOutboxEvent(record),
		});
	}

	async ingestVerified(input: InboundMeshEvent, log: DurableEventLog): Promise<EventAppendResult> {
		if (input.provenance.transport !== "nostr") {
			throw new Error("Nostr adapter only accepts Nostr provenance");
		}
		if (input.provenance.verification !== "verified") {
			throw new Error("Nostr adapter requires verification by the configured Nostr client");
		}
		// Re-parse here so malformed protocol events never reach a durable store.
		const envelope = parseMeshEventEnvelope(input.envelope);
		return log.append({ envelope, provenance: input.provenance });
	}
}
