import { canonicalizeJson, sha256CanonicalJson, toImmutableJson } from "./canonical-json";
import { MeshValidationError, type MeshValidationCode } from "./errors";
import { assertMeshId, type MeshIdKind } from "./id";
import { MESH_SCHEMA, type JsonRecord, type MeshActor, type MeshContractV1, type MeshSchemaVersion } from "./types";
import type {
	ApprovalRequestV1,
	ArtifactManifestV1,
	AssignmentLeaseV1,
	CheckpointManifestV1,
	CompletionDecisionV1,
	EventEnvelopeV1,
	EvidenceRecordV1,
	ExecutionReceiptV1,
	NodeAdvertisementV1,
	PolicyDecisionV1,
	ReasoningPlanV1,
	TaskContractV1,
} from "./types";

type ContractParser<T extends MeshContractV1> = (input: unknown) => T;

interface ContractRule {
	readonly schemaVersion: MeshSchemaVersion;
	readonly required: readonly string[];
	readonly allowed: readonly string[];
	readonly ids: Readonly<Record<string, MeshIdKind>>;
	readonly timestamps: readonly string[];
	readonly sha256: readonly string[];
	readonly strings: readonly string[];
	readonly integers: readonly string[];
	readonly booleans: readonly string[];
	readonly arrays: readonly string[];
	readonly objects: readonly string[];
	readonly actors: readonly string[];
	readonly digestField?: string;
}

const BASE_ACTOR_FIELDS = ["pubkey", "role", "nodeId", "delegationId"] as const;
const ROLES = new Set(["human", "orchestrator", "scheduler", "node", "worker", "agent", "tool", "service", "validator"]);
const TRUST_ZONES = new Set(["local", "private", "partner", "public"]);
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const taskRule: ContractRule = {
	schemaVersion: MESH_SCHEMA.task,
	required: ["schemaVersion", "taskId", "createdAt", "requester", "goal", "mode", "acceptanceCriteria", "permissions", "execution", "routing", "artifactPolicy", "idempotencyKey", "digestAlgorithm", "digest"],
	allowed: ["schemaVersion", "taskId", "sessionId", "createdAt", "requester", "goal", "mode", "context", "acceptanceCriteria", "constraints", "permissions", "execution", "routing", "artifactPolicy", "approvalPolicy", "idempotencyKey", "digestAlgorithm", "digest"],
	ids: { taskId: "task", sessionId: "session" },
	timestamps: ["createdAt"],
	sha256: ["digest"],
	strings: ["goal", "idempotencyKey"],
	integers: [],
	booleans: [],
	arrays: ["context", "acceptanceCriteria"],
	objects: ["permissions", "execution", "routing", "artifactPolicy", "constraints", "approvalPolicy"],
	actors: ["requester"],
	digestField: "digest",
};

const planRule: ContractRule = {
	schemaVersion: MESH_SCHEMA.plan,
	required: ["schemaVersion", "planId", "taskId", "taskDigest", "createdAt", "planner", "modules", "planAudit", "digestAlgorithm", "digest"],
	allowed: ["schemaVersion", "planId", "taskId", "taskDigest", "createdAt", "planner", "summary", "assumptions", "modules", "planAudit", "digestAlgorithm", "digest"],
	ids: { planId: "plan", taskId: "task" },
	timestamps: ["createdAt"], sha256: ["taskDigest", "digest"], strings: ["summary"], integers: [], booleans: [], arrays: ["assumptions", "modules"], objects: ["planAudit"], actors: ["planner"], digestField: "digest",
};

const assignmentRule: ContractRule = {
	schemaVersion: MESH_SCHEMA.assignment,
	required: ["schemaVersion", "assignmentId", "taskId", "taskDigest", "scheduler", "schedulerEpoch", "fencingToken", "workerNodeId", "executorPubkey", "executionProfileId", "issuedAt", "leaseExpiresAt", "renewAfterSeconds", "permissionsDigest", "placementReason", "idempotencyKey"],
	allowed: ["schemaVersion", "assignmentId", "taskId", "taskDigest", "planId", "moduleIds", "scheduler", "schedulerEpoch", "fencingToken", "workerNodeId", "executorPubkey", "executionProfileId", "issuedAt", "leaseExpiresAt", "renewAfterSeconds", "permissionsDigest", "placementReason", "idempotencyKey"],
	ids: { assignmentId: "assignment", taskId: "task", planId: "plan", workerNodeId: "node" },
	timestamps: ["issuedAt", "leaseExpiresAt"], sha256: ["taskDigest", "permissionsDigest"], strings: ["executorPubkey", "executionProfileId", "idempotencyKey"], integers: ["schedulerEpoch", "fencingToken", "renewAfterSeconds"], booleans: [], arrays: ["moduleIds"], objects: ["placementReason"], actors: ["scheduler"],
};

