import { describe, expect, test } from "bun:test";
import { MESH_SCHEMA, contractDigest, parseTaskContract, sha256CanonicalJson, type JsonRecord, type TaskContractV1 } from "@pk-nerdsaver-ai/mesh-contracts";
import { signAssignmentLease, type MeshEnvelopeSigner } from "@pk-nerdsaver-ai/mesh-auth";
import { signExecutionReceipt, type ReceiptSignatureVerifier } from "@pk-nerdsaver-ai/mesh-receipts";

import {
	AssignmentLeaseAuthorityError,
	FencingViolationError,
	IdempotencyConflictError,
	InMemoryMeshRuntimeRepository,
	MeshOrchestrator,
	ReceiptFinalizationError,
	SchedulerLeaseConflictError,
	WorkerCapacityConflictError,
	WorkerCapacityObservationError,
	type ReceiptVerifierResolver,
} from "../src";

const T0 = Date.parse("2026-08-31T12:00:00.000Z");
const SCHEDULER_KEY = "scheduler-public-key-001";
const NEXT_SCHEDULER_KEY = "scheduler-public-key-002";
const WORKER_KEY = "worker-public-key-000001";
const RECEIPT_ALGORITHM = "runtime-deterministic-v1";
const RECEIPT_KEY_ID = "runtime-worker-key";
const SCHEDULER_ALGORITHM = "runtime-scheduler-deterministic-v1";
const SCHEDULER_KEY_ID = "runtime-scheduler-key";
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

function assignmentSignature(payload: Uint8Array): Uint8Array {
	return signatureEncoder.encode(`${SCHEDULER_ALGORITHM}:${SCHEDULER_KEY_ID}:${signatureDecoder.decode(payload).split("").reverse().join("")}`);
}

const schedulerSigner: MeshEnvelopeSigner = Object.freeze({
	algorithm: SCHEDULER_ALGORITHM,
	keyId: SCHEDULER_KEY_ID,
	actorPubkey: SCHEDULER_KEY,
	role: "scheduler",
	sign: assignmentSignature,
});

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

function task(idempotencyKey = "task-submit-001", execution: TaskContractV1["execution"] = {}): TaskContractV1 {
	const body = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_mesh-runtime",
		createdAt: iso(0),
		requester: { pubkey: "human-public-key-000001", role: "human" },
		goal: "Prove the durable control-plane contract",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "runtime-safe", description: "Fenced state changes survive restart", level: "required" }],
		permissions: { tools: ["test"], externalSideEffects: "none" },
		execution,
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
		permissionsDigest: sha256CanonicalJson(taskContract.permissions),
		placementReason: { activeMachineAllowed: false },
		idempotencyKey: `assignment-${options.id}`,
	};
}

