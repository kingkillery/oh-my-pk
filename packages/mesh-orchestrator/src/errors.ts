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

export class FencingViolationError extends MeshRuntimeError {
	constructor(assignmentId: string) {
		super(`Assignment ${assignmentId} is no longer the current fenced lease`);
		this.name = "FencingViolationError";
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
