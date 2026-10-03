import { describe, expect, test } from "bun:test";

import {
	MESH_SCHEMA,
	parseAssignmentLease,
	parseTaskContract,
	sha256CanonicalJson,
} from "@pk-nerdsaver-ai/mesh-contracts";
import { createOmpkExecutionAdapter, type OmpkExecutionRequest } from "../src/index";

function task() {
	const unsigned = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_worker-protocol-001",
		createdAt: "2026-08-31T00:00:00Z",
		requester: { pubkey: "f".repeat(64), role: "orchestrator" },
		goal: "Execute a bounded worker protocol test.",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "adapter", description: "OMPK sees a bound request.", level: "required" }],
		permissions: { tools: ["shell"], externalSideEffects: "none" },
		execution: { timeoutSeconds: 60 },
		routing: { requiredCapabilities: ["container"] },
		artifactPolicy: { encryptionRequired: true },
		idempotencyKey: "worker-protocol-001",
		digestAlgorithm: "sha256" as const,
	};
	return parseTaskContract({ ...unsigned, digest: sha256CanonicalJson(unsigned) });
}

describe("OMPK execution adapter", () => {
	test("passes only a lease-bound execution request to the injected local executor", async () => {
		const taskContract = task();
		const assignment = parseAssignmentLease({
			schemaVersion: MESH_SCHEMA.assignment,
			assignmentId: "asg_worker-protocol-001",
			taskId: taskContract.taskId,
			taskDigest: taskContract.digest,
			scheduler: { pubkey: "b".repeat(64), role: "scheduler" },
			schedulerEpoch: 2,
			fencingToken: 7,
			workerNodeId: "node_worker-001",
			executorPubkey: "c".repeat(64),
			executionProfileId: "ompk-safe",
			issuedAt: "2026-08-31T00:00:00Z",
			leaseExpiresAt: "2026-08-31T01:00:00Z",
			renewAfterSeconds: 30,
			permissionsDigest: taskContract.digest,
			placementReason: { source: "targeted-test" },
			idempotencyKey: "assignment-worker-protocol-001",
		});
		let received: OmpkExecutionRequest | undefined;
		const adapter = createOmpkExecutionAdapter(
			{
				async execute(request) {
					received = request;
					return { outcome: "succeeded", summary: "completed", artifactIds: ["art_worker-001"], evidenceIds: [] };
				},
			},
			{ nodeId: "node_worker-001", executorPubkey: "c".repeat(64) },
		);

		const result = await adapter.execute(
			{ task: taskContract, assignment, nowEpochMs: Date.parse("2026-08-31T00:30:00Z") },
			new AbortController().signal,
		);

		expect(received?.fencingToken).toBe(7);
		expect(received?.taskDigest).toBe(taskContract.digest);
		expect(result).toMatchObject({ taskId: taskContract.taskId, assignmentId: assignment.assignmentId, outcome: "succeeded" });
		expect(Object.isFrozen(result.artifactIds)).toBe(true);
	});
});