const eventRule: ContractRule = {
	schemaVersion: MESH_SCHEMA.event,
	required: ["schemaVersion", "eventId", "type", "occurredAt", "actor", "idempotencyKey", "payloadEncoding", "payloadSha256"],
	allowed: ["schemaVersion", "eventId", "type", "occurredAt", "expiresAt", "actor", "targets", "sessionId", "taskId", "assignmentId", "correlationId", "causationId", "idempotencyKey", "sequence", "schedulerEpoch", "fencingToken", "payloadEncoding", "payload", "payloadSha256", "encryption", "nostr"],
	ids: { eventId: "event", sessionId: "session", taskId: "task", assignmentId: "assignment" },
	timestamps: ["occurredAt", "expiresAt"], sha256: ["payloadSha256"], strings: ["type", "idempotencyKey"], integers: ["sequence", "schedulerEpoch", "fencingToken"], booleans: [], arrays: ["targets"], objects: ["encryption", "nostr"], actors: ["actor"],
};

const nodeRule: ContractRule = {
	schemaVersion: MESH_SCHEMA.node,
	required: ["schemaVersion", "nodeId", "actorPubkey", "generatedAt", "expiresAt", "trustZone", "interactive", "draining", "static", "dynamic", "capabilities", "reservations", "profileVersion"],
	allowed: ["schemaVersion", "nodeId", "actorPubkey", "generatedAt", "expiresAt", "trustZone", "interactive", "draining", "static", "dynamic", "capabilities", "reservations", "endpoints", "profileVersion"],
	ids: { nodeId: "node" }, timestamps: ["generatedAt", "expiresAt"], sha256: [], strings: ["actorPubkey", "trustZone", "profileVersion"], integers: [], booleans: ["interactive", "draining"], arrays: ["endpoints"], objects: ["static", "dynamic", "capabilities", "reservations"], actors: [],
};

const artifactRule: ContractRule = {
	schemaVersion: MESH_SCHEMA.artifact,
	required: ["schemaVersion", "artifactId", "createdAt", "createdBy", "name", "contentType", "sizeBytes", "contentSha256", "encryption", "locations", "retention", "safety", "manifestDigest"],
	allowed: ["schemaVersion", "artifactId", "taskId", "sessionId", "createdAt", "createdBy", "name", "contentType", "sizeBytes", "contentSha256", "plaintextSha256", "encryption", "chunks", "locations", "labels", "retention", "safety", "manifestDigest"],
	ids: { artifactId: "artifact", taskId: "task", sessionId: "session" }, timestamps: ["createdAt"], sha256: ["contentSha256", "plaintextSha256", "manifestDigest"], strings: ["name", "contentType"], integers: ["sizeBytes"], booleans: [], arrays: ["chunks", "locations", "labels"], objects: ["encryption", "retention", "safety"], actors: ["createdBy"], digestField: "manifestDigest",
};

const checkpointRule: ContractRule = {
	schemaVersion: MESH_SCHEMA.checkpoint,
	required: ["schemaVersion", "checkpointId", "workspaceId", "createdAt", "createdBy", "sourceNodeId", "repository", "gitState", "files", "excluded", "secretScan", "artifactManifestId", "contentDigest", "manifestDigest"],
	allowed: ["schemaVersion", "checkpointId", "workspaceId", "createdAt", "createdBy", "sourceNodeId", "repository", "gitState", "files", "excluded", "secretScan", "environment", "agentHandoff", "artifactManifestId", "contentDigest", "activeWriterLease", "verification", "manifestDigest"],
	ids: { checkpointId: "checkpoint", sourceNodeId: "node", artifactManifestId: "artifact" }, timestamps: ["createdAt"], sha256: ["contentDigest", "manifestDigest"], strings: ["workspaceId"], integers: [], booleans: [], arrays: ["files", "excluded"], objects: ["repository", "gitState", "secretScan", "environment", "agentHandoff", "activeWriterLease", "verification"], actors: ["createdBy"], digestField: "manifestDigest",
};