async function observeAssignmentWorker(control: MeshOrchestrator, lease: { readonly workerNodeId: string; readonly executorPubkey: string }, observedAt = T0): Promise<void> {
	await control.observeWorkerCapacity({
		workerNodeId: lease.workerNodeId,
		actorPubkey: lease.executorPubkey,
		availableSlots: 1,
		observedAt,
		expiresAt: T0 + 1_000_000,
	});
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

	test("replays only an exact current assignment without a second issuance fact", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		const control = runtime(repository);
		const contract = task("task-assignment-replay-001");
		await control.submitTask(contract, T0);
		const scheduler = await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 2_000, now: T0 });
		const lease = assignment(contract, { id: "asg_assignment-replay", epoch: scheduler.epoch, fence: 1, expiresAt: 1_000 });
		await observeAssignmentWorker(control, lease);

		const [first, replay] = await Promise.all([
			control.assign({ assignment: lease, now: T0 }),
			control.assign({ assignment: structuredClone(lease), now: T0 }),
		]);
		expect(replay).toEqual(first);
		expect(await repository.read(snapshot => Object.values(snapshot.outbox).filter(message => message.type === "assignment.issued"))).toHaveLength(1);

		for (const changedLease of [
			{ ...lease, workerNodeId: "node_other-worker" },
			{ ...lease, leaseExpiresAt: iso(1_500) },
			{ ...lease, fencingToken: 2 },
		]) {
			await expect(control.assign({ assignment: changedLease, now: T0 })).rejects.toBeInstanceOf(IdempotencyConflictError);
		}
		expect(await repository.read(snapshot => snapshot.assignments[lease.assignmentId]?.lease)).toEqual(lease);
		expect(await repository.read(snapshot => Object.values(snapshot.outbox).filter(message => message.type === "assignment.issued"))).toHaveLength(1);
	});

	test("atomically preserves the exact signed delivery artifact for read-only recovery", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		const control = runtime(repository);
		const contract = task("task-assignment-delivery-001", { profileId: "test-profile" });
		await control.submitTask(contract, T0);
		const scheduler = await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 2_000, now: T0 });
		const lease = assignment(contract, { id: "asg_assignment-delivery", epoch: scheduler.epoch, fence: 1, expiresAt: 1_000 });
		await observeAssignmentWorker(control, lease);
		const signedAssignment = await signAssignmentLease(lease, schedulerSigner, { signedAt: iso(0) });

		const issued = await control.assign({ assignment: lease, delivery: { task: contract, signedAssignment }, now: T0 });
		const revisionBeforeRecovery = await repository.read(snapshot => snapshot.revision);
		const recovered = await control.recoverAssignmentDelivery(lease.assignmentId);

		expect(recovered).toEqual({
			record: issued,
			task: contract,
			signedAssignment,
			idempotencyKey: `assignment.delivery:${lease.assignmentId}:${lease.fencingToken}`,
		});
		expect(await repository.read(snapshot => snapshot.revision)).toBe(revisionBeforeRecovery);
		expect(await repository.read(snapshot => Object.values(snapshot.outbox).filter(message => message.type === "assignment.issued"))).toHaveLength(1);

		const differentEnvelope = await signAssignmentLease(lease, schedulerSigner, { signedAt: iso(1) });
		await expect(control.assign({ assignment: lease, delivery: { task: contract, signedAssignment: differentEnvelope }, now: T0 })).rejects.toBeInstanceOf(
			IdempotencyConflictError,
		);
		expect(await repository.read(snapshot => snapshot.revision)).toBe(revisionBeforeRecovery);
	});

	test("fails closed when recovery has no original delivery or current worker capacity", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		const control = runtime(repository);
		const legacyContract = task("task-assignment-delivery-legacy-001");
		await control.submitTask(legacyContract, T0);
		const scheduler = await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 2_000, now: T0 });
		const legacyLease = assignment(legacyContract, { id: "asg_assignment-delivery-legacy", epoch: scheduler.epoch, fence: 1, expiresAt: 1_000 });
		await observeAssignmentWorker(control, legacyLease);
		await control.assign({ assignment: legacyLease, now: T0 });
		expect(await control.recoverAssignmentDelivery(legacyLease.assignmentId)).toBeUndefined();

		const recoveredRepository = new InMemoryMeshRuntimeRepository();
		const recoveredControl = runtime(recoveredRepository);
		const contract = task("task-assignment-delivery-capacity-001", { profileId: "test-profile" });
		await recoveredControl.submitTask(contract, T0);
		const recoveredScheduler = await recoveredControl.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 2_000, now: T0 });
		const lease = assignment(contract, { id: "asg_assignment-delivery-capacity", epoch: recoveredScheduler.epoch, fence: 1, expiresAt: 1_000 });
		await observeAssignmentWorker(recoveredControl, lease);
		const signedAssignment = await signAssignmentLease(lease, schedulerSigner, { signedAt: iso(0) });
		await recoveredControl.assign({ assignment: lease, delivery: { task: contract, signedAssignment }, now: T0 });
		await recoveredControl.observeWorkerCapacity({
			workerNodeId: lease.workerNodeId,
			actorPubkey: lease.executorPubkey,
			availableSlots: 0,
			observedAt: T0 + 1,
			expiresAt: T0 + 1_000_000,
		});

		await expect(recoveredControl.recoverAssignmentDelivery(lease.assignmentId)).rejects.toBeInstanceOf(WorkerCapacityConflictError);
		expect(await recoveredRepository.read(snapshot => Object.values(snapshot.outbox).filter(message => message.type === "assignment.issued"))).toHaveLength(1);
	});

	test("returns an isolated assignment record for exact-current recovery", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		const control = runtime(repository);
		const contract = task("task-assignment-recovery-read-001");
		await control.submitTask(contract, T0);
		const scheduler = await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 2_000, now: T0 });
		const lease = assignment(contract, { id: "asg_assignment-recovery-read", epoch: scheduler.epoch, fence: 1, expiresAt: 1_000 });
		await observeAssignmentWorker(control, lease);
		await control.assign({ assignment: lease, now: T0 });

		const recovered = await control.getAssignment(lease.assignmentId);
		expect(recovered).toMatchObject({ lease, state: "leased" });
		if (recovered === undefined) throw new Error("expected assigned record");
		recovered.state = "fenced";
		expect((await control.getAssignment(lease.assignmentId))?.state).toBe("leased");
		expect(await control.getAssignment("asg_missing-assignment")).toBeUndefined();
	});

	test("rejects assignment replays after ticket expiry or scheduler authority turnover", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		const control = runtime(repository);
		const contract = task("task-assignment-replay-expiry-001");
		await control.submitTask(contract, T0);
		const scheduler = await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 100, now: T0 });
		const lease = assignment(contract, { id: "asg_assignment-replay-scheduler-expiry", epoch: scheduler.epoch, fence: 1, expiresAt: 99 });
		await observeAssignmentWorker(control, lease);
		await control.assign({ assignment: lease, now: T0 });
		await expect(control.assign({ assignment: lease, now: T0 + 101 })).rejects.toBeInstanceOf(FencingViolationError);
		await control.acquireSchedulerLease({ schedulerId: NEXT_SCHEDULER_KEY, durationMs: 1_000, now: T0 + 111 });
		await expect(control.assign({ assignment: lease, now: T0 + 111 })).rejects.toBeInstanceOf(SchedulerLeaseConflictError);

		const expiryRepository = new InMemoryMeshRuntimeRepository();
		const expiryControl = runtime(expiryRepository);
		const secondContract = task("task-assignment-replay-lease-expiry-001");
		await expiryControl.submitTask(secondContract, T0 + 102);
		const activeScheduler = await expiryControl.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 1_000, now: T0 + 102 });
		const expiredLease = assignment(secondContract, { id: "asg_assignment-replay-lease-expiry", epoch: activeScheduler.epoch, fence: 1, expiresAt: 200 });
		await observeAssignmentWorker(expiryControl, expiredLease);
		await expiryControl.assign({ assignment: expiredLease, now: T0 + 102 });
		await expect(expiryControl.assign({ assignment: expiredLease, now: T0 + 201 })).rejects.toBeInstanceOf(FencingViolationError);
		expect(await expiryRepository.read(snapshot => Object.values(snapshot.outbox).filter(message => message.type === "assignment.issued"))).toHaveLength(1);
	});

	test("does not regress a live scheduler lease when the same owner presents an older clock", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		const control = runtime(repository);
		const first = await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 1_000, now: T0 });
		const staleRetry = await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 100, now: T0 - 500 });

		expect(staleRetry.epoch).toBe(first.epoch);
		expect(staleRetry.leaseExpiresAt).toBe(first.leaseExpiresAt);
		expect(await control.getSchedulerLease()).toEqual(first);
	});

	test("keeps an assignment deadline strictly inside its scheduler authority for direct callers", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const control = new MeshOrchestrator(repository, { receiptVerifierResolver, clock: { nowEpochMs: () => now } });
		const contract = task("task-assignment-deadline-authority-001");
		await control.submitTask(contract, now);
		const scheduler = await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 1_000, now });
		const outlivesAuthority = assignment(contract, { id: "asg_assignment-deadline-authority-rejected", epoch: scheduler.epoch, fence: 1, expiresAt: 1_000 });

		await expect(control.assign({ assignment: outlivesAuthority, now })).rejects.toBeInstanceOf(AssignmentLeaseAuthorityError);
		expect((await control.getTask(contract.taskId))?.state).toBe("queued");
		expect(await control.getAssignment(outlivesAuthority.assignmentId)).toBeUndefined();
		expect(await repository.read(snapshot => Object.values(snapshot.outbox).filter(message => message.type === "assignment.issued"))).toHaveLength(0);

		const insideAuthority = assignment(contract, { id: "asg_assignment-deadline-authority-accepted", epoch: scheduler.epoch, fence: 1, expiresAt: 999 });
		await observeAssignmentWorker(control, insideAuthority, now);
		await expect(control.assign({ assignment: insideAuthority, now })).resolves.toMatchObject({ lease: insideAuthority, state: "leased" });
	});

	test("makes worker capacity observations monotonic and equal-time conflicts fail closed", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const control = new MeshOrchestrator(repository, { receiptVerifierResolver, clock: { nowEpochMs: () => now } });
		const current = await control.observeWorkerCapacity({
			workerNodeId: "node_runtime-worker",
			actorPubkey: WORKER_KEY,
			availableSlots: 2,
			observedAt: now,
			expiresAt: now + 1_000,
		});
		expect(current).toEqual({ actorPubkey: WORKER_KEY, availableSlots: 2, observedAt: now, expiresAt: now + 1_000 });

		await expect(
			control.observeWorkerCapacity({
				workerNodeId: "node_runtime-worker",
				actorPubkey: WORKER_KEY,
				availableSlots: 1,
				observedAt: now,
				expiresAt: now + 1_000,
			}),
		).rejects.toEqual(new WorkerCapacityObservationError("capacity_observation_conflict"));
		expect(await repository.read(snapshot => snapshot.workerCapacityObservations["node_runtime-worker"])).toEqual({
			actorPubkey: WORKER_KEY,
			availableSlots: 0,
			observedAt: T0,
			expiresAt: T0 + 1_000,
		});
		now += 1;
		await expect(
			control.observeWorkerCapacity({
				workerNodeId: "node_runtime-worker",
				actorPubkey: WORKER_KEY,
				availableSlots: 1,
				observedAt: T0 - 1,
				expiresAt: T0 + 2_000,
			}),
		).rejects.toEqual(new WorkerCapacityObservationError("capacity_observation_stale"));
		await expect(
			control.observeWorkerCapacity({
				workerNodeId: "node_runtime-worker",
				actorPubkey: WORKER_KEY,
				availableSlots: 0,
				observedAt: now,
				expiresAt: now + 1_000,
			}),
		).resolves.toEqual({ actorPubkey: WORKER_KEY, availableSlots: 0, observedAt: now, expiresAt: now + 1_000 });
	});

	test("requires a live matching capacity observation before a new assignment can commit", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const control = new MeshOrchestrator(repository, { receiptVerifierResolver, clock: { nowEpochMs: () => now } });
		const contract = task("task-capacity-required-001");
		await control.submitTask(contract, now);
		const scheduler = await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 2_000, now });
		const lease = assignment(contract, { id: "asg_capacity-required", epoch: scheduler.epoch, fence: 1, expiresAt: 1_000 });

		await expect(control.assign({ assignment: lease, now })).rejects.toEqual(new WorkerCapacityObservationError("capacity_observation_unavailable"));
		await control.observeWorkerCapacity({
			workerNodeId: lease.workerNodeId,
			actorPubkey: lease.executorPubkey,
			availableSlots: 0,
			observedAt: now,
			expiresAt: now + 1_500,
		});
		await expect(control.assign({ assignment: lease, now })).rejects.toBeInstanceOf(WorkerCapacityConflictError);
		now += 1;
		await control.observeWorkerCapacity({
			workerNodeId: lease.workerNodeId,
			actorPubkey: lease.executorPubkey,
			availableSlots: 1,
			observedAt: now,
			expiresAt: now + 1_500,
		});
		await expect(control.assign({ assignment: lease, now })).resolves.toMatchObject({ state: "leased", lease });
	});

	test("reads authority time after a queued transaction obtains its durable slot", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const control = new MeshOrchestrator(repository, { receiptVerifierResolver, clock: { nowEpochMs: () => now } });
		await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 100, now });

		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const blocker = repository.transaction(async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const takeover = control.acquireSchedulerLease({ schedulerId: NEXT_SCHEDULER_KEY, durationMs: 100, now: T0 });
		now = T0 + 101;
		release.resolve();
		await blocker;
		await expect(takeover).resolves.toMatchObject({ schedulerId: NEXT_SCHEDULER_KEY, epoch: 2 });
	});

	test("refuses a queued assignment after its scheduler authority expires", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const control = new MeshOrchestrator(repository, { receiptVerifierResolver, clock: { nowEpochMs: () => now } });
		const contract = task("task-queued-assignment-expiry-001");
		await control.submitTask(contract, now);
		const scheduler = await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 100, now });
		const lease = assignment(contract, { id: "asg_queued-assignment-expiry", epoch: scheduler.epoch, fence: 1, expiresAt: 99 });

		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const blocker = repository.transaction(async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const pending = control.assign({ assignment: lease, now: T0 });
		now = T0 + 100;
		release.resolve();
		await blocker;
		await expect(pending).rejects.toBeInstanceOf(SchedulerLeaseConflictError);
		expect(await control.getAssignment(lease.assignmentId)).toBeUndefined();
		expect(await repository.read(snapshot => Object.values(snapshot.outbox).filter(message => message.type === "assignment.issued"))).toHaveLength(0);
	});

	test("rejects a receipt from a stale scheduler epoch and fence", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		let now = T0;
		const runtime = new MeshOrchestrator(repository, { receiptVerifierResolver, clock: { nowEpochMs: () => now } });
		const contract = task();
		await runtime.submitTask(contract, T0);
		const firstEpoch = await runtime.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 600, now: T0 });
		const first = assignment(contract, { id: "asg_attempt-one", epoch: firstEpoch.epoch, fence: 1, expiresAt: 500 });
		await observeAssignmentWorker(runtime, first);
		await runtime.assign({ assignment: first, now: T0 });

		await runtime.reap(T0 + 1_000);
		now = T0 + 1_000;
		const secondEpoch = await runtime.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 600, now });
		const second = assignment(contract, { id: "asg_attempt-two", epoch: secondEpoch.epoch, fence: 2, expiresAt: 1_400 });
		await runtime.assign({ assignment: second, now });
		now = T0 + 1_001;

		await expect(runtime.recordReceipt({ signedReceipt: await signedReceipt(receipt(contract, first.assignmentId, firstEpoch.epoch, first.fencingToken)) })).rejects.toBeInstanceOf(FencingViolationError);
	});

	test("rejects a valid old-epoch receipt after scheduler leadership turns over", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		let now = T0;
		const control = new MeshOrchestrator(repository, { receiptVerifierResolver, clock: { nowEpochMs: () => now } });
		const contract = task("task-epoch-turnover-001");
		await control.submitTask(contract, T0);
		const firstEpoch = await control.acquireSchedulerLease({ schedulerId: SCHEDULER_KEY, durationMs: 200, now: T0 });
		const lease = assignment(contract, { id: "asg_epoch-turnover", epoch: firstEpoch.epoch, fence: 1, expiresAt: 199 });
		await observeAssignmentWorker(control, lease);
		await control.assign({ assignment: lease, now: T0 });
		now = T0 + 200;
		const secondEpoch = await control.acquireSchedulerLease({ schedulerId: NEXT_SCHEDULER_KEY, durationMs: 1_000, now });
		expect(secondEpoch.epoch).toBeGreaterThan(firstEpoch.epoch);
		now = T0 + 201;

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
		await observeAssignmentWorker(control, lease);
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
		await observeAssignmentWorker(control, lease);
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
		await expect(control.assign({ assignment: lease, now: T0 + 10 })).rejects.toBeInstanceOf(FencingViolationError);
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
