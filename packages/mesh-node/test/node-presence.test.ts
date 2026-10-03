import { describe, expect, test } from "bun:test";

import { MESH_SCHEMA, parseNodeAdvertisement } from "@pk-nerdsaver-ai/mesh-contracts";
import { isNodePresenceFresh, projectNodeAdvertisement } from "../src/index";

describe("node presence projection", () => {
	test("normalizes advertised capabilities and volatile capacity for scheduling", () => {
		const advertisement = parseNodeAdvertisement({
			schemaVersion: MESH_SCHEMA.node,
			nodeId: "node_msi-001",
			actorPubkey: "a".repeat(64),
			generatedAt: "2026-08-31T00:00:00Z",
			expiresAt: "2026-08-31T01:00:00Z",
			trustZone: "private",
			interactive: false,
			draining: false,
			static: { totalSlots: 4 },
			dynamic: { availableSlots: 3, cpuPressure: 0.25, memoryPressure: 0.5, health: "healthy" },
			capabilities: { names: ["container", "bun", "container"], executionProfiles: ["ompk-safe"] },
			reservations: {},
			profileVersion: "node-profile-1",
		});

		const presence = projectNodeAdvertisement(advertisement);

		expect(presence.capabilities).toEqual(["bun", "container"]);
		expect(presence.executionProfiles).toEqual(["ompk-safe"]);
		expect(presence.capacity).toEqual({ totalSlots: 4, availableSlots: 3, cpuPressure: 0.25, memoryPressure: 0.5 });
		expect(isNodePresenceFresh(presence, Date.parse("2026-08-31T00:30:00Z"))).toBe(true);
		expect(Object.isFrozen(presence)).toBe(true);
	});
});
