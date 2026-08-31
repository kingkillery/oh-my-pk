export type JsonPrimitive = string | number | boolean | null;
export type JsonRecord = Readonly<Record<string, JsonValue>>;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonRecord;

export const MESH_SCHEMA = {
	task: "ompk.task-contract/v1",
	plan: "ompk.reasoning-plan/v1",
	assignment: "ompk.assignment-lease/v1",
	event: "ompk.mesh.event/v1",
	node: "ompk.node-advertisement/v1",
	artifact: "ompk.artifact-manifest/v1",
	checkpoint: "ompk.checkpoint-manifest/v1",
	evidence: "ompk.evidence-record/v1",
	receipt: "ompk.execution-receipt/v1",
	completion: "ompk.completion-decision/v1",
	policyDecision: "ompk.policy-decision/v1",
	approval: "ompk.approval-request/v1",
} as const;

export type MeshSchemaVersion = (typeof MESH_SCHEMA)[keyof typeof MESH_SCHEMA];
export type MeshRole =
	| "human"
	| "orchestrator"
	| "scheduler"
	| "node"
	| "worker"
	| "agent"
	| "tool"
	| "service"
	| "validator";
export type TrustZone = "local" | "private" | "partner" | "public";
export type TaskMode = "fresh_clone" | "portable_handoff" | "general_tool" | "inference" | "scheduled";
export type ExternalSideEffects = "none" | "approval_required" | "preapproved_scoped";
export type ApprovalCategory =
	| "external_side_effect"
	| "privileged_tool"
	| "secret_use"
	| "cost_exception"
	| "trust_downgrade"
	| "publication"
	| "destructive_action";

export interface MeshActor {
	readonly pubkey: string;
	readonly role: MeshRole;
	readonly nodeId?: string;
	readonly delegationId?: string;
}

export interface AcceptanceCriterion {
	readonly id: string;
	readonly description: string;
	readonly level: "required" | "advisory" | "negative";
	readonly evidenceRequired?: readonly string[];
}

export interface TaskPermissions {
	readonly tools: readonly string[];
	readonly secrets?: readonly string[];
	readonly network?: readonly string[];
	readonly filesystem?: readonly string[];
	readonly externalSideEffects: ExternalSideEffects;
}

export interface ExecutionLimits extends JsonRecord {
	readonly profileId?: string;
	readonly timeoutSeconds?: number;
	readonly cpuMax?: number;
	readonly memoryBytesMax?: number;
	readonly diskBytesMax?: number;
	readonly pidMax?: number;
	readonly networkBytesMax?: number;
	readonly retriesMax?: number;
}

export interface RoutingRequirements extends JsonRecord {
	readonly preferredNodes?: readonly string[];
	readonly forbiddenNodes?: readonly string[];
	readonly requiredCapabilities?: readonly string[];
	readonly trustZoneMin?: TrustZone;
	readonly activeMachineAllowed?: boolean;
	readonly costCeilingUsd?: number;
}

export interface ArtifactPolicy extends JsonRecord {
	readonly retentionClass?: string;
	readonly encryptionRequired?: boolean;
	readonly replicasMin?: number;
	readonly allowedContentTypes?: readonly string[];
}

export interface ApprovalPolicy extends JsonRecord {
	readonly requiredFor?: readonly string[];
	readonly approvalTimeoutSeconds?: number;
}

export interface TaskContextItem extends JsonRecord {
	readonly id: string;
	readonly trustClass: "trusted_instruction" | "authorized_context" | "untrusted_source" | "derived_summary" | "secret_reference";
	readonly artifactId?: string;
	readonly uri?: string;
	readonly sha256?: string;
	readonly description?: string;
}

export interface TaskContractV1 extends JsonRecord {
	readonly schemaVersion: typeof MESH_SCHEMA.task;
	readonly taskId: string;
	readonly sessionId?: string;
	readonly createdAt: string;
	readonly requester: MeshActor;
	readonly goal: string;
	readonly mode: TaskMode;
	readonly context?: readonly TaskContextItem[];
	readonly acceptanceCriteria: readonly AcceptanceCriterion[];
	readonly constraints?: JsonRecord;
	readonly permissions: TaskPermissions;
	readonly execution: ExecutionLimits;
	readonly routing: RoutingRequirements;
	readonly artifactPolicy: ArtifactPolicy;
	readonly approvalPolicy?: ApprovalPolicy;
	readonly idempotencyKey: string;
	readonly digestAlgorithm: "sha256";
	readonly digest: string;
}

