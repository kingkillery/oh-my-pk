import type { AssignmentLeaseV1, JsonRecord, TaskContractV1 } from "@pk-nerdsaver-ai/mesh-contracts";

export type WorkerExecutionOutcome = "succeeded" | "failed" | "cancelled" | "timed_out" | "preempted";

export interface WorkerIdentity {
	readonly nodeId: string;
	readonly executorPubkey: string;
}

/** The only task material an injected OMPK executor receives from the mesh. */
export interface OmpkExecutionRequest {
	readonly taskId: string;
	readonly taskDigest: string;
	readonly assignmentId: string;
	readonly schedulerEpoch: number;
	readonly fencingToken: number;
	readonly leaseExpiresAt: string;
	readonly executionProfileId: string;
	readonly goal: string;
	readonly permissions: TaskContractV1["permissions"];
	readonly execution: TaskContractV1["execution"];
}

export interface OmpkExecutionResult {
	readonly outcome: WorkerExecutionOutcome;
	readonly summary: string;
	readonly artifactIds: readonly string[];
	readonly evidenceIds: readonly string[];
	readonly metadata?: JsonRecord;
}

/**
 * Injection point for OMPK's existing local execution machinery. This SDK does
 * not import or control coding-agent; callers retain its lifecycle ownership.
 */
export interface OmpkExecutionPort {
	execute(request: OmpkExecutionRequest, signal: AbortSignal): Promise<OmpkExecutionResult>;
}

export interface MeshExecutionStart {
	readonly task: TaskContractV1;
	readonly assignment: AssignmentLeaseV1;
	readonly nowEpochMs: number;
}

export interface MeshExecutionResult extends OmpkExecutionResult {
	readonly taskId: string;
	readonly assignmentId: string;
	readonly schedulerEpoch: number;
	readonly fencingToken: number;
}

export interface MeshExecutionAdapter {
	readonly kind: "ompk";
	execute(start: MeshExecutionStart, signal: AbortSignal): Promise<MeshExecutionResult>;
}

export type MeshWorkerProtocolErrorCode =
	| "task_id_mismatch"
	| "task_digest_mismatch"
	| "worker_node_mismatch"
	| "executor_pubkey_mismatch"
	| "lease_expired";

export class MeshWorkerProtocolError extends Error {
	readonly code: MeshWorkerProtocolErrorCode;

	constructor(code: MeshWorkerProtocolErrorCode, message: string) {
		super(message);
		this.name = "MeshWorkerProtocolError";
		this.code = code;
	}
}

function assertExecutionBinding(start: MeshExecutionStart, identity: WorkerIdentity): void {
	const { assignment, task } = start;
	if (assignment.taskId !== task.taskId) {
		throw new MeshWorkerProtocolError("task_id_mismatch", "Assignment taskId does not match the task contract.");
	}
	if (assignment.taskDigest !== task.digest) {
		throw new MeshWorkerProtocolError("task_digest_mismatch", "Assignment task digest does not match the task contract.");
	}
	if (assignment.workerNodeId !== identity.nodeId) {
		throw new MeshWorkerProtocolError("worker_node_mismatch", "Assignment is not bound to this worker node.");
	}
	if (assignment.executorPubkey !== identity.executorPubkey) {
		throw new MeshWorkerProtocolError("executor_pubkey_mismatch", "Assignment is not bound to this executor identity.");
	}
	const leaseExpiresAt = Date.parse(assignment.leaseExpiresAt);
	if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= start.nowEpochMs) {
		throw new MeshWorkerProtocolError("lease_expired", "Assignment lease is expired before execution starts.");
	}
}

function freezeIds(ids: readonly string[]): readonly string[] {
	return Object.freeze([...ids]);
}

/**
 * Creates a thin adapter around an injected OMPK executor. Lease and fencing
 * bindings are checked before the local executor sees any task material.
 */
export function createOmpkExecutionAdapter(port: OmpkExecutionPort, identity: WorkerIdentity): MeshExecutionAdapter {
	return Object.freeze({
		kind: "ompk" as const,
		async execute(start: MeshExecutionStart, signal: AbortSignal): Promise<MeshExecutionResult> {
			assertExecutionBinding(start, identity);
			const { assignment, task } = start;
			const result = await port.execute(
				Object.freeze({
					taskId: task.taskId,
					taskDigest: task.digest,
					assignmentId: assignment.assignmentId,
					schedulerEpoch: assignment.schedulerEpoch,
					fencingToken: assignment.fencingToken,
					leaseExpiresAt: assignment.leaseExpiresAt,
					executionProfileId: assignment.executionProfileId,
					goal: task.goal,
					permissions: task.permissions,
					execution: task.execution,
				}),
				signal,
			);
			return Object.freeze({
				...result,
				artifactIds: freezeIds(result.artifactIds),
				evidenceIds: freezeIds(result.evidenceIds),
				taskId: task.taskId,
				assignmentId: assignment.assignmentId,
				schedulerEpoch: assignment.schedulerEpoch,
				fencingToken: assignment.fencingToken,
			});
		},
	});
}
