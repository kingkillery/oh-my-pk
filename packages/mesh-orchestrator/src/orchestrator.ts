import {
	MESH_SCHEMA,
	parseAssignmentLease,
	parseExecutionReceipt,
	parseTaskContract,
	sha256CanonicalJson,
	type AssignmentLeaseV1,
	type ExecutionReceiptV1,
	type JsonRecord,
	type TaskContractV1,
} from "@pk-nerdsaver-ai/mesh-contracts";

import { FencingViolationError, IdempotencyConflictError, SchedulerLeaseConflictError, TransitionViolationError } from "./errors";
import type {
	AssignmentRequest,
	DeliveryAcceptance,
	DeliveryLedgerRecord,
	MeshInboundDelivery,
	MeshOutboxPublisher,
	MeshRuntimeRepository,
	MeshRuntimeSnapshot,
	OutboxDrainResult,
	OutboxMessage,
	ReceiptRequest,
	ReapResult,
	RuntimeAssignmentRecord,
	RuntimeTaskRecord,
	SchedulerLeaseGrant,
	SchedulerLeaseRequest,
} from "./types";

const OUTBOX_LOCK_MS = 30_000;
const OUTBOX_RETRY_DELAY_MS = 1_000;

function iso(now: number): string {
	return new Date(now).toISOString();
}

function asPayload(value: Record<string, string | number>): JsonRecord {
	return value as JsonRecord;
}

function nonEmpty(value: string, name: string): void {
	if (value.length === 0) throw new TypeError(`${name} must not be empty`);
}