export interface ReasoningPlanV1 extends JsonRecord {
	readonly schemaVersion: typeof MESH_SCHEMA.plan;
	readonly planId: string;
	readonly taskId: string;
	readonly taskDigest: string;
	readonly createdAt: string;
	readonly planner: MeshActor;
	readonly modules: readonly JsonRecord[];
	readonly planAudit: JsonRecord;
	readonly digestAlgorithm: "sha256";
	readonly digest: string;
}

export interface AssignmentLeaseV1 extends JsonRecord {
	readonly schemaVersion: typeof MESH_SCHEMA.assignment;
	readonly assignmentId: string;
	readonly taskId: string;
	readonly taskDigest: string;
	readonly planId?: string;
	readonly moduleIds?: readonly string[];
	readonly scheduler: MeshActor;
	readonly schedulerEpoch: number;
	readonly fencingToken: number;
	readonly workerNodeId: string;
	readonly executorPubkey: string;
	readonly executionProfileId: string;
	readonly issuedAt: string;
	readonly leaseExpiresAt: string;
	readonly renewAfterSeconds: number;
	readonly permissionsDigest: string;
	readonly placementReason: JsonRecord;
	readonly idempotencyKey: string;
}

export interface EventEnvelopeV1 extends JsonRecord {
	readonly schemaVersion: typeof MESH_SCHEMA.event;
	readonly eventId: string;
	readonly type: string;
	readonly occurredAt: string;
	readonly actor: MeshActor;
	readonly idempotencyKey: string;
	readonly payloadEncoding: "json" | "ciphertext";
	readonly payload?: JsonValue;
	readonly payloadSha256: string;
}

export interface NodeAdvertisementV1 extends JsonRecord {
	readonly schemaVersion: typeof MESH_SCHEMA.node;
	readonly nodeId: string;
	readonly actorPubkey: string;
	readonly generatedAt: string;
	readonly expiresAt: string;
	readonly trustZone: TrustZone;
	readonly interactive: boolean;
	readonly draining: boolean;
	readonly static: JsonRecord;
	readonly dynamic: JsonRecord;
	readonly capabilities: JsonRecord;
	readonly reservations: JsonRecord;
	readonly profileVersion: string;
}

export interface ArtifactManifestV1 extends JsonRecord {
	readonly schemaVersion: typeof MESH_SCHEMA.artifact;
	readonly artifactId: string;
	readonly taskId?: string;
	readonly sessionId?: string;
	readonly createdAt: string;
	readonly createdBy: MeshActor;
	readonly name: string;
	readonly contentType: string;
	readonly sizeBytes: number;
	readonly contentSha256: string;
	readonly encryption: JsonRecord;
	readonly locations: readonly JsonRecord[];
	readonly retention: JsonRecord;
	readonly safety: JsonRecord;
	readonly manifestDigest: string;
}

export interface CheckpointManifestV1 extends JsonRecord {
	readonly schemaVersion: typeof MESH_SCHEMA.checkpoint;
	readonly checkpointId: string;
	readonly workspaceId: string;
	readonly createdAt: string;
	readonly createdBy: MeshActor;
	readonly sourceNodeId: string;
	readonly repository: JsonRecord;
	readonly gitState: JsonRecord;
	readonly files: readonly JsonRecord[];
	readonly excluded: readonly JsonRecord[];
	readonly secretScan: JsonRecord;
	readonly artifactManifestId: string;
	readonly contentDigest: string;
	readonly manifestDigest: string;
}

export interface EvidenceRecordV1 extends JsonRecord {
	readonly schemaVersion: typeof MESH_SCHEMA.evidence;
	readonly evidenceId: string;
	readonly taskId: string;
	readonly criterionIds: readonly string[];
	readonly createdAt: string;
	readonly createdBy: MeshActor;
	readonly claim: string;
	readonly sourceType: string;
	readonly sourceReference: JsonRecord;
	readonly confidence: "direct" | "derived" | "attested";
	readonly digest: string;
}

