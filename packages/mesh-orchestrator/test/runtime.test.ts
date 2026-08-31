import { describe, expect, test } from "bun:test";
import { MESH_SCHEMA, contractDigest, parseTaskContract, sha256CanonicalJson, type JsonRecord, type TaskContractV1 } from "@pk-nerdsaver-ai/mesh-contracts";

import { FencingViolationError, InMemoryMeshRuntimeRepository, MeshOrchestrator } from "../src";

const T0 = Date.parse("2026-08-31T12:00:00.000Z");
const SCHEDULER_KEY = "scheduler-public-key-001";
const WORKER_KEY = "worker-public-key-000001";

function iso(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

function digest(value: Record<string, unknown>, field: string): string {
	return contractDigest(value as unknown as JsonRecord, field);
}

function task(idempotencyKey = "task-submit-001"): TaskContractV1 {
	const body = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_mesh-runtime",
		createdAt: iso(0),
		requester: { pubkey: "human-public-key-000001", role: "human" },
		goal: "Prove the durable control-plane contract",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "runtime-safe", description: "Fenced state changes survive restart", level: "required" }],
		permissions: { tools: ["test"], externalSideEffects: "none" },
		execution: {},
		routing: { activeMachineAllowed: false },
		artifactPolicy: { encryptionRequired: true },
		idempotencyKey,
		digestAlgorithm: "sha256" as const,
	};
	return parseTaskContract({ ...body, digest: digest(body, "digest") });
}

function assignment(taskContract: TaskContractV1, options: { readonly id: string; readonly epoch: number; readonly fence: number; readonly expiresAt: number }) {
	return {
		schemaVersion: MESH_SCHEMA.assignment,
		assignmentId: options.id,
		taskId: taskContract.taskId,
		taskDigest: taskContract.digest,
		scheduler: { pubkey: SCHEDULER_KEY, role: "scheduler" },
		schedulerEpoch: options.epoch,
		fencingToken: options.fence,
		workerNodeId: "node_runtime-worker",
		executorPubkey: WORKER_KEY,
		executionProfileId: "test-profile",
		issuedAt: iso(0),
		leaseExpiresAt: iso(options.expiresAt),
		renewAfterSeconds: 10,
		permissionsDigest: sha256CanonicalJson({ tools: ["test"] }),
		placementReason: { activeMachineAllowed: false },
		idempotencyKey: `assignment-${options.id}`,
	};
}

function receipt(taskContract: TaskContractV1, assignmentId: string, epoch: number, fence: number) {
	const body = {
		schemaVersion: MESH_SCHEMA.receipt,
		receiptId: `rcpt_${assignmentId.slice(4)}`,
		taskId: taskContract.taskId,
		taskDigest: taskContract.digest,
		assignmentId,
		schedulerEpoch: epoch,
		fencingToken: fence,
		worker: { pubkey: WORKER_KEY, role: "worker", nodeId: "node_runtime-worker" },
		nodeId: "node_runtime-worker",
		startedAt: iso(10),
		endedAt: iso(20),
		outcome: "succeeded" as const,
		execution: {},
		artifacts: [],
		evidence: [],
		validation: {},
		resourceUsage: {},
		cost: {},
		cleanup: {},
	};
	return { ...body, receiptHash: digest(body, "receiptHash") };
}

describe("MeshOrchestrator durable authority", () => {
	test("deduplicates inbound delivery by idempotency key without replaying effects", async () => {
		const runtime = new MeshOrchestrator(new InMemoryMeshRuntimeRepository());
		const payload = { event: "assignment.issued" } as JsonRecord;

		const first = await runtime.acceptDelivery({ messageId: "relay-msg-1", idempotencyKey: "delivery-001", payload, receivedAt: iso(0) });
		const duplicate = await runtime.acceptDelivery({ messageId: "relay-msg-2", idempotencyKey: "delivery-001", payload, receivedAt: iso(1) });

		expect(first.status).toBe("accepted");
		expect(duplicate.status).toBe("duplicate");
		expect(duplicate.record.messageId).toBe("relay-msg-1");
	});

	test("rejects a receipt from a stale scheduler epoch and fence", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = new MeshOrchestrator(repository);
		const contract = task();
		await runtime.submitTask(contract, T0);
		const firstEpoch = await runtime.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 500, now: T0 });
		const first = assignment(contract, { id: "asg_attempt-one", epoch: firstEpoch.epoch, fence: 1, expiresAt: 500 });
		await runtime.assign({ assignment: first, now: T0 });

		await runtime.reap(T0 + 1_000);
		const secondEpoch = await runtime.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 500, now: T0 + 1_000 });
		const second = assignment(contract, { id: "asg_attempt-two", epoch: secondEpoch.epoch, fence: 2, expiresAt: 1_400 });
		await runtime.assign({ assignment: second, now: T0 + 1_000 });

		await expect(runtime.recordReceipt({ receipt: receipt(contract, first.assignmentId, firstEpoch.epoch, first.fencingToken), now: T0 + 1_001 })).rejects.toBeInstanceOf(FencingViolationError);
	});

	test("recovers a committed task outbox record after a process dies before publication", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		const beforeCrash = new MeshOrchestrator(repository);
		const contract = task("task-crash-001");
		await beforeCrash.submitTask(contract, T0);

		const afterRestart = new MeshOrchestrator(repository);
		const published: string[] = [];
		const result = await afterRestart.drainOutbox(
			{
				async publish(message) {
					published.push(message.type);
				},
			},
			{ now: T0 },
		);

		expect((await afterRestart.getTask(contract.taskId))?.state).toBe("queued");
		expect(published).toEqual(["task.submitted"]);
		expect(result.published).toHaveLength(1);
	});

	test("backs off a failed publish instead of spinning on the same outbox record", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = new MeshOrchestrator(repository);
		await runtime.submitTask(task("task-publisher-failure-001"), T0);
		let attempts = 0;

		const result = await runtime.drainOutbox(
			{
				async publish() {
					attempts += 1;
					throw new Error("relay unavailable");
				},
			},
			{ now: T0 },
		);

		expect(attempts).toBe(1);
		expect(result.failed).toHaveLength(1);
	});
});
