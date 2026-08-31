import { describe, expect, test } from "bun:test";

import {
	MESH_SCHEMA,
	parseTaskContract,
	sha256CanonicalJson,
	type TaskContractV1,
} from "@pk-nerdsaver-ai/mesh-contracts";
import { placeTask, type PlacementNode } from "../src/index";

function task(routingOverride: Record<string, unknown> = {}): TaskContractV1 {
	const unsigned = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_scheduler-placement-001",
		createdAt: "2026-08-31T00:00:00Z",
		requester: { pubkey: "f".repeat(64), role: "orchestrator" },
		goal: "Place a constrained mesh task.",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "placement", description: "A safe worker is selected.", level: "required" }],
		permissions: { tools: ["shell"], externalSideEffects: "none" },
		execution: { profileId: "ompk-safe", timeoutSeconds: 60 },
		routing: { requiredCapabilities: ["container"], trustZoneMin: "private", ...routingOverride },
		artifactPolicy: { encryptionRequired: true },
		idempotencyKey: "scheduler-placement-001",
		digestAlgorithm: "sha256" as const,
	};
	return parseTaskContract({ ...unsigned, digest: sha256CanonicalJson(unsigned) });
}

function node(overrides: Partial<PlacementNode> = {}): PlacementNode {
	return {
		nodeId: "node_mesh-a",
		actorPubkey: "a".repeat(64),
		trustZone: "private",
		observedAt: "2026-08-31T00:00:00Z",
		expiresAt: "2026-08-31T01:00:00Z",
		interactive: false,
		activeInteractiveUser: false,
		draining: false,
		healthy: true,
		capabilities: ["container", "bun"],
		executionProfiles: ["ompk-safe"],
		availableSlots: 1,
		cpuPressure: 0.2,
		memoryPressure: 0.2,
		estimatedCostUsd: 0.1,
		...overrides,
	};
}

const NOW = Date.parse("2026-08-31T00:30:00Z");

describe("capability-aware placement", () => {
	test("chooses the same worker regardless of candidate enumeration order", () => {
		const taskContract = task();
		const first = node({ nodeId: "node_mesh-a", cpuPressure: 0.1, memoryPressure: 0.1 });
		const second = node({ nodeId: "node_mesh-b", cpuPressure: 0.1, memoryPressure: 0.1 });

		const forward = placeTask({ task: taskContract, nodes: [second, first], nowEpochMs: NOW });
		const reverse = placeTask({ task: taskContract, nodes: [first, second], nowEpochMs: NOW });

		expect(forward.selectedNodeId).toBe("node_mesh-a");
		expect(reverse.selectedNodeId).toBe("node_mesh-a");
		expect(forward.placementReason).toContain("lowest_deterministic_score");
	});

	test("keeps an actively used interactive machine protected even when the task permits it", () => {
		const decision = placeTask({
			task: task({ activeMachineAllowed: true }),
			nodes: [node({ interactive: true, activeInteractiveUser: true })],
			nowEpochMs: NOW,
		});

		expect(decision.selectedNodeId).toBeUndefined();
		expect(decision.evaluations[0]?.reasons).toContain("active_interactive_node_protected");
	});

	test("rejects a node that cannot satisfy the required capability set", () => {
		const decision = placeTask({
			task: task(),
			nodes: [node({ capabilities: ["shell"] })],
			nowEpochMs: NOW,
		});

		expect(decision.selectedNodeId).toBeUndefined();
		expect(decision.evaluations[0]?.reasons).toContain("missing_capabilities");
	});

	test("requires an integral durable worker-slot count", () => {
		const decision = placeTask({
			task: task(),
			nodes: [node({ availableSlots: 1.5 })],
			nowEpochMs: NOW,
		});

		expect(decision.selectedNodeId).toBeUndefined();
		expect(decision.evaluations[0]?.reasons).toContain("no_available_slots");
	});

	test("rejects a future-dated or inverted presence window", () => {
		const future = placeTask({
			task: task(),
			nodes: [node({ observedAt: "2026-08-31T00:31:00Z" })],
			nowEpochMs: NOW,
		});
		const inverted = placeTask({
			task: task(),
			nodes: [node({ observedAt: "2026-08-31T00:29:00Z", expiresAt: "2026-08-31T00:28:00Z" })],
			nowEpochMs: NOW,
		});

		expect(future.selectedNodeId).toBeUndefined();
		expect(future.evaluations[0]?.reasons).toContain("stale_presence");
		expect(inverted.selectedNodeId).toBeUndefined();
		expect(inverted.evaluations[0]?.reasons).toContain("stale_presence");
		const bypassAttempt = placeTask({
			task: task(),
			nodes: [node({ observedAt: "2026-08-31T00:31:00Z" })],
			nowEpochMs: NOW,
			policy: { requireFreshPresence: false },
		});
		expect(bypassAttempt.selectedNodeId).toBeUndefined();
	});

	test("fails closed for an unknown trust zone", () => {
		const decision = placeTask({
			task: task(),
			nodes: [node({ trustZone: "unknown" as PlacementNode["trustZone"] })],
			nowEpochMs: NOW,
		});

		expect(decision.selectedNodeId).toBeUndefined();
		expect(decision.evaluations[0]?.reasons).toContain("trust_zone_exceeds_task_limit");
	});

	test("treats local as more trusted than private, partner, and public", () => {
		const decision = placeTask({
			task: task({ trustZoneMin: "private" }),
			nodes: [node({ nodeId: "node_public-a", trustZone: "public" }), node({ trustZone: "local" })],
			nowEpochMs: NOW,
		});

		expect(decision.selectedNodeId).toBe("node_mesh-a");
		expect(decision.evaluations.find(evaluation => evaluation.nodeId === "node_public-a")?.reasons).toContain(
			"trust_zone_exceeds_task_limit",
		);
	});
});