export interface ExecutionReceiptV1 extends JsonRecord {
	readonly schemaVersion: typeof MESH_SCHEMA.receipt;
	readonly receiptId: string;
	readonly taskId: string;
	readonly taskDigest: string;
	readonly assignmentId: string;
	readonly schedulerEpoch: number;
	readonly fencingToken: number;
	readonly worker: MeshActor;
	readonly nodeId: string;
	readonly startedAt: string;
	readonly endedAt: string;
	readonly outcome: "succeeded" | "failed" | "cancelled" | "timed_out" | "preempted" | "policy_denied" | "lost";
	readonly execution: JsonRecord;
	readonly artifacts: readonly string[];
	readonly evidence: readonly string[];
	readonly validation: JsonRecord;
	readonly resourceUsage: JsonRecord;
	readonly cost: JsonRecord;
	readonly cleanup: JsonRecord;
	readonly receiptHash: string;
}

export interface CompletionDecisionV1 extends JsonRecord {
	readonly schemaVersion: typeof MESH_SCHEMA.completion;
	readonly decisionId: string;
	readonly taskId: string;
	readonly taskDigest: string;
	readonly decidedAt: string;
	readonly decidedBy: MeshActor;
	readonly outcome: "accepted" | "rejected" | "blocked" | "cancelled";
	readonly criterionCoverage: readonly JsonRecord[];
	readonly policyStatus: "passed" | "failed";
	readonly validationStatus: "passed" | "failed" | "not_required";
	readonly cleanupStatus: "verified" | "failed" | "pending" | "not_required";
	readonly unresolvedBlockers: readonly string[];
	readonly finalArtifactIds: readonly string[];
	readonly digest: string;
}

export interface PolicyDecisionV1 extends JsonRecord {
	readonly schemaVersion: typeof MESH_SCHEMA.policyDecision;
	readonly decisionId: string;
	readonly taskId?: string;
	readonly evaluatedAt: string;
	readonly policyBundleDigest: string;
	readonly subject: MeshActor;
	readonly action: string;
	readonly resource: JsonRecord;
	readonly outcome: "allow" | "deny" | "require_approval";
	readonly reasons: readonly string[];
	readonly obligations: readonly JsonRecord[];
	readonly digest: string;
}

export interface ApprovalRequestV1 extends JsonRecord {
	readonly schemaVersion: typeof MESH_SCHEMA.approval;
	readonly approvalId: string;
	readonly taskId: string;
	readonly assignmentId?: string;
	readonly requestedAt: string;
	readonly expiresAt: string;
	readonly requestedBy: MeshActor;
	readonly category: ApprovalCategory;
	readonly summary: string;
	readonly exactAction: JsonRecord;
	readonly parametersDigest: string;
	readonly idempotencyKey: string;
	readonly options: readonly ("approve_once" | "approve_scope" | "edit" | "deny")[];
	readonly risk: JsonRecord;
}

export interface IdentityDelegationV1 extends JsonRecord {
	readonly schemaVersion: "ompk.identity-delegation/v1";
	readonly delegationId: string;
	readonly issuerPubkey: string;
	readonly subjectPubkey: string;
	readonly role: MeshRole;
	readonly allowedActions: readonly string[];
	readonly toolScopes: readonly string[];
	readonly secretScopes: readonly string[];
	readonly repositoryScopes: readonly string[];
	readonly trustZone: TrustZone;
	readonly maxCostUsd?: number;
	readonly notBefore: string;
	readonly expiresAt: string;
	readonly parentDelegationId?: string;
	readonly revocationEpoch: number;
	readonly serial: number;
}

export interface RevocationV1 extends JsonRecord {
	readonly schemaVersion: "ompk.revocation/v1";
	readonly revocationId: string;
	readonly effectiveAt: string;
	readonly reason: string;
	readonly delegationId?: string;
	readonly subjectPubkey?: string;
	readonly serial?: number;
	readonly revocationEpoch?: number;
}

export type MeshContractV1 =
	| TaskContractV1
	| ReasoningPlanV1
	| AssignmentLeaseV1
	| EventEnvelopeV1
	| NodeAdvertisementV1
	| ArtifactManifestV1
	| CheckpointManifestV1
	| EvidenceRecordV1
	| ExecutionReceiptV1
	| CompletionDecisionV1
	| PolicyDecisionV1
	| ApprovalRequestV1;