const evidenceRule: ContractRule = {
	schemaVersion: MESH_SCHEMA.evidence,
	required: ["schemaVersion", "evidenceId", "taskId", "criterionIds", "createdAt", "createdBy", "claim", "sourceType", "sourceReference", "confidence", "digest"],
	allowed: ["schemaVersion", "evidenceId", "taskId", "criterionIds", "createdAt", "createdBy", "claim", "sourceType", "sourceReference", "sourceSha256", "confidence", "limitations", "digest"],
	ids: { evidenceId: "evidence", taskId: "task" }, timestamps: ["createdAt"], sha256: ["sourceSha256", "digest"], strings: ["claim", "sourceType", "confidence"], integers: [], booleans: [], arrays: ["criterionIds", "limitations"], objects: ["sourceReference"], actors: ["createdBy"], digestField: "digest",
};

const receiptRule: ContractRule = {
	schemaVersion: MESH_SCHEMA.receipt,
	required: ["schemaVersion", "receiptId", "taskId", "taskDigest", "assignmentId", "schedulerEpoch", "fencingToken", "worker", "nodeId", "startedAt", "endedAt", "outcome", "execution", "artifacts", "evidence", "validation", "resourceUsage", "cost", "cleanup", "receiptHash"],
	allowed: ["schemaVersion", "receiptId", "taskId", "taskDigest", "assignmentId", "schedulerEpoch", "fencingToken", "worker", "nodeId", "startedAt", "endedAt", "outcome", "execution", "models", "tools", "artifacts", "evidence", "validation", "resourceUsage", "cost", "cleanup", "previousReceiptHash", "receiptHash"],
	ids: { receiptId: "receipt", taskId: "task", assignmentId: "assignment", nodeId: "node" }, timestamps: ["startedAt", "endedAt"], sha256: ["taskDigest", "previousReceiptHash", "receiptHash"], strings: ["outcome"], integers: ["schedulerEpoch", "fencingToken"], booleans: [], arrays: ["models", "tools", "artifacts", "evidence"], objects: ["execution", "validation", "resourceUsage", "cost", "cleanup"], actors: ["worker"], digestField: "receiptHash",
};

const completionRule: ContractRule = {
	schemaVersion: MESH_SCHEMA.completion,
	required: ["schemaVersion", "decisionId", "taskId", "taskDigest", "decidedAt", "decidedBy", "outcome", "criterionCoverage", "policyStatus", "validationStatus", "cleanupStatus", "unresolvedBlockers", "finalArtifactIds", "digest"],
	allowed: ["schemaVersion", "decisionId", "taskId", "taskDigest", "decidedAt", "decidedBy", "outcome", "criterionCoverage", "policyStatus", "validationStatus", "cleanupStatus", "unresolvedBlockers", "finalArtifactIds", "digest"],
	ids: { taskId: "task" }, timestamps: ["decidedAt"], sha256: ["taskDigest", "digest"], strings: ["decisionId", "outcome", "policyStatus", "validationStatus", "cleanupStatus"], integers: [], booleans: [], arrays: ["criterionCoverage", "unresolvedBlockers", "finalArtifactIds"], objects: [], actors: ["decidedBy"], digestField: "digest",
};

const policyDecisionRule: ContractRule = {
	schemaVersion: MESH_SCHEMA.policyDecision,
	required: ["schemaVersion", "decisionId", "evaluatedAt", "policyBundleDigest", "subject", "action", "resource", "outcome", "reasons", "obligations", "digest"],
	allowed: ["schemaVersion", "decisionId", "taskId", "evaluatedAt", "policyBundleDigest", "subject", "action", "resource", "outcome", "reasons", "obligations", "expiresAt", "digest"],
	ids: { taskId: "task" }, timestamps: ["evaluatedAt", "expiresAt"], sha256: ["policyBundleDigest", "digest"], strings: ["decisionId", "action", "outcome"], integers: [], booleans: [], arrays: ["reasons", "obligations"], objects: ["resource"], actors: ["subject"], digestField: "digest",
};

