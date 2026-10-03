import { describe, expect, test } from "bun:test";
import { MESH_SCHEMA, sha256CanonicalJson } from "@pk-nerdsaver-ai/mesh-contracts";

import { createOutboxRecord, EventConflictError, InMemoryDurableEventLog } from "../src";

const actor = Object.freeze({ pubkey: "0123456789abcdef0123456789abcdef", role: "orchestrator" as const, nodeId: "node_control" });

function event(eventId = "evt_alpha"): Record<string, unknown> {
	const payload = { taskId: "task_alpha", state: "queued" };
	return {
		schemaVersion: MESH_SCHEMA.event,
		eventId,
		type: "task.queued",
		occurredAt: "2026-08-31T12:00:00.000Z",
		actor,
		idempotencyKey: `idem-${eventId}`,
		payloadEncoding: "json",
		payload,
		payloadSha256: sha256CanonicalJson(payload),
	};
}

const provenance = Object.freeze({
	transport: "nostr" as const,
	receivedAt: "2026-08-31T12:00:01.000Z",
	verification: "verified" as const,
	sourceNodeId: "node_control",
	relay: "wss://relay.example.test",
});

describe("InMemoryDurableEventLog", () => {
	test("deduplicates a matching event and retains first-received provenance", async () => {
		const log = new InMemoryDurableEventLog();
		const first = await log.append({ envelope: event() as never, provenance });
		const duplicate = await log.append({
			envelope: event() as never,
			provenance: { ...provenance, transport: "iroh", receivedAt: "2026-08-31T12:00:02.000Z" },
		});

		expect(first.status).toBe("appended");
		expect(duplicate.status).toBe("duplicate");
		expect(duplicate.record.provenance.transport).toBe("nostr");
		expect((await log.listByType("task.queued")).length).toBe(1);
	});

	test("rejects a conflicting reuse of an event identity", async () => {
		const log = new InMemoryDurableEventLog();
		await log.append({ envelope: event() as never, provenance });
		const changed = event();
		changed.payload = { taskId: "task_alpha", state: "running" };
		changed.payloadSha256 = sha256CanonicalJson(changed.payload);

		await expect(log.append({ envelope: changed as never, provenance })).rejects.toBeInstanceOf(EventConflictError);
	});

	test("adapts a validated event into a retryable outbox row", () => {
		const record = createOutboxRecord({
			outboxId: "out_alpha",
			destination: { transport: "nostr", target: "mesh-control" },
			event: event() as never,
			createdAt: "2026-08-31T12:00:00.000Z",
		});

		expect(record.state).toBe("pending");
		expect(record.eventDigest).toHaveLength(64);
	});
});
