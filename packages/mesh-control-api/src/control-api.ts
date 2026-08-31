import { assertMeshId, type TaskContractV1 } from "@pk-nerdsaver-ai/mesh-contracts";
import { verifySignedTaskContract } from "@pk-nerdsaver-ai/mesh-auth";
import { MeshCliApiError } from "@pk-nerdsaver-ai/mesh-cli";
import { IdempotencyConflictError, type MeshOrchestrator, type RuntimeTaskRecord } from "@pk-nerdsaver-ai/mesh-orchestrator";
import type {
	MeshCliApi,
	MeshCliArtifactsRequest,
	MeshCliCancelRequest,
	MeshCliFollowRequest,
	MeshCliStatusRequest,
	MeshCliSubmitRequest,
	MeshCliTraceRequest,
} from "@pk-nerdsaver-ai/mesh-cli";

import {
	MESH_CONTROL_API_SCHEMA,
	type MeshControlApiOptions,
	type MeshControlAuthorizationDecision,
	type MeshControlAuthorizationRequest,
	type MeshControlUnsupportedResult,
	type MeshTaskProjection,
	type MeshTaskStatusProjection,
	type MeshTaskSubmissionProjection,
	type MeshTaskTraceProjection,
} from "./types";

interface ClockReading {
	readonly epochMs: number;
	readonly iso: string;
}

function unsupported(
	code: MeshControlUnsupportedResult["code"],
	reason: string,
): MeshControlUnsupportedResult {
	return Object.freeze({ status: "unsupported" as const, code, reason, retryable: false as const });
}

function safeReasonCode(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-z][a-z0-9_]{2,63}$/.test(value) ? value : undefined;
}

/**
 * An authenticated, transport-free facade over MeshOrchestrator. It owns no
 * network listener, secrets, signature material, or alternative task state.
 */
export class MeshControlApi implements MeshCliApi {
	readonly #orchestrator: MeshOrchestrator;
	readonly #taskEnvelopeVerifier: MeshControlApiOptions["taskEnvelopeVerifier"];
	readonly #authorizer: MeshControlApiOptions["authorizer"];
	readonly #clock: MeshControlApiOptions["clock"];

	constructor(options: MeshControlApiOptions) {
		this.#orchestrator = options.orchestrator;
		this.#taskEnvelopeVerifier = options.taskEnvelopeVerifier;
		this.#authorizer = options.authorizer;
		this.#clock = options.clock;
	}