const approvalRule: ContractRule = {
	schemaVersion: MESH_SCHEMA.approval,
	required: ["schemaVersion", "approvalId", "taskId", "requestedAt", "expiresAt", "requestedBy", "category", "summary", "exactAction", "parametersDigest", "idempotencyKey", "options", "risk"],
	allowed: ["schemaVersion", "approvalId", "taskId", "assignmentId", "requestedAt", "expiresAt", "requestedBy", "category", "summary", "exactAction", "parametersDigest", "idempotencyKey", "options", "risk"],
	ids: { approvalId: "approval", taskId: "task", assignmentId: "assignment" }, timestamps: ["requestedAt", "expiresAt"], sha256: ["parametersDigest"], strings: ["category", "summary", "idempotencyKey"], integers: [], booleans: [], arrays: ["options"], objects: ["exactAction", "risk"], actors: ["requestedBy"],
};

const RULES: Readonly<Record<MeshSchemaVersion, ContractRule>> = Object.freeze({
	[MESH_SCHEMA.task]: taskRule,
	[MESH_SCHEMA.plan]: planRule,
	[MESH_SCHEMA.assignment]: assignmentRule,
	[MESH_SCHEMA.event]: eventRule,
	[MESH_SCHEMA.node]: nodeRule,
	[MESH_SCHEMA.artifact]: artifactRule,
	[MESH_SCHEMA.checkpoint]: checkpointRule,
	[MESH_SCHEMA.evidence]: evidenceRule,
	[MESH_SCHEMA.receipt]: receiptRule,
	[MESH_SCHEMA.completion]: completionRule,
	[MESH_SCHEMA.policyDecision]: policyDecisionRule,
	[MESH_SCHEMA.approval]: approvalRule,
});

function fail(code: MeshValidationCode, path: string, message: string, operatorDetail?: string): never {
	throw new MeshValidationError([{ code, path, message, operatorDetail }]);
}

function hasOwn(record: JsonRecord, field: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, field);
}

function assertRecord(value: unknown, path: string): JsonRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_type", path, "must be an object");
	return value as JsonRecord;
}

function assertString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) fail("invalid_type", path, "must be a non-empty string");
	return value;
}

function assertTimestamp(value: unknown, path: string): void {
	if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value)))
		fail("invalid_format", path, "must be an ISO-8601 timestamp with timezone");
}

function assertSha256(value: unknown, path: string): void {
	if (typeof value !== "string" || !SHA256.test(value)) fail("invalid_format", path, "must be a lowercase SHA-256 hex digest");
}

function assertArray(value: unknown, path: string): readonly unknown[] {
	if (!Array.isArray(value)) fail("invalid_type", path, "must be an array");
	return value;
}

function assertActor(value: unknown, path: string): MeshActor {
	const actor = assertRecord(value, path);
	for (const key of Object.keys(actor)) if (!BASE_ACTOR_FIELDS.includes(key as (typeof BASE_ACTOR_FIELDS)[number])) fail("additional_property", `${path}.${key}`, "is not permitted");
	if (!hasOwn(actor, "pubkey") || !hasOwn(actor, "role")) fail("missing_field", path, "requires pubkey and role");
	const pubkey = assertString(actor.pubkey, `${path}.pubkey`);
	if (pubkey.length < 16 || pubkey.length > 200) fail("invalid_format", `${path}.pubkey`, "must be 16-200 characters");
	const role = assertString(actor.role, `${path}.role`);
	if (!ROLES.has(role)) fail("invalid_value", `${path}.role`, "must be a known mesh role");
	if (actor.nodeId !== undefined) assertMeshId(actor.nodeId, "node", `${path}.nodeId`);
	if (actor.delegationId !== undefined) assertString(actor.delegationId, `${path}.delegationId`);
	return actor as MeshActor;
}

function assertStringArray(value: unknown, path: string): void {
	for (const [index, entry] of assertArray(value, path).entries()) assertString(entry, `${path}[${index}]`);
}

