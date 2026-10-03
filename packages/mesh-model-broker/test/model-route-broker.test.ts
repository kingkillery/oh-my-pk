import { describe, expect, test } from "bun:test";

import {
	MESH_SCHEMA,
	parseTaskContract,
	sha256CanonicalJson,
	type TaskContractV1,
} from "@pk-nerdsaver-ai/mesh-contracts";
import {
	createModelRouteBroker,
	type OmpkModelRouteRequest,
} from "../src/index";

function task(): TaskContractV1 {
	const unsigned = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_model-route-001",
		createdAt: "2026-08-31T00:00:00Z",
		requester: { pubkey: "f".repeat(64), role: "orchestrator" },
		goal: "Route a coding model without duplicating OMPK policy.",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "route", description: "A model route is recorded.", level: "required" }],
		permissions: { tools: ["shell"], externalSideEffects: "none" },
		execution: { timeoutSeconds: 60 },
		routing: { requiredCapabilities: ["container"], trustZoneMin: "private" },
		artifactPolicy: { encryptionRequired: true },
		idempotencyKey: "model-route-001",
		digestAlgorithm: "sha256" as const,
	};
	return parseTaskContract({ ...unsigned, digest: sha256CanonicalJson(unsigned) });
}

describe("model route broker", () => {
	test("preserves OMPK selection provenance without selecting a replacement model", async () => {
		const calls: OmpkModelRouteRequest[] = [];
		const broker = createModelRouteBroker({
			async resolve(request) {
				calls.push(request);
				return {
					status: "selected" as const,
					providerId: "meshinfer",
					modelId: "qwen3-coder-30b",
					selectionSource: "agent-profile.coding",
					policyRevision: "router-policy-2026-08-31",
				};
			},
		});

		const controller = new AbortController();
		const decision = await broker.route(
			{
				task: task(),
				nodeId: "node_msi-001",
				workloadRole: "coding",
				requestedModel: "pi/task",
				decidedAt: "2026-08-31T00:30:00Z",
			},
			controller.signal,
		);

		expect(calls).toEqual([
			{
				taskId: "task_model-route-001",
				taskDigest: task().digest,
				nodeId: "node_msi-001",
				workloadRole: "coding",
				requestedModel: "pi/task",
			},
		]);
		expect(decision.status).toBe("selected");
		if (decision.status === "selected") {
			expect(decision.providerId).toBe("meshinfer");
			expect(decision.modelId).toBe("qwen3-coder-30b");
			expect(decision.provenance).toEqual({
				authority: "ompk-model-router",
				selectionSource: "agent-profile.coding",
				policyRevision: "router-policy-2026-08-31",
				decidedAt: "2026-08-31T00:30:00Z",
			});
			expect(Object.isFrozen(decision)).toBe(true);
			expect(Object.isFrozen(decision.provenance)).toBe(true);
		}
	});
});