	async submit(request: MeshCliSubmitRequest): Promise<MeshTaskSubmissionProjection> {
		const task = await this.#parseSubmission(request);
		const now = this.#clockReading();
		await this.#authorize({
			action: "task.submit",
			requestId: request.requestId,
			taskId: task.taskId,
			idempotencyKey: request.idempotencyKey,
			evaluatedAt: now.iso,
			task,
		});
		try {
			const record = await this.#orchestrator.submitTask(task, now.epochMs);
			return Object.freeze({ schemaVersion: MESH_CONTROL_API_SCHEMA, kind: "task_submission", task: projectTask(record) });
		} catch (error) {
			if (error instanceof IdempotencyConflictError) {
				throw new MeshCliApiError("idempotency_conflict", "The idempotency key was already used for a different task.", { retryable: false });
			}
			throw new MeshCliApiError("control_runtime_unavailable", "The local mesh authority is unavailable.", {
				retryable: true,
				unavailable: true,
			});
		}
	}

	async status(request: MeshCliStatusRequest): Promise<MeshTaskStatusProjection> {
		this.#assertNoCursor(request.cursor);
		const taskId = this.#requireTaskId(request.taskId);
		const now = this.#clockReading();
		await this.#authorize({ action: "task.status", requestId: request.requestId, taskId, evaluatedAt: now.iso });
		const task = await this.#task(taskId);
		return Object.freeze({ schemaVersion: MESH_CONTROL_API_SCHEMA, kind: "task_status", task: projectTask(task) });
	}

	async trace(request: MeshCliTraceRequest): Promise<MeshTaskTraceProjection> {
		this.#assertNoCursor(request.cursor);
		const taskId = this.#requireTaskId(request.taskId);
		const now = this.#clockReading();
		await this.#authorize({ action: "task.trace", requestId: request.requestId, taskId, evaluatedAt: now.iso });
		const task = await this.#task(taskId);
		const projection = projectTask(task);
		return Object.freeze({
			schemaVersion: MESH_CONTROL_API_SCHEMA,
			kind: "task_trace",
			task: projection,
			trace: Object.freeze({
				source: "mesh-orchestrator/runtime-task-record" as const,
				observedAt: projection.updatedAt,
				eventHistory: "unavailable" as const,
			}),
		});
	}

	async cancel(_request: MeshCliCancelRequest): Promise<MeshControlUnsupportedResult> {
		void _request;
		return unsupported("durable_cancellation_unsupported", "Durable task cancellation is not implemented by this control runtime.");
	}

	async artifacts(_request: MeshCliArtifactsRequest): Promise<MeshControlUnsupportedResult> {
		void _request;
		return unsupported("durable_artifacts_unsupported", "Durable artifact inspection is not implemented by this control runtime.");
	}

	async follow(_request: MeshCliFollowRequest): Promise<MeshControlUnsupportedResult> {
		void _request;
		return unsupported("durable_follow_unsupported", "Durable task following is not implemented by this control runtime.");
	}

	async #parseSubmission(request: MeshCliSubmitRequest): Promise<TaskContractV1> {
		const verified = await verifySignedTaskContract(request.payload, this.#taskEnvelopeVerifier);
		if (!verified.ok) {
			throw new MeshCliApiError("signature_unverified", "Submit requires a verified signed task envelope.", { retryable: false });
		}
		const task = verified.payload;
		if (task.idempotencyKey !== request.idempotencyKey) {
			throw new MeshCliApiError("idempotency_key_mismatch", "The CLI idempotency key must match the task contract.", { retryable: false });
		}
		return task;
	}

	#clockReading(): ClockReading {
		let epochMs: number;
		try {
			epochMs = this.#clock.nowEpochMs();
		} catch {
			throw new MeshCliApiError("clock_unavailable", "The local control clock is unavailable.", { retryable: true, unavailable: true });
		}
		const date = new Date(epochMs);
		if (!Number.isFinite(epochMs) || Number.isNaN(date.getTime())) {
			throw new MeshCliApiError("clock_invalid", "The local control clock is invalid.", { retryable: false, unavailable: true });
		}
		return Object.freeze({ epochMs, iso: date.toISOString() });
	}

	async #authorize(request: MeshControlAuthorizationRequest): Promise<void> {
		let decision: MeshControlAuthorizationDecision;
		try {
			decision = await this.#authorizer.authorize(request);
		} catch {
			throw new MeshCliApiError("authorization_unavailable", "Local authorization could not be evaluated.", { retryable: true, unavailable: true });
		}
		if (decision === null || typeof decision !== "object" || decision.outcome !== "allow") {
			const code = decision !== null && typeof decision === "object" ? safeReasonCode(decision.reasonCode) : undefined;
			throw new MeshCliApiError(code ?? "authorization_denied", "Local authorization denied the mesh request.", { retryable: false });
		}
	}

	#assertNoCursor(cursor: string | undefined): void {
		if (cursor !== undefined) {
			throw new MeshCliApiError("cursor_unsupported", "Cursored task reads are not implemented by this control runtime.", {
				retryable: false,
				unavailable: true,
			});
		}
	}

	#requireTaskId(value: string | undefined): string {
		if (value === undefined) throw new MeshCliApiError("task_id_required", "A task ID is required for this operation.", { retryable: false });
		try {
			return assertMeshId(value, "task", "$.taskId");
		} catch {
			throw new MeshCliApiError("invalid_task_id", "The supplied task ID is invalid.", { retryable: false });
		}
	}

	async #task(taskId: string): Promise<RuntimeTaskRecord> {
		try {
			const task = await this.#orchestrator.getTask(taskId);
			if (task === undefined) throw new MeshCliApiError("task_not_found", "The requested task is not available.", { retryable: false });
			return task;
		} catch (error) {
			if (error instanceof MeshCliApiError) throw error;
			throw new MeshCliApiError("control_runtime_unavailable", "The local mesh authority is unavailable.", {
				retryable: true,
				unavailable: true,
			});
		}
	}
}

function projectTask(record: RuntimeTaskRecord): MeshTaskProjection {
	const requester = Object.freeze({
		pubkey: record.task.requester.pubkey,
		role: record.task.requester.role,
		...(record.task.requester.nodeId === undefined ? {} : { nodeId: record.task.requester.nodeId }),
	});
	const acceptanceCriteria = Object.freeze(
		record.task.acceptanceCriteria.map(criterion =>
			Object.freeze({ id: criterion.id, description: criterion.description, level: criterion.level }),
		),
	);
	return Object.freeze({
		schemaVersion: MESH_CONTROL_API_SCHEMA,
		kind: "task",
		taskId: record.task.taskId,
		taskDigest: record.task.digest,
		idempotencyKey: record.task.idempotencyKey,
		...(record.task.sessionId === undefined ? {} : { sessionId: record.task.sessionId }),
		requester,
		goal: record.task.goal,
		mode: record.task.mode,
		acceptanceCriteria,
		state: record.state,
		...(record.currentAssignmentId === undefined ? {} : { currentAssignmentId: record.currentAssignmentId }),
		latestFencingToken: record.latestFencingToken,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	});
}

export function createMeshControlApi(options: MeshControlApiOptions): MeshControlApi {
	return new MeshControlApi(options);
}