function omitField(record: JsonRecord, field: string): JsonRecord {
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(record)) if (key !== field) result[key] = record[key];
	return result as JsonRecord;
}

function validateTaskSpecifics(record: JsonRecord): void {
	if (record.mode !== "fresh_clone" && record.mode !== "portable_handoff" && record.mode !== "general_tool" && record.mode !== "inference" && record.mode !== "scheduled") fail("invalid_value", "$.mode", "must be a known task mode");
	if (record.digestAlgorithm !== "sha256") fail("invalid_value", "$.digestAlgorithm", "must be sha256");
	const permissions = assertRecord(record.permissions, "$.permissions");
	for (const key of Object.keys(permissions)) if (!["tools", "secrets", "network", "filesystem", "externalSideEffects"].includes(key)) fail("additional_property", `$.permissions.${key}`, "is not permitted");
	if (!hasOwn(permissions, "tools") || !hasOwn(permissions, "externalSideEffects")) fail("missing_field", "$.permissions", "requires tools and externalSideEffects");
	assertStringArray(permissions.tools, "$.permissions.tools");
	for (const field of ["secrets", "network", "filesystem"] as const) if (permissions[field] !== undefined) assertStringArray(permissions[field], `$.permissions.${field}`);
	if (!["none", "approval_required", "preapproved_scoped"].includes(String(permissions.externalSideEffects))) fail("invalid_value", "$.permissions.externalSideEffects", "must be a known side-effect policy");
	const routing = assertRecord(record.routing, "$.routing");
	if (routing.trustZoneMin !== undefined && !TRUST_ZONES.has(String(routing.trustZoneMin))) fail("invalid_value", "$.routing.trustZoneMin", "must be a known trust zone");
	for (const field of ["preferredNodes", "forbiddenNodes", "requiredCapabilities"] as const) if (routing[field] !== undefined) assertStringArray(routing[field], `$.routing.${field}`);
	if (routing.activeMachineAllowed !== undefined && typeof routing.activeMachineAllowed !== "boolean") fail("invalid_type", "$.routing.activeMachineAllowed", "must be boolean");
	const criteria = assertArray(record.acceptanceCriteria, "$.acceptanceCriteria");
	if (criteria.length === 0) fail("invalid_value", "$.acceptanceCriteria", "must include at least one criterion");
	for (const [index, item] of criteria.entries()) {
		const criterion = assertRecord(item, `$.acceptanceCriteria[${index}]`);
		assertString(criterion.id, `$.acceptanceCriteria[${index}].id`);
		assertString(criterion.description, `$.acceptanceCriteria[${index}].description`);
		if (!["required", "advisory", "negative"].includes(String(criterion.level))) fail("invalid_value", `$.acceptanceCriteria[${index}].level`, "must be required, advisory, or negative");
	}
}

function validateSpecifics(record: JsonRecord, rule: ContractRule): void {
	if (rule.schemaVersion === MESH_SCHEMA.task) validateTaskSpecifics(record);
	if (rule.schemaVersion === MESH_SCHEMA.node && !TRUST_ZONES.has(String(record.trustZone))) fail("invalid_value", "$.trustZone", "must be a known trust zone");
	if (rule.schemaVersion === MESH_SCHEMA.event) {
		if (record.payloadEncoding !== "json" && record.payloadEncoding !== "ciphertext") fail("invalid_value", "$.payloadEncoding", "must be json or ciphertext");
		if (record.payload !== undefined && sha256CanonicalJson(record.payload) !== record.payloadSha256) fail("digest_mismatch", "$.payloadSha256", "does not match the canonical payload digest");
	}
}