function positive(value: number, name: string): void {
	if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive finite number`);
}

function positiveOrInfinity(value: number, name: string): void {
	if ((value !== Number.POSITIVE_INFINITY && !Number.isFinite(value)) || value <= 0) throw new TypeError(`${name} must be positive or Infinity`);
}

function leaseDeadline(lease: AssignmentLeaseV1): number {
	return Date.parse(lease.leaseExpiresAt);
}

function outboundId(aggregateId: string, type: string, ordinal: number): string {
	return `${aggregateId}:${type}:${ordinal}`;
}

function findOutboxByKey(snapshot: MeshRuntimeSnapshot, idempotencyKey: string): OutboxMessage | undefined {
	return Object.values(snapshot.outbox).find(message => message.idempotencyKey === idempotencyKey);
}

function enqueue(snapshot: MeshRuntimeSnapshot, input: {
	readonly type: string;
	readonly aggregateId: string;
	readonly idempotencyKey: string;
	readonly payload: JsonRecord;
	readonly now: number;
}): void {
	if (findOutboxByKey(snapshot, input.idempotencyKey) !== undefined) return;
	const ordinal = Object.keys(snapshot.outbox).length + 1;
	const outboxId = outboundId(input.aggregateId, input.type, ordinal);
	snapshot.outbox[outboxId] = {
		outboxId,
		type: input.type,
		aggregateId: input.aggregateId,
		idempotencyKey: input.idempotencyKey,
		payload: input.payload,
		payloadDigest: sha256CanonicalJson(input.payload),
		state: "pending",
		attempts: 0,
		availableAt: input.now,
	};
}

function assertCurrentScheduler(snapshot: MeshRuntimeSnapshot, assignment: AssignmentLeaseV1, now: number): void {
	if (snapshot.scheduler.ownerId !== assignment.scheduler.pubkey || snapshot.scheduler.leaseExpiresAt <= now) {
		throw new SchedulerLeaseConflictError();
	}
	if (snapshot.scheduler.epoch !== assignment.schedulerEpoch) throw new FencingViolationError(assignment.assignmentId);
}

function assertAssignmentFence(record: RuntimeAssignmentRecord | undefined, receipt: ExecutionReceiptV1, now: number): RuntimeAssignmentRecord {
	if (record === undefined || record.state !== "leased") throw new FencingViolationError(receipt.assignmentId);
	if (
		record.lease.schedulerEpoch !== receipt.schedulerEpoch ||
		record.lease.fencingToken !== receipt.fencingToken ||
		record.lease.taskId !== receipt.taskId ||
		record.lease.taskDigest !== receipt.taskDigest ||
		leaseDeadline(record.lease) <= now
	) {
		throw new FencingViolationError(receipt.assignmentId);
	}
	return record;
}

function taskOutcome(receipt: ExecutionReceiptV1): RuntimeTaskRecord["state"] {
	if (receipt.outcome === "succeeded") return "completed";
	if (receipt.outcome === "cancelled") return "cancelled";
	if (receipt.outcome === "lost" || receipt.outcome === "preempted") return "lost";
	return "failed";
}

/**
 * The control-plane authority. It intentionally owns only durable scheduling
 * decisions and events; worker transports execute commands through adapters.
 */
export class MeshOrchestrator {
	readonly #repository: MeshRuntimeRepository;

	constructor(repository: MeshRuntimeRepository) {
		this.#repository = repository;
	}

	async submitTask(input: TaskContractV1 | unknown, now = Date.now()): Promise<RuntimeTaskRecord> {
		const task = parseTaskContract(input);
		return this.#repository.transaction(({ snapshot }) => {
			const existingById = snapshot.tasks[task.taskId];
			if (existingById !== undefined) {
				if (existingById.task.digest !== task.digest) throw new IdempotencyConflictError(task.taskId);
				return structuredClone(existingById);
			}
			const existingByKey = Object.values(snapshot.tasks).find(record => record.task.idempotencyKey === task.idempotencyKey);
			if (existingByKey !== undefined) {
				if (existingByKey.task.digest !== task.digest) throw new IdempotencyConflictError(task.idempotencyKey);
				return structuredClone(existingByKey);
			}
			const record: RuntimeTaskRecord = {
				task,
				state: "queued",
				latestFencingToken: 0,
				createdAt: iso(now),
				updatedAt: iso(now),
			};
			snapshot.tasks[task.taskId] = record;
			enqueue(snapshot, {
				type: "task.submitted",
				aggregateId: task.taskId,
				idempotencyKey: `task.submitted:${task.taskId}:${task.digest}`,
				payload: asPayload({ taskId: task.taskId, taskDigest: task.digest, schemaVersion: MESH_SCHEMA.task }),
				now,
			});
			return structuredClone(record);
		});
	}

	async acquireSchedulerLease(request: SchedulerLeaseRequest): Promise<SchedulerLeaseGrant> {
		nonEmpty(request.schedulerId, "schedulerId");
		positive(request.durationMs, "durationMs");
		const now = request.now ?? Date.now();
		return this.#repository.transaction(({ snapshot }) => {
			const activeOtherScheduler = snapshot.scheduler.leaseExpiresAt > now && snapshot.scheduler.ownerId !== undefined && snapshot.scheduler.ownerId !== request.schedulerId;
			if (activeOtherScheduler) throw new SchedulerLeaseConflictError();
			if (snapshot.scheduler.ownerId !== request.schedulerId || snapshot.scheduler.leaseExpiresAt <= now) {
				snapshot.scheduler.epoch += 1;
				snapshot.scheduler.ownerId = request.schedulerId;
			}
			snapshot.scheduler.leaseExpiresAt = now + request.durationMs;
			return Object.freeze({
				schedulerId: request.schedulerId,
				epoch: snapshot.scheduler.epoch,
				leaseExpiresAt: iso(snapshot.scheduler.leaseExpiresAt),
			});
		});
	}

	async assign(request: AssignmentRequest): Promise<RuntimeAssignmentRecord> {
		const assignment = parseAssignmentLease(request.assignment);
		const now = request.now ?? Date.now();
		return this.#repository.transaction(({ snapshot }) => {
			assertCurrentScheduler(snapshot, assignment, now);
			const task = snapshot.tasks[assignment.taskId];
			if (task === undefined) throw new TransitionViolationError(assignment.taskId, "missing", "be assigned");
			if (task.state !== "queued") throw new TransitionViolationError(assignment.taskId, task.state, "be assigned");
			if (task.task.digest !== assignment.taskDigest) throw new IdempotencyConflictError(assignment.assignmentId);
			if (leaseDeadline(assignment) <= now) throw new TransitionViolationError(assignment.assignmentId, "expired", "be assigned");
			if (assignment.fencingToken <= task.latestFencingToken) throw new FencingViolationError(assignment.assignmentId);
			const existing = snapshot.assignments[assignment.assignmentId];
			if (existing !== undefined) {
				if (existing.lease.idempotencyKey !== assignment.idempotencyKey) throw new IdempotencyConflictError(assignment.assignmentId);
				return structuredClone(existing);
			}
			const record: RuntimeAssignmentRecord = {
				lease: assignment,
				state: "leased",
				createdAt: iso(now),
				updatedAt: iso(now),
			};
			snapshot.assignments[assignment.assignmentId] = record;
			task.state = "leased";
			task.currentAssignmentId = assignment.assignmentId;
			task.latestFencingToken = assignment.fencingToken;
			task.updatedAt = iso(now);
			enqueue(snapshot, {
				type: "assignment.issued",
				aggregateId: assignment.taskId,
				idempotencyKey: `assignment.issued:${assignment.assignmentId}:${assignment.fencingToken}`,
				payload: asPayload({ assignmentId: assignment.assignmentId, taskId: assignment.taskId, fencingToken: assignment.fencingToken }),
				now,
			});
			return structuredClone(record);
		});
	}

	async recordReceipt(request: ReceiptRequest): Promise<RuntimeAssignmentRecord> {
		const receipt = parseExecutionReceipt(request.receipt);
		const now = request.now ?? Date.now();
		return this.#repository.transaction(({ snapshot }) => {
			const assignment = assertAssignmentFence(snapshot.assignments[receipt.assignmentId], receipt, now);
			if (assignment.receipt !== undefined) {
				if (assignment.receipt.receiptHash !== receipt.receiptHash) throw new IdempotencyConflictError(receipt.receiptId);
				return structuredClone(assignment);
			}
			const task = snapshot.tasks[receipt.taskId];
			if (task === undefined || task.currentAssignmentId !== receipt.assignmentId) throw new FencingViolationError(receipt.assignmentId);
			assignment.receipt = receipt;
			assignment.state = "completed";
			assignment.updatedAt = iso(now);
			task.state = taskOutcome(receipt);
			task.currentAssignmentId = undefined;
			task.updatedAt = iso(now);
			enqueue(snapshot, {
				type: "receipt.recorded",
				aggregateId: receipt.taskId,
				idempotencyKey: `receipt.recorded:${receipt.receiptId}:${receipt.receiptHash}`,
				payload: asPayload({ assignmentId: receipt.assignmentId, receiptId: receipt.receiptId, taskId: receipt.taskId }),
				now,
			});
			return structuredClone(assignment);
		});
	}

	async reap(now = Date.now()): Promise<ReapResult> {
		return this.#repository.transaction(({ snapshot }) => {
			const expiredAssignments: string[] = [];
			const recoveredOutboxMessages: string[] = [];
			for (const assignment of Object.values(snapshot.assignments)) {
				if (assignment.state !== "leased" || leaseDeadline(assignment.lease) > now) continue;
				assignment.state = "expired";
				assignment.updatedAt = iso(now);
				const task = snapshot.tasks[assignment.lease.taskId];
				if (task?.state === "leased" && task.currentAssignmentId === assignment.lease.assignmentId) {
					task.state = "queued";
					task.currentAssignmentId = undefined;
					task.updatedAt = iso(now);
				}
				expiredAssignments.push(assignment.lease.assignmentId);
				enqueue(snapshot, {
					type: "assignment.expired",
					aggregateId: assignment.lease.taskId,
					idempotencyKey: `assignment.expired:${assignment.lease.assignmentId}:${assignment.lease.fencingToken}`,
					payload: asPayload({ assignmentId: assignment.lease.assignmentId, taskId: assignment.lease.taskId, fencingToken: assignment.lease.fencingToken }),
					now,
				});
			}
			for (const message of Object.values(snapshot.outbox)) {
				if (message.state !== "in_flight" || message.lockedUntil === undefined || message.lockedUntil > now) continue;
				message.state = "pending";
				message.claimToken = undefined;
				message.lockedUntil = undefined;
				message.availableAt = now;
				recoveredOutboxMessages.push(message.outboxId);
			}
			const schedulerLeaseExpired = snapshot.scheduler.ownerId !== undefined && snapshot.scheduler.leaseExpiresAt <= now;
			if (schedulerLeaseExpired) snapshot.scheduler.ownerId = undefined;
			return Object.freeze({
				expiredAssignments: Object.freeze(expiredAssignments),
				recoveredOutboxMessages: Object.freeze(recoveredOutboxMessages),
				schedulerLeaseExpired,
			});
		});
	}

	async drainOutbox(publisher: MeshOutboxPublisher, options?: { readonly now?: number; readonly max?: number }): Promise<OutboxDrainResult> {
		const now = options?.now ?? Date.now();
		const max = options?.max ?? Number.POSITIVE_INFINITY;
		positiveOrInfinity(max, "max");
		const published: string[] = [];
		const failed: string[] = [];
		while (published.length + failed.length < max) {
			const claimed = await this.#claimNextOutbox(now);
			if (claimed === undefined) break;
			try {
				await publisher.publish(claimed.message);
				await this.#markOutboxPublished(claimed.message.outboxId, claimed.claimToken, now);
				published.push(claimed.message.outboxId);
			} catch {
				await this.#releaseOutboxClaim(claimed.message.outboxId, claimed.claimToken, now);
				failed.push(claimed.message.outboxId);
			}
		}
		return Object.freeze({ published: Object.freeze(published), failed: Object.freeze(failed) });
	}

	async acceptDelivery(delivery: MeshInboundDelivery): Promise<DeliveryAcceptance> {
		nonEmpty(delivery.messageId, "messageId");
		nonEmpty(delivery.idempotencyKey, "idempotencyKey");
		const payloadDigest = sha256CanonicalJson(delivery.payload);
		const receivedAt = delivery.receivedAt ?? iso(Date.now());
		return this.#repository.transaction(({ snapshot }) => {
			const existing = snapshot.deliveries[delivery.idempotencyKey];
			if (existing !== undefined) {
				if (existing.payloadDigest !== payloadDigest) throw new IdempotencyConflictError(delivery.idempotencyKey);
				return Object.freeze({ status: "duplicate" as const, record: structuredClone(existing) });
			}
			const record: DeliveryLedgerRecord = {
				idempotencyKey: delivery.idempotencyKey,
				messageId: delivery.messageId,
				payloadDigest,
				receivedAt,
			};
			snapshot.deliveries[delivery.idempotencyKey] = record;
			return Object.freeze({ status: "accepted" as const, record: structuredClone(record) });
		});
	}

	async getTask(taskId: string): Promise<RuntimeTaskRecord | undefined> {
		return this.#repository.read(snapshot => {
			const record = snapshot.tasks[taskId];
			return record === undefined ? undefined : structuredClone(record);
		});
	}

	async #claimNextOutbox(now: number): Promise<{ readonly message: OutboxMessage; readonly claimToken: string } | undefined> {
		return this.#repository.transaction(({ snapshot }) => {
			const message = Object.values(snapshot.outbox)
				.filter(candidate => candidate.state === "pending" && candidate.availableAt <= now)
				.sort((left, right) => left.availableAt - right.availableAt || left.outboxId.localeCompare(right.outboxId))[0];
			if (message === undefined) return undefined;
			message.state = "in_flight";
			message.attempts += 1;
			message.lockedUntil = now + OUTBOX_LOCK_MS;
			const claimToken = `${message.outboxId}:${message.attempts}`;
			message.claimToken = claimToken;
			return Object.freeze({ message: structuredClone(message), claimToken });
		});
	}

	async #markOutboxPublished(outboxId: string, claimToken: string, now: number): Promise<void> {
		await this.#repository.transaction(({ snapshot }) => {
			const message = snapshot.outbox[outboxId];
			if (message?.state !== "in_flight" || message.claimToken !== claimToken) return;
			message.state = "published";
			message.publishedAt = iso(now);
			message.lockedUntil = undefined;
			message.claimToken = undefined;
		});
	}

	async #releaseOutboxClaim(outboxId: string, claimToken: string, now: number): Promise<void> {
		await this.#repository.transaction(({ snapshot }) => {
			const message = snapshot.outbox[outboxId];
			if (message?.state !== "in_flight" || message.claimToken !== claimToken) return;
			message.state = "pending";
			message.availableAt = now + OUTBOX_RETRY_DELAY_MS;
			message.lockedUntil = undefined;
			message.claimToken = undefined;
		});
	}
}
