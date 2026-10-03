/** Errors expose only stable control-plane identifiers, never task payloads or secrets. */
export class MeshRuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MeshRuntimeError";
	}
}

export class IdempotencyConflictError extends MeshRuntimeError {
	constructor(key: string) {
		super(`Idempotency key ${key} was already accepted with different content`);
		this.name = "IdempotencyConflictError";
	}
}

export class SchedulerLeaseConflictError extends MeshRuntimeError {
	constructor() {
		super("A different scheduler currently owns the active scheduler lease");
		this.name = "SchedulerLeaseConflictError";
	}
}

/** A worker ticket can never survive the scheduler authority that issued it. */
export class AssignmentLeaseAuthorityError extends MeshRuntimeError {
	constructor() {
		super("An assignment lease must expire before its scheduler authority lease");
		this.name = "AssignmentLeaseAuthorityError";
	}
}

export class FencingViolationError extends MeshRuntimeError {
	constructor(assignmentId: string) {
		super(`Assignment ${assignmentId} is no longer the current fenced lease`);
		this.name = "FencingViolationError";
	}
}

export class WorkerCapacityConflictError extends MeshRuntimeError {
	constructor(workerNodeId: string) {
		super(`Worker ${workerNodeId} has no durable execution capacity available`);
		this.name = "WorkerCapacityConflictError";
	}
}

export type WorkerCapacityObservationErrorCode =
	| "capacity_observation_conflict"
	| "capacity_observation_stale"
	| "capacity_observation_unavailable";

/** A capacity fact could not safely become (or remain) authoritative. */
export class WorkerCapacityObservationError extends MeshRuntimeError {
	readonly code: WorkerCapacityObservationErrorCode;

	constructor(code: WorkerCapacityObservationErrorCode) {
		super(`Worker capacity observation was denied: ${code}`);
		this.name = "WorkerCapacityObservationError";
		this.code = code;
	}
}

export type ReceiptFinalizationErrorCode =
	| "invalid_signed_receipt"
	| "receipt_clock_unavailable"
	| "receipt_signature_unverified"
	| "receipt_verifier_unavailable"
	| "receipt_worker_mismatch"
	| "receipt_node_mismatch"
	| "receipt_worker_node_mismatch";

/** A safe receipt-finalization denial that deliberately exposes no receipt or key material. */
export class ReceiptFinalizationError extends MeshRuntimeError {
	readonly code: ReceiptFinalizationErrorCode;

	constructor(code: ReceiptFinalizationErrorCode) {
		super(`Execution receipt finalization was denied: ${code}`);
		this.name = "ReceiptFinalizationError";
		this.code = code;
	}
}

export class TransitionViolationError extends MeshRuntimeError {
	constructor(subject: string, state: string, operation: string) {
		super(`${subject} cannot ${operation} while in ${state}`);
		this.name = "TransitionViolationError";
	}
}

/**
 * The durable state document was present but cannot safely be interpreted.
 * Callers must repair or restore the database; this adapter never replaces a
 * suspect document with an empty authority state.
 */
export class MeshRuntimeCorruptionError extends MeshRuntimeError {
	constructor(reason: string) {
		super(`Mesh runtime durable state is corrupt: ${reason}`);
		this.name = "MeshRuntimeCorruptionError";
	}
}