function parseByRule<T extends MeshContractV1>(input: unknown, rule: ContractRule): T {
	const immutable = toImmutableJson(input);
	const record = assertRecord(immutable, "$");
	if (record.schemaVersion !== rule.schemaVersion) fail("unsupported_schema", "$.schemaVersion", `must be ${rule.schemaVersion}`);
	for (const field of rule.required) if (!hasOwn(record, field)) fail("missing_field", `$.${field}`, "is required");
	for (const key of Object.keys(record)) if (!rule.allowed.includes(key)) fail("additional_property", `$.${key}`, "is not permitted by this schema version");
	for (const [field, kind] of Object.entries(rule.ids)) if (record[field] !== undefined) assertMeshId(record[field], kind, `$.${field}`);
	for (const field of rule.timestamps) if (record[field] !== undefined) assertTimestamp(record[field], `$.${field}`);
	for (const field of rule.sha256) if (record[field] !== undefined) assertSha256(record[field], `$.${field}`);
	for (const field of rule.strings) if (record[field] !== undefined) assertString(record[field], `$.${field}`);
	for (const field of rule.integers) if (record[field] !== undefined && (typeof record[field] !== "number" || !Number.isInteger(record[field]) || record[field] < 0)) fail("invalid_type", `$.${field}`, "must be a non-negative integer");
	for (const field of rule.booleans) if (record[field] !== undefined && typeof record[field] !== "boolean") fail("invalid_type", `$.${field}`, "must be boolean");
	for (const field of rule.arrays) if (record[field] !== undefined) assertArray(record[field], `$.${field}`);
	for (const field of rule.objects) if (record[field] !== undefined) assertRecord(record[field], `$.${field}`);
	for (const field of rule.actors) if (record[field] !== undefined) assertActor(record[field], `$.${field}`);
	validateSpecifics(record, rule);
	if (rule.digestField !== undefined && sha256CanonicalJson(omitField(record, rule.digestField)) !== record[rule.digestField]) fail("digest_mismatch", `$.${rule.digestField}`, "does not match the canonical contract digest");
	return record as T;
}

export function parseMeshContract(input: unknown): MeshContractV1 {
	const record = assertRecord(toImmutableJson(input), "$");
	if (typeof record.schemaVersion !== "string" || !(record.schemaVersion in RULES)) fail("unsupported_schema", "$.schemaVersion", "is not a supported mesh schema version");
	return parseByRule<MeshContractV1>(record, RULES[record.schemaVersion as MeshSchemaVersion]);
}

export function validateMeshContract(input: unknown): { readonly ok: true; readonly value: MeshContractV1 } | { readonly ok: false; readonly error: MeshValidationError } {
	try {
		return Object.freeze({ ok: true, value: parseMeshContract(input) });
	} catch (error) {
		if (error instanceof MeshValidationError) return Object.freeze({ ok: false, error });
		throw error;
	}
}

export const parseTaskContract: ContractParser<TaskContractV1> = input => parseByRule<TaskContractV1>(input, taskRule);
export const parseReasoningPlan: ContractParser<ReasoningPlanV1> = input => parseByRule<ReasoningPlanV1>(input, planRule);
export const parseAssignmentLease: ContractParser<AssignmentLeaseV1> = input => parseByRule<AssignmentLeaseV1>(input, assignmentRule);
export const parseEventEnvelope: ContractParser<EventEnvelopeV1> = input => parseByRule<EventEnvelopeV1>(input, eventRule);
export const parseNodeAdvertisement: ContractParser<NodeAdvertisementV1> = input => parseByRule<NodeAdvertisementV1>(input, nodeRule);
export const parseArtifactManifest: ContractParser<ArtifactManifestV1> = input => parseByRule<ArtifactManifestV1>(input, artifactRule);
export const parseCheckpointManifest: ContractParser<CheckpointManifestV1> = input => parseByRule<CheckpointManifestV1>(input, checkpointRule);
export const parseEvidenceRecord: ContractParser<EvidenceRecordV1> = input => parseByRule<EvidenceRecordV1>(input, evidenceRule);
export const parseExecutionReceipt: ContractParser<ExecutionReceiptV1> = input => parseByRule<ExecutionReceiptV1>(input, receiptRule);
export const parseCompletionDecision: ContractParser<CompletionDecisionV1> = input => parseByRule<CompletionDecisionV1>(input, completionRule);
export const parsePolicyDecision: ContractParser<PolicyDecisionV1> = input => parseByRule<PolicyDecisionV1>(input, policyDecisionRule);
export const parseApprovalRequest: ContractParser<ApprovalRequestV1> = input => parseByRule<ApprovalRequestV1>(input, approvalRule);

export function contractDigest(value: JsonRecord, digestField: string): string {
	return sha256CanonicalJson(omitField(value, digestField));
}

export function canonicalContractJson(value: MeshContractV1): string {
	return canonicalizeJson(value);
}
