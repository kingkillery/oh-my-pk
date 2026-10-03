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
import { parseSignedMeshEnvelope } from "@pk-nerdsaver-ai/mesh-auth";
import { verifySignedExecutionReceipt, type ReceiptSignatureVerifier } from "@pk-nerdsaver-ai/mesh-receipts";

import {
	AssignmentLeaseAuthorityError,
	FencingViolationError,
	IdempotencyConflictError,
	ReceiptFinalizationError,
	SchedulerLeaseConflictError,
	TransitionViolationError,
	WorkerCapacityConflictError,
	WorkerCapacityObservationError,
} from "./errors";
import type {
	AssignmentRequest,
	DeliveryAcceptance,
	DeliveryLedgerRecord,
	MeshInboundDelivery,
	MeshOrchestratorOptions,
	MeshOutboxPublisher,
	MeshRuntimeRepository,
	MeshRuntimeSnapshot,
	OutboxDrainResult,
	OutboxMessage,
	ReceiptRequest,
	ReapResult,
	RuntimeAssignmentDelivery,
	RuntimeAssignmentDeliveryRecovery,
	RuntimeAssignmentRecord,
	RuntimeTaskRecord,
	SchedulerLeaseGrant,
	SchedulerLeaseRequest,
	WorkerCapacityObservation,
	WorkerCapacityObservationRequest,
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

function nonNegativeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
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
	if (leaseDeadline(assignment) >= snapshot.scheduler.leaseExpiresAt) throw new AssignmentLeaseAuthorityError();
}

function sameCapacityObservation(left: WorkerCapacityObservation, right: WorkerCapacityObservation): boolean {
	return (
		left.actorPubkey === right.actorPubkey &&
		left.availableSlots === right.availableSlots &&
		left.observedAt === right.observedAt &&
		left.expiresAt === right.expiresAt
	);
}

function currentWorkerCapacity(snapshot: MeshRuntimeSnapshot, assignment: AssignmentLeaseV1, now: number): number {
	const observation = snapshot.workerCapacityObservations[assignment.workerNodeId];
	// Scheduling without a current, identity-bound advertisement is a fail-closed
	// condition. A legacy default capacity could turn an offline worker into a
	// valid target.
	if (observation === undefined) throw new WorkerCapacityObservationError("capacity_observation_unavailable");
	if (
		observation.actorPubkey !== assignment.executorPubkey ||
		observation.observedAt > now ||
		observation.expiresAt <= now
	) {
		throw new WorkerCapacityObservationError("capacity_observation_unavailable");
	}
	return observation.availableSlots;
}

function deliveryIdempotencyKey(assignment: AssignmentLeaseV1): string {
	return `assignment.delivery:${assignment.assignmentId}:${assignment.fencingToken}`;
}

function deliveryFor(
	input: { readonly task: unknown; readonly signedAssignment: unknown; readonly idempotencyKey?: unknown },
	assignment: AssignmentLeaseV1,
): RuntimeAssignmentDelivery {
	try {
		const task = parseTaskContract(input.task);
		const signedAssignment = parseSignedMeshEnvelope(input.signedAssignment);
		const signedLease = parseAssignmentLease(signedAssignment.payload);
		if (
			sha256CanonicalJson(signedLease) !== sha256CanonicalJson(assignment) ||
			task.taskId !== assignment.taskId ||
			task.digest !== assignment.taskDigest ||
			task.execution.profileId !== assignment.executionProfileId ||
			sha256CanonicalJson(task.permissions) !== assignment.permissionsDigest
		) {
			throw new Error("assignment delivery binding mismatch");
		}
		const idempotencyKey = deliveryIdempotencyKey(assignment);
		if (input.idempotencyKey !== undefined && input.idempotencyKey !== idempotencyKey) {
			throw new Error("assignment delivery idempotency mismatch");
		}
		return Object.freeze({
			task,
			signedAssignment: signedAssignment as RuntimeAssignmentDelivery["signedAssignment"],
			idempotencyKey,
		});
	} catch {
		throw new TypeError("assignment delivery artifact is invalid");
	}
}

function sameDelivery(left: RuntimeAssignmentDelivery, right: RuntimeAssignmentDelivery): boolean {
	return (
		left.idempotencyKey === right.idempotencyKey &&
		sha256CanonicalJson(left.task) === sha256CanonicalJson(right.task) &&
		sha256CanonicalJson(left.signedAssignment) === sha256CanonicalJson(right.signedAssignment)
	);
}

