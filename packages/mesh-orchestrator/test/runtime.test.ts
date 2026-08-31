import { describe, expect, test } from "bun:test";
import { MESH_SCHEMA, contractDigest, parseTaskContract, sha256CanonicalJson, type JsonRecord, type TaskContractV1 } from "@pk-nerdsaver-ai/mesh-contracts";
import { signExecutionReceipt, type ReceiptSignatureVerifier } from "@pk-nerdsaver-ai/mesh-receipts";

import { FencingViolationError, InMemoryMeshRuntimeRepository, MeshOrchestrator, ReceiptFinalizationError, type ReceiptVerifierResolver } from "../src";

const T0 = Date.parse("2026-08-31T12:00:00.000Z");
const SCHEDULER_KEY = "scheduler-public-key-001";
const NEXT_SCHEDULER_KEY = "scheduler-public-key-002";
const WORKER_KEY = "worker-public-key-000001";
const RECEIPT_ALGORITHM = "runtime-deterministic-v1";
const RECEIPT_KEY_ID = "runtime-worker-key";
const signatureEncoder = new TextEncoder();
const signatureDecoder = new TextDecoder();

function iso(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

function digest(value: Record<string, unknown>, field: string): string {
	return contractDigest(value as unknown as JsonRecord, field);
}

function receiptSignature(payload: Uint8Array): Uint8Array {
	return signatureEncoder.encode(`${RECEIPT_ALGORITHM}:${RECEIPT_KEY_ID}:${signatureDecoder.decode(payload).split("").reverse().join("")}`);
}

const workerReceiptVerifier: ReceiptSignatureVerifier = Object.freeze({
	algorithm: RECEIPT_ALGORITHM,
	keyId: RECEIPT_KEY_ID,
	verify(payload, signature) {
		const expected = receiptSignature(payload);
		if (expected.byteLength !== signature.byteLength) return false;
		return expected.every((value, index) => value === signature[index]);
	},
});

const receiptVerifierResolver: ReceiptVerifierResolver = Object.freeze({
	resolve(lease) {
		return lease.executorPubkey === WORKER_KEY ? workerReceiptVerifier : undefined;
	},
});

function runtime(repository = new InMemoryMeshRuntimeRepository(), receiptNow = T0 + 10): MeshOrchestrator {
	return new MeshOrchestrator(repository, { receiptVerifierResolver, clock: { nowEpochMs: () => receiptNow } });
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

function receipt(taskContract: TaskContractV1, assignmentId: string, epoch: number, fence: number, overrides: Readonly<Record<string, unknown>> = {}) {
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
		...overrides,
	};
	return { ...body, receiptHash: digest(body, "receiptHash") };
}

async function signedReceipt(receiptValue: unknown) {
	return signExecutionReceipt(receiptValue, {
		algorithm: RECEIPT_ALGORITHM,
		keyId: RECEIPT_KEY_ID,
		sign: receiptSignature,
	});
}

describe("MeshOrchestrator durable authority", () => {
	test("deduplicates inbound delivery by idempotency key without replaying effects", async () => {
		const runtime = new MeshOrchestrator(new InMemoryMeshRuntimeRepository(), { receiptVerifierResolver, clock: { nowEpochMs: () => T0 } });
		const payload = { event: "assignment.issued" } as JsonRecord;

		const first = await runtime.acceptDelivery({ messageId: "relay-msg-1", idempotencyKey: "delivery-001", payload, receivedAt: iso(0) });
		const duplicate = await runtime.acceptDelivery({ messageId: "relay-msg-2", idempotencyKey: "delivery-001", payload, receivedAt: iso(1) });

		expect(first.status).toBe("accepted");
		expect(duplicate.status).toBe("duplicate");
		expect(duplicate.record.messageId).toBe("relay-msg-1");
	});

	test("rejects a receipt from a stale scheduler epoch and fence", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = new MeshOrchestrator(repository, { receiptVerifierResolver, clock: { nowEpochMs: () => T0 + 1_001 } });
		const contract = task();
		await runtime.submitTask(contract, T0);
		const firstEpoch = await runtime.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 500, now: T0 });
		const first = assignment(contract, { id: "asg_attempt-one", epoch: firstEpoch.epoch, fence: 1, expiresAt: 500 });
		await runtime.assign({ assignment: first, now: T0 });

		await runtime.reap(T0 + 1_000);
		const secondEpoch = await runtime.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 500, now: T0 + 1_000 });
		const second = assignment(contract, { id: "asg_attempt-two", epoch: secondEpoch.epoch, fence: 2, expiresAt: 1_400 });
		await runtime.assign({ assignment: second, now: T0 + 1_000 });

		await expect(runtime.recordReceipt({ signedReceipt: await signedReceipt(receipt(contract, first.assignmentId, firstEpoch.epoch, first.fencingToken)) })).rejects.toBeInstanceOf(FencingViolationError);
	});

	test("rejects a valid old-epoch receipt after scheduler leadership turns over", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		const control = new MeshOrchestrator(repository, { receiptVerifierResolver, clock: { nowEpochMs: () => T0 + 201 } });
		const contract = task("task-epoch-turnover-001");
		await control.submitTask(contract, T0);
		const firstEpoch = await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 100, now: T0 });
		const lease = assignment(contract, { id: "asg_epoch-turnover", epoch: firstEpoch.epoch, fence: 1, expiresAt: 2_000 });
		await control.assign({ assignment: lease, now: T0 });
		const secondEpoch = await control.acquireSchedulerLease({ schedulerId: NEXT_SCHEDULER_KEY, durationMs: 1_000, now: T0 + 200 });
		expect(secondEpoch.epoch).toBeGreaterThan(firstEpoch.epoch);

		await expect(control.recordReceipt({ signedReceipt: await signedReceipt(receipt(contract, lease.assignmentId, firstEpoch.epoch, lease.fencingToken)) })).rejects.toBeInstanceOf(
			FencingViolationError,
		);
		expect((await control.getTask(contract.taskId))?.state).toBe("leased");
		expect(await repository.read(snapshot => Object.values(snapshot.outbox).filter(message => message.type === "receipt.recorded"))).toHaveLength(0);
	});

	test("rejects a signed receipt when its lease expires during verification", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		let receiptNow = T0 + 999;
		const delayedResolver: ReceiptVerifierResolver = Object.freeze({
			async resolve() {
				await Promise.resolve();
				receiptNow = T0 + 1_000;
				return workerReceiptVerifier;
			},
		});
		const control = new MeshOrchestrator(repository, { receiptVerifierResolver: delayedResolver, clock: { nowEpochMs: () => receiptNow } });
		const contract = task("task-receipt-verification-expiry-001");
		await control.submitTask(contract, T0);
		const scheduler = await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 2_000, now: T0 });
		const lease = assignment(contract, { id: "asg_receipt-verification-expiry", epoch: scheduler.epoch, fence: 1, expiresAt: 1_000 });
		await control.assign({ assignment: lease, now: T0 });

		await expect(control.recordReceipt({ signedReceipt: await signedReceipt(receipt(contract, lease.assignmentId, scheduler.epoch, lease.fencingToken)) })).rejects.toBeInstanceOf(
			FencingViolationError,
		);
		expect((await control.getTask(contract.taskId))?.state).toBe("leased");
		expect(await repository.read(snapshot => Object.values(snapshot.outbox).filter(message => message.type === "receipt.recorded"))).toHaveLength(0);
	});

	test("finalizes only a lease-bound signed worker receipt and records verification provenance", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		const control = runtime(repository, T0 + 10);
		const contract = task("task-signed-receipt-001");
		await control.submitTask(contract, T0);
		const scheduler = await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 1_000, now: T0 });
		const lease = assignment(contract, { id: "asg_signed-receipt", epoch: scheduler.epoch, fence: 1, expiresAt: 1_000 });
		await control.assign({ assignment: lease, now: T0 });
		const rawReceipt = receipt(contract, lease.assignmentId, scheduler.epoch, lease.fencingToken);

		await expect(control.recordReceipt({ signedReceipt: rawReceipt })).rejects.toMatchObject({
			code: "invalid_signed_receipt",
		} satisfies Partial<ReceiptFinalizationError>);
		const wrongKey = await signExecutionReceipt(rawReceipt, {
			algorithm: RECEIPT_ALGORITHM,
			keyId: "untrusted-worker-key",
			sign: receiptSignature,
		});
		await expect(control.recordReceipt({ signedReceipt: wrongKey })).rejects.toMatchObject({
			code: "receipt_signature_unverified",
		} satisfies Partial<ReceiptFinalizationError>);
		const wrongWorker = await signedReceipt(
			receipt(contract, lease.assignmentId, scheduler.epoch, lease.fencingToken, {
				worker: { pubkey: "x".repeat(64), role: "worker", nodeId: "node_runtime-worker" },
			}),
		);
		await expect(control.recordReceipt({ signedReceipt: wrongWorker })).rejects.toMatchObject({
			code: "receipt_worker_mismatch",
		} satisfies Partial<ReceiptFinalizationError>);
		const wrongNode = await signedReceipt(
			receipt(contract, lease.assignmentId, scheduler.epoch, lease.fencingToken, {
				worker: { pubkey: WORKER_KEY, role: "worker", nodeId: "node_unassigned" },
				nodeId: "node_unassigned",
			}),
		);
		await expect(control.recordReceipt({ signedReceipt: wrongNode })).rejects.toMatchObject({
			code: "receipt_node_mismatch",
		} satisfies Partial<ReceiptFinalizationError>);
		const inconsistentWorkerNode = await signedReceipt(
			receipt(contract, lease.assignmentId, scheduler.epoch, lease.fencingToken, {
				worker: { pubkey: WORKER_KEY, role: "worker", nodeId: "node_unassigned" },
			}),
		);
		await expect(control.recordReceipt({ signedReceipt: inconsistentWorkerNode })).rejects.toMatchObject({
			code: "receipt_worker_node_mismatch",
		} satisfies Partial<ReceiptFinalizationError>);
		expect((await control.getTask(contract.taskId))?.state).toBe("leased");
		expect(await repository.read(snapshot => Object.values(snapshot.outbox).filter(message => message.type === "receipt.recorded"))).toHaveLength(0);

		const accepted = await signedReceipt(rawReceipt);
		const first = await control.recordReceipt({ signedReceipt: accepted });
		const replay = await control.recordReceipt({ signedReceipt: accepted });
		expect(replay).toEqual(first);
		expect(first.receiptVerification).toMatchObject({
			algorithm: RECEIPT_ALGORITHM,
			keyId: RECEIPT_KEY_ID,
			workerPubkey: WORKER_KEY,
			nodeId: "node_runtime-worker",
		});
		expect((await control.getTask(contract.taskId))?.state).toBe("completed");
		expect(await repository.read(snapshot => Object.values(snapshot.outbox).filter(message => message.type === "receipt.recorded"))).toHaveLength(1);
	});

	test("recovers a committed task outbox record after a process dies before publication", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		const beforeCrash = new MeshOrchestrator(repository, { receiptVerifierResolver, clock: { nowEpochMs: () => T0 } });
		const contract = task("task-crash-001");
		await beforeCrash.submitTask(contract, T0);

		const afterRestart = new MeshOrchestrator(repository, { receiptVerifierResolver, clock: { nowEpochMs: () => T0 } });
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
		const runtime = new MeshOrchestrator(repository, { receiptVerifierResolver, clock: { nowEpochMs: () => T0 } });
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
