import type { MeshRole, TaskContractV1, TaskMode } from "@pk-nerdsaver-ai/mesh-contracts";
import type { MeshTaskState } from "@pk-nerdsaver-ai/mesh-orchestrator";

export const MESH_CONTROL_API_SCHEMA = "ompk.mesh-control-api/v1" as const;

export type MeshControlAction = "task.submit" | "task.status" | "task.trace";
export type MeshControlAuthorizationOutcome = "allow" | "deny";

/** A local, injected time source keeps durable writes deterministic in tests and embeds no transport behavior. */
export interface MeshControlClock {
	nowEpochMs(): number;
}

/**
 * Signature proof is origin evidence and authorization is a separate local
 * policy decision. Submit requires both an allow outcome and a verified
 * origin signature; read operations require an allow outcome.
 */
export interface MeshControlAuthorizer {
	authorize(request: MeshControlAuthorizationRequest): Promise<MeshControlAuthorizationDecision>;
}

export interface MeshControlAuthorizationRequest {
	readonly action: MeshControlAction;
	readonly requestId: string;
	readonly taskId: string;
	readonly evaluatedAt: string;
	readonly idempotencyKey?: string;
	readonly task?: TaskContractV1;
}

export interface MeshControlAuthorizationDecision {
	readonly outcome: MeshControlAuthorizationOutcome;
	/** Required for task.submit; ignored for reads. */
	readonly signatureVerified?: boolean;
	/** Stable safe-to-expose reason code; arbitrary text is intentionally not accepted. */
	readonly reasonCode?: string;
}

export interface MeshTaskRequesterProjection {
	readonly pubkey: string;
	readonly role: MeshRole;
	readonly nodeId?: string;
}

export interface MeshTaskAcceptanceProjection {
	readonly id: string;
	readonly description: string;
	readonly level: "required" | "advisory" | "negative";
}

/** A small, stable projection that intentionally excludes context, scopes, and secret references. */
export interface MeshTaskProjection {
	readonly schemaVersion: typeof MESH_CONTROL_API_SCHEMA;
	readonly kind: "task";
	readonly taskId: string;
	readonly taskDigest: string;
	readonly idempotencyKey: string;
	readonly sessionId?: string;
	readonly requester: MeshTaskRequesterProjection;
	readonly goal: string;
	readonly mode: TaskMode;
	readonly acceptanceCriteria: readonly MeshTaskAcceptanceProjection[];
	readonly state: MeshTaskState;
	readonly currentAssignmentId?: string;
	readonly latestFencingToken: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface MeshTaskSubmissionProjection {
	readonly schemaVersion: typeof MESH_CONTROL_API_SCHEMA;
	readonly kind: "task_submission";
	readonly task: MeshTaskProjection;
}

export interface MeshTaskStatusProjection {
	readonly schemaVersion: typeof MESH_CONTROL_API_SCHEMA;
	readonly kind: "task_status";
	readonly task: MeshTaskProjection;
}

/**
 * Runtime task rows do not yet expose a durable cursorable event ledger. The
 * trace makes that limit explicit instead of manufacturing a history.
 */
export interface MeshTaskTraceProjection {
	readonly schemaVersion: typeof MESH_CONTROL_API_SCHEMA;
	readonly kind: "task_trace";
	readonly task: MeshTaskProjection;
	readonly trace: Readonly<{
		readonly source: "mesh-orchestrator/runtime-task-record";
		readonly observedAt: string;
		readonly eventHistory: "unavailable";
	}>;
}

export interface MeshControlUnsupportedResult {
	readonly status: "unsupported";
	readonly code: "durable_artifacts_unsupported" | "durable_cancellation_unsupported" | "durable_follow_unsupported";
	readonly reason: string;
	readonly retryable: false;
}

export interface MeshControlApiOptions {
	readonly orchestrator: import("@pk-nerdsaver-ai/mesh-orchestrator").MeshOrchestrator;
	readonly authorizer: MeshControlAuthorizer;
	readonly clock: MeshControlClock;
}