function assertExactCurrentAssignment(snapshot: MeshRuntimeSnapshot, record: RuntimeAssignmentRecord, now: number): RuntimeTaskRecord {
	const assignment = record.lease;
	assertCurrentScheduler(snapshot, assignment, now);
	const task = snapshot.tasks[assignment.taskId];
	if (
		record.state !== "leased" ||
		task === undefined ||
		task.state !== "leased" ||
		task.currentAssignmentId !== assignment.assignmentId ||
		task.latestFencingToken !== assignment.fencingToken ||
		leaseDeadline(assignment) <= now
	) {
		throw new FencingViolationError(assignment.assignmentId);
	}
	if (currentWorkerCapacity(snapshot, assignment, now) < 1) {
		throw new WorkerCapacityConflictError(assignment.workerNodeId);
	}
	return task;
}

function assertAssignmentFence(snapshot: MeshRuntimeSnapshot, record: RuntimeAssignmentRecord | undefined, receipt: ExecutionReceiptV1, now: number): RuntimeAssignmentRecord {
	if (record === undefined || record.state !== "leased") throw new FencingViolationError(receipt.assignmentId);
	if (
		snapshot.scheduler.epoch !== receipt.schedulerEpoch ||
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

function assertReceiptExecutorBinding(assignment: RuntimeAssignmentRecord, receipt: ExecutionReceiptV1): void {
	if (receipt.worker.role !== "worker" || receipt.worker.pubkey !== assignment.lease.executorPubkey) {
		throw new ReceiptFinalizationError("receipt_worker_mismatch");
	}
	if (receipt.nodeId !== assignment.lease.workerNodeId) {
		throw new ReceiptFinalizationError("receipt_node_mismatch");
	}
	if (receipt.worker.nodeId !== receipt.nodeId) {
		throw new ReceiptFinalizationError("receipt_worker_node_mismatch");
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function receiptCandidate(value: unknown): unknown {
	if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "receipt")) {
		throw new ReceiptFinalizationError("invalid_signed_receipt");
	}
	return value.receipt;
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
	readonly #receiptVerifierResolver: MeshOrchestratorOptions["receiptVerifierResolver"];
	readonly #clock: MeshOrchestratorOptions["clock"];

	constructor(repository: MeshRuntimeRepository, options: MeshOrchestratorOptions) {
		this.#repository = repository;
		this.#receiptVerifierResolver = options.receiptVerifierResolver;
		this.#clock = options.clock;
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
		return this.#repository.transaction(({ snapshot }) => {
			// The repository may wait for an earlier durable transaction. Read trusted
			// time only after it has admitted this authority-changing operation.
			const now = this.#authorityClockNow(request.now);
			const activeOtherScheduler = snapshot.scheduler.leaseExpiresAt > now && snapshot.scheduler.ownerId !== undefined && snapshot.scheduler.ownerId !== request.schedulerId;
			if (activeOtherScheduler) throw new SchedulerLeaseConflictError();
			const continuingOwner = snapshot.scheduler.ownerId === request.schedulerId && snapshot.scheduler.leaseExpiresAt > now;
			if (!continuingOwner) {
				snapshot.scheduler.epoch += 1;
				snapshot.scheduler.ownerId = request.schedulerId;
				snapshot.scheduler.leaseExpiresAt = now + request.durationMs;
			} else {
				// An older-but-valid coordinator must never shorten a live authority lease.
				snapshot.scheduler.leaseExpiresAt = Math.max(snapshot.scheduler.leaseExpiresAt, now + request.durationMs);
			}
			return Object.freeze({
				schedulerId: request.schedulerId,
				epoch: snapshot.scheduler.epoch,
				leaseExpiresAt: iso(snapshot.scheduler.leaseExpiresAt),
			});
		});
	}

	/** Read-only scheduler authority used to fail closed before re-signing a recovered lease. */
	async getSchedulerLease(): Promise<SchedulerLeaseGrant | undefined> {
		return this.#repository.read(snapshot => {
			if (snapshot.scheduler.ownerId === undefined) return undefined;
			return Object.freeze({
				schedulerId: snapshot.scheduler.ownerId,
				epoch: snapshot.scheduler.epoch,
				leaseExpiresAt: iso(snapshot.scheduler.leaseExpiresAt),
			});
		});
	}

	/**
	 * Persist a trusted node-advertised capacity fact before it can authorize an
	 * assignment. Older facts, including an older larger capacity, never replace
	 * the latest observation. A zero-slot observation is valid and closes a
	 * worker's durable admission window.
	 */
	async observeWorkerCapacity(request: WorkerCapacityObservationRequest): Promise<WorkerCapacityObservation> {
		nonEmpty(request.workerNodeId, "workerNodeId");
		nonEmpty(request.actorPubkey, "actorPubkey");
		nonNegativeInteger(request.availableSlots, "availableSlots");
		if (
			!Number.isSafeInteger(request.observedAt) ||
			!Number.isSafeInteger(request.expiresAt) ||
			request.observedAt < 0 ||
			request.expiresAt < 0 ||
			request.expiresAt <= request.observedAt
		) {
			throw new TypeError("capacity observation window is invalid");
		}
		const result = await this.#repository.transaction(({ snapshot }) => {
			const now = this.#authorityClockNow();
			// An older-advertisement expiry is still useful as a newer monotonic
			// deauthorization signal. It may replace a live higher capacity, but it
			// can never authorize a new ticket because assign rejects it below.
			if (request.observedAt > now) {
				throw new WorkerCapacityObservationError("capacity_observation_unavailable");
			}
			const next: WorkerCapacityObservation = {
				actorPubkey: request.actorPubkey,
				availableSlots: request.availableSlots,
				observedAt: request.observedAt,
				expiresAt: request.expiresAt,
			};
			const current = snapshot.workerCapacityObservations[request.workerNodeId];
			if (current !== undefined) {
				if (request.observedAt < current.observedAt) {
					throw new WorkerCapacityObservationError("capacity_observation_stale");
				}
				if (request.observedAt === current.observedAt) {
					if (!sameCapacityObservation(current, next)) {
						// A clock-only ordering key cannot tell which equal-time source is
						// authoritative. Persist a zero-slot quarantine before reporting the
						// conflict so the prior larger capacity cannot remain usable.
						const quarantined: WorkerCapacityObservation = {
							actorPubkey: current.actorPubkey,
							availableSlots: 0,
							observedAt: current.observedAt,
							expiresAt: Math.max(current.expiresAt, next.expiresAt),
						};
						snapshot.workerCapacityObservations[request.workerNodeId] = quarantined;
						return Object.freeze({ observation: structuredClone(quarantined), conflicted: true });
					}
					return Object.freeze({ observation: structuredClone(current), conflicted: false });
				}
			}
			snapshot.workerCapacityObservations[request.workerNodeId] = next;
			return Object.freeze({ observation: structuredClone(next), conflicted: false });
		});
		if (result.conflicted) throw new WorkerCapacityObservationError("capacity_observation_conflict");
		return result.observation;
	}

	async assign(request: AssignmentRequest): Promise<RuntimeAssignmentRecord> {
		const assignment = parseAssignmentLease(request.assignment);
		const delivery = request.delivery === undefined ? undefined : deliveryFor(request.delivery, assignment);
		return this.#repository.transaction(({ snapshot }) => {
			// As above, never validate a ticket against a timestamp captured before a
			// queued durable write obtains its transaction slot.
			const now = this.#authorityClockNow(request.now);
			assertCurrentScheduler(snapshot, assignment, now);
			const existing = snapshot.assignments[assignment.assignmentId];
			if (existing !== undefined) {
				if (sha256CanonicalJson(existing.lease) !== sha256CanonicalJson(assignment)) throw new IdempotencyConflictError(assignment.assignmentId);
				if (delivery !== undefined && (existing.delivery === undefined || !sameDelivery(existing.delivery, delivery))) {
					throw new IdempotencyConflictError(assignment.assignmentId);
				}
				assertExactCurrentAssignment(snapshot, existing, now);
				return structuredClone(existing);
			}
			const task = snapshot.tasks[assignment.taskId];
			if (task === undefined) throw new TransitionViolationError(assignment.taskId, "missing", "be assigned");
			if (task.state !== "queued") throw new TransitionViolationError(assignment.taskId, task.state, "be assigned");
			if (task.task.digest !== assignment.taskDigest) throw new IdempotencyConflictError(assignment.assignmentId);
			if (delivery !== undefined && sha256CanonicalJson(delivery.task) !== sha256CanonicalJson(task.task)) {
				throw new IdempotencyConflictError(assignment.assignmentId);
			}
			if (leaseDeadline(assignment) <= now) throw new TransitionViolationError(assignment.assignmentId, "expired", "be assigned");
			if (assignment.fencingToken <= task.latestFencingToken) throw new FencingViolationError(assignment.assignmentId);
			const workerCapacity = currentWorkerCapacity(snapshot, assignment, now);
			const leasedWorkerAssignments = Object.values(snapshot.assignments).filter(record => record.state === "leased" && record.lease.workerNodeId === assignment.workerNodeId).length;
			if (leasedWorkerAssignments >= workerCapacity) throw new WorkerCapacityConflictError(assignment.workerNodeId);
			const record: RuntimeAssignmentRecord = {
				lease: assignment,
				state: "leased",
				createdAt: iso(now),
				updatedAt: iso(now),
				delivery,
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

	/**
	 * Returns a single durable snapshot of the original delivery artifact only
	 * while the lease remains current. It neither changes authority nor creates
	 * an outbox message, so restart delivery cannot manufacture new work.
	 */
	async recoverAssignmentDelivery(assignmentId: string, now?: number): Promise<RuntimeAssignmentDeliveryRecovery | undefined> {
		nonEmpty(assignmentId, "assignmentId");
		return this.#repository.read(snapshot => {
			const record = snapshot.assignments[assignmentId];
			if (record === undefined || record.delivery === undefined) return undefined;
			const trustedNow = this.#authorityClockNow(now);
			const task = assertExactCurrentAssignment(snapshot, record, trustedNow);
			const delivery = deliveryFor(record.delivery, record.lease);
			if (sha256CanonicalJson(task.task) !== sha256CanonicalJson(delivery.task)) {
				throw new TypeError("persisted assignment delivery task does not match durable task");
			}
			return Object.freeze({
				record: structuredClone(record),
				task: structuredClone(delivery.task),
				signedAssignment: structuredClone(delivery.signedAssignment),
				idempotencyKey: delivery.idempotencyKey,
			});
		});
	}

	async recordReceipt(request: ReceiptRequest): Promise<RuntimeAssignmentRecord> {
		let candidate: ExecutionReceiptV1;
		try {
			candidate = parseExecutionReceipt(receiptCandidate(request.signedReceipt));
		} catch (error) {
			if (error instanceof ReceiptFinalizationError) throw error;
			throw new ReceiptFinalizationError("invalid_signed_receipt");
		}
		const lease = await this.#repository.read(snapshot => snapshot.assignments[candidate.assignmentId]?.lease);
		if (lease === undefined) throw new FencingViolationError(candidate.assignmentId);
		let verifier: ReceiptSignatureVerifier | undefined;
		try {
			verifier = await this.#receiptVerifierResolver.resolve(lease);
		} catch {
			throw new ReceiptFinalizationError("receipt_verifier_unavailable");
		}
		if (verifier === undefined) throw new ReceiptFinalizationError("receipt_verifier_unavailable");
		const verification = await verifySignedExecutionReceipt(request.signedReceipt, verifier);
		if (!verification.ok) throw new ReceiptFinalizationError("receipt_signature_unverified");
		return this.#repository.transaction(({ snapshot }) => {
			const assignmentRecord = snapshot.assignments[candidate.assignmentId];
			if (assignmentRecord === undefined) throw new FencingViolationError(candidate.assignmentId);
			const receipt = verification.receipt;
			assertReceiptExecutorBinding(assignmentRecord, receipt);
			if (assignmentRecord.receipt !== undefined) {
				if (assignmentRecord.receipt.receiptHash !== receipt.receiptHash) throw new IdempotencyConflictError(receipt.receiptId);
				return structuredClone(assignmentRecord);
			}
			const now = this.#receiptClockNow();
			const assignment = assertAssignmentFence(snapshot, assignmentRecord, receipt, now);
			const task = snapshot.tasks[receipt.taskId];
			if (task === undefined || task.currentAssignmentId !== receipt.assignmentId) throw new FencingViolationError(receipt.assignmentId);
			assignment.receipt = receipt;
			assignment.receiptVerification = Object.freeze({
				algorithm: verification.signature.algorithm,
				keyId: verification.signature.keyId,
				workerPubkey: assignment.lease.executorPubkey,
				nodeId: assignment.lease.workerNodeId,
				verifiedAt: iso(now),
				signatureDigest: sha256CanonicalJson(verification.signature),
			});
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

	/** Read-only lease recovery for a caller that already knows the stable assignment ID. */
	async getAssignment(assignmentId: string): Promise<RuntimeAssignmentRecord | undefined> {
		return this.#repository.read(snapshot => {
			const record = snapshot.assignments[assignmentId];
			return record === undefined ? undefined : structuredClone(record);
		});
	}

	#receiptClockNow(): number {
		let now: number;
		try {
			now = this.#clock.nowEpochMs();
		} catch {
			throw new ReceiptFinalizationError("receipt_clock_unavailable");
		}
		if (!Number.isFinite(now)) throw new ReceiptFinalizationError("receipt_clock_unavailable");
		return now;
	}

	/**
	 * `request.now` remains a deterministic lower bound for trusted in-process
	 * callers, but cannot make a queued write evaluate against an older clock.
	 */
	#authorityClockNow(requestedNow?: number): number {
		let durableNow: number;
		try {
			durableNow = this.#clock.nowEpochMs();
		} catch {
			throw new TypeError("Authority clock is unavailable.");
		}
		if (!Number.isFinite(durableNow)) throw new TypeError("Authority clock is unavailable.");
		if (requestedNow === undefined) return durableNow;
		if (!Number.isFinite(requestedNow)) throw new TypeError("now must be a finite epoch-millisecond timestamp.");
		return Math.max(durableNow, requestedNow);
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
