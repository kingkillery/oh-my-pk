import {
	MeshValidationError,
	assertMeshId,
	toImmutableJson,
	type ApprovalPolicy,
	type ArtifactPolicy,
	type ExecutionLimits,
	type IdentityDelegationV1,
	type JsonRecord,
	type MeshRole,
	type RevocationV1,
	type RoutingRequirements,
	type TaskContractV1,
	type TaskPermissions,
	type TrustZone,
} from "@pk-nerdsaver-ai/mesh-contracts";

export type PolicyOutcome = "allow" | "deny" | "require_approval";

export interface PolicyDecision {
	readonly outcome: PolicyOutcome;
	readonly reasons: readonly string[];
	readonly obligations: readonly string[];
}

/** The concrete authority proposed for a child assignment. Every field is compared to the root task. */
export interface AssignmentScope {
	readonly goal: string;
	readonly permissions: TaskPermissions;
	readonly execution: ExecutionLimits;
	readonly routing: RoutingRequirements;
	readonly artifactPolicy: ArtifactPolicy;
	readonly approvalPolicy?: ApprovalPolicy;
}

export interface AuthorizationRequest {
	readonly task: TaskContractV1;
	readonly scope: AssignmentScope;
	readonly evaluatedAt: string;
	readonly signatureVerified: boolean;
	readonly delegation?: IdentityDelegationV1;
	readonly revocations: readonly RevocationV1[];
	readonly subjectPubkey: string;
	readonly action: string;
	readonly tools: readonly string[];
	readonly secrets: readonly string[];
	readonly repository?: string;
	readonly trustZone: TrustZone;
	readonly costUsd?: number;
	readonly approvalGranted?: boolean;
}

const TRUST_ORDER: Readonly<Record<TrustZone, number>> = Object.freeze({ local: 0, private: 1, partner: 2, public: 3 });
const SIDE_EFFECT_ORDER: Readonly<Record<TaskPermissions["externalSideEffects"], number>> = Object.freeze({ none: 0, approval_required: 1, preapproved_scoped: 2 });
const LIMIT_FIELDS = ["timeoutSeconds", "cpuMax", "memoryBytesMax", "diskBytesMax", "pidMax", "networkBytesMax", "retriesMax"] as const;

function frozenDecision(outcome: PolicyOutcome, reasons: readonly string[], obligations: readonly string[] = []): PolicyDecision {
	return Object.freeze({ outcome, reasons: Object.freeze([...reasons]), obligations: Object.freeze([...obligations]) });
}

function stringsAreSubset(candidate: readonly string[] | undefined, parent: readonly string[] | undefined): boolean {
	if (candidate === undefined || candidate.length === 0) return true;
	if (parent === undefined) return false;
	return candidate.every(item => parent.includes(item));
}

function containsAll(candidate: readonly string[] | undefined, required: readonly string[] | undefined): boolean {
	if (required === undefined || required.length === 0) return true;
	if (candidate === undefined) return false;
	return required.every(item => candidate.includes(item));
}

function pathWithin(path: string, parentPath: string): boolean {
	if (path === parentPath) return true;
	if (!parentPath.startsWith("/")) return false;
	const normalizedParent = parentPath.endsWith("/") ? parentPath : `${parentPath}/`;
	return path.startsWith(normalizedParent);
}

function pathsAreSubset(candidate: readonly string[] | undefined, parent: readonly string[] | undefined): boolean {
	if (candidate === undefined || candidate.length === 0) return true;
	if (parent === undefined) return false;
	return candidate.every(path => parent.some(allowed => pathWithin(path, allowed)));
}

function limitsAreAttenuated(candidate: ExecutionLimits, parent: ExecutionLimits): boolean {
	for (const field of LIMIT_FIELDS) {
		const childValue = candidate[field];
		const parentValue = parent[field];
		if (parentValue !== undefined && (childValue === undefined || typeof childValue !== "number" || childValue > parentValue)) return false;
	}
	return true;
}

function artifactPolicyIsAttenuated(candidate: ArtifactPolicy, parent: ArtifactPolicy): boolean {
	if (parent.retentionClass !== undefined && candidate.retentionClass !== parent.retentionClass) return false;
	if (parent.encryptionRequired === true && candidate.encryptionRequired !== true) return false;
	if (parent.replicasMin !== undefined && (candidate.replicasMin === undefined || candidate.replicasMin < parent.replicasMin)) return false;
	return stringsAreSubset(candidate.allowedContentTypes, parent.allowedContentTypes);
}

function approvalPolicyIsAttenuated(candidate: ApprovalPolicy | undefined, parent: ApprovalPolicy | undefined): boolean {
	if (parent === undefined) return true;
	if (candidate === undefined) return false;
	if (!containsAll(candidate.requiredFor, parent.requiredFor)) return false;
	if (parent.approvalTimeoutSeconds !== undefined && (candidate.approvalTimeoutSeconds === undefined || candidate.approvalTimeoutSeconds > parent.approvalTimeoutSeconds)) return false;
	return true;
}

/** Fail closed unless the child scope is provably no wider than its root task. */
export function evaluateAssignmentAttenuation(task: TaskContractV1, candidate: AssignmentScope): PolicyDecision {
	const reasons: string[] = [];
	if (candidate.goal !== task.goal) reasons.push("goal_must_match_root_task");
	if (!stringsAreSubset(candidate.permissions.tools, task.permissions.tools)) reasons.push("tool_scope_broadened");
	if (!stringsAreSubset(candidate.permissions.secrets, task.permissions.secrets)) reasons.push("secret_scope_broadened");
	if (!stringsAreSubset(candidate.permissions.network, task.permissions.network)) reasons.push("network_scope_broadened");
	if (!pathsAreSubset(candidate.permissions.filesystem, task.permissions.filesystem)) reasons.push("filesystem_scope_broadened");
	if (SIDE_EFFECT_ORDER[candidate.permissions.externalSideEffects] > SIDE_EFFECT_ORDER[task.permissions.externalSideEffects]) reasons.push("side_effect_scope_broadened");
	if (!limitsAreAttenuated(candidate.execution, task.execution)) reasons.push("execution_budget_broadened");
	if (!containsAll(candidate.routing.requiredCapabilities, task.routing.requiredCapabilities)) reasons.push("capability_requirement_weakened");
	if (!containsAll(candidate.routing.forbiddenNodes, task.routing.forbiddenNodes)) reasons.push("forbidden_node_scope_weakened");
	if (task.routing.activeMachineAllowed === false && candidate.routing.activeMachineAllowed !== false) reasons.push("active_machine_protection_weakened");
	if (task.routing.trustZoneMin !== undefined && (candidate.routing.trustZoneMin === undefined || TRUST_ORDER[candidate.routing.trustZoneMin] < TRUST_ORDER[task.routing.trustZoneMin])) reasons.push("model_or_node_trust_downgraded");
	if (task.routing.costCeilingUsd !== undefined && (candidate.routing.costCeilingUsd === undefined || candidate.routing.costCeilingUsd > task.routing.costCeilingUsd)) reasons.push("cost_ceiling_broadened");
	if (!artifactPolicyIsAttenuated(candidate.artifactPolicy, task.artifactPolicy)) reasons.push("retention_or_encryption_weakened");
	if (!approvalPolicyIsAttenuated(candidate.approvalPolicy, task.approvalPolicy)) reasons.push("approval_policy_weakened");
	return reasons.length === 0 ? frozenDecision("allow", []) : frozenDecision("deny", reasons);
}

function record(value: unknown, path: string): JsonRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new MeshValidationError([{ code: "invalid_type", path, message: "must be an object" }]);
	return value as JsonRecord;
}

function text(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) throw new MeshValidationError([{ code: "invalid_type", path, message: "must be a non-empty string" }]);
	return value;
}

function timestamp(value: unknown, path: string): string {
	const result = text(value, path);
	if (Number.isNaN(Date.parse(result))) throw new MeshValidationError([{ code: "invalid_format", path, message: "must be a timestamp" }]);
	return result;
}

function stringArray(value: unknown, path: string): readonly string[] {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string" && item.length > 0)) throw new MeshValidationError([{ code: "invalid_type", path, message: "must be an array of non-empty strings" }]);
	return Object.freeze([...value]);
}

function role(value: unknown, path: string): MeshRole {
	const result = text(value, path);
	if (!["human", "orchestrator", "scheduler", "node", "worker", "agent", "tool", "service", "validator"].includes(result)) throw new MeshValidationError([{ code: "invalid_value", path, message: "must be a mesh role" }]);
	return result as MeshRole;
}

function zone(value: unknown, path: string): TrustZone {
	const result = text(value, path);
	if (!(result in TRUST_ORDER)) throw new MeshValidationError([{ code: "invalid_value", path, message: "must be a trust zone" }]);
	return result as TrustZone;
}

/** Parses a non-cryptographic delegation certificate. Signature verification deliberately remains an injected provider concern. */
export function parseIdentityDelegation(input: unknown): IdentityDelegationV1 {
	const value = record(toImmutableJson(input), "$");
	const required = ["schemaVersion", "delegationId", "issuerPubkey", "subjectPubkey", "role", "allowedActions", "toolScopes", "secretScopes", "repositoryScopes", "trustZone", "notBefore", "expiresAt", "revocationEpoch", "serial"];
	const allowed = new Set([...required, "maxCostUsd", "parentDelegationId"]);
	for (const field of required) if (!(field in value)) throw new MeshValidationError([{ code: "missing_field", path: `$.${field}`, message: "is required" }]);
	for (const field of Object.keys(value)) if (!allowed.has(field)) throw new MeshValidationError([{ code: "additional_property", path: `$.${field}`, message: "is not permitted" }]);
	const delegationId = text(value.delegationId, "$.delegationId");
	const parsed = {
		schemaVersion: "ompk.identity-delegation/v1" as const,
		delegationId,
		issuerPubkey: text(value.issuerPubkey, "$.issuerPubkey"),
		subjectPubkey: text(value.subjectPubkey, "$.subjectPubkey"),
		role: role(value.role, "$.role"),
		allowedActions: stringArray(value.allowedActions, "$.allowedActions"),
		toolScopes: stringArray(value.toolScopes, "$.toolScopes"),
		secretScopes: stringArray(value.secretScopes, "$.secretScopes"),
		repositoryScopes: stringArray(value.repositoryScopes, "$.repositoryScopes"),
		trustZone: zone(value.trustZone, "$.trustZone"),
		...(value.maxCostUsd === undefined ? {} : { maxCostUsd: number(value.maxCostUsd, "$.maxCostUsd") }),
		notBefore: timestamp(value.notBefore, "$.notBefore"),
		expiresAt: timestamp(value.expiresAt, "$.expiresAt"),
		...(value.parentDelegationId === undefined ? {} : { parentDelegationId: text(value.parentDelegationId, "$.parentDelegationId") }),
		revocationEpoch: integer(value.revocationEpoch, "$.revocationEpoch"),
		serial: integer(value.serial, "$.serial"),
	};
	if (value.schemaVersion !== parsed.schemaVersion) throw new MeshValidationError([{ code: "unsupported_schema", path: "$.schemaVersion", message: `must be ${parsed.schemaVersion}` }]);
	return Object.freeze(parsed) as IdentityDelegationV1;
}

function number(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new MeshValidationError([{ code: "invalid_type", path, message: "must be a non-negative finite number" }]);
	return value;
}

function integer(value: unknown, path: string): number {
	const result = number(value, path);
	if (!Number.isInteger(result)) throw new MeshValidationError([{ code: "invalid_type", path, message: "must be an integer" }]);
	return result;
}

export function parseRevocation(input: unknown): RevocationV1 {
	const value = record(toImmutableJson(input), "$");
	const allowed = new Set(["schemaVersion", "revocationId", "effectiveAt", "reason", "delegationId", "subjectPubkey", "serial", "revocationEpoch"]);
	for (const field of ["schemaVersion", "revocationId", "effectiveAt", "reason"]) if (!(field in value)) throw new MeshValidationError([{ code: "missing_field", path: `$.${field}`, message: "is required" }]);
	for (const field of Object.keys(value)) if (!allowed.has(field)) throw new MeshValidationError([{ code: "additional_property", path: `$.${field}`, message: "is not permitted" }]);
	if (value.schemaVersion !== "ompk.revocation/v1") throw new MeshValidationError([{ code: "unsupported_schema", path: "$.schemaVersion", message: "must be ompk.revocation/v1" }]);
	if (value.delegationId === undefined && value.subjectPubkey === undefined) throw new MeshValidationError([{ code: "missing_field", path: "$", message: "requires delegationId or subjectPubkey" }]);
	return Object.freeze({
		schemaVersion: "ompk.revocation/v1" as const,
		revocationId: text(value.revocationId, "$.revocationId"),
		effectiveAt: timestamp(value.effectiveAt, "$.effectiveAt"),
		reason: text(value.reason, "$.reason"),
		...(value.delegationId === undefined ? {} : { delegationId: text(value.delegationId, "$.delegationId") }),
		...(value.subjectPubkey === undefined ? {} : { subjectPubkey: text(value.subjectPubkey, "$.subjectPubkey") }),
		...(value.serial === undefined ? {} : { serial: integer(value.serial, "$.serial") }),
		...(value.revocationEpoch === undefined ? {} : { revocationEpoch: integer(value.revocationEpoch, "$.revocationEpoch") }),
	}) as RevocationV1;
}

function isRevoked(delegation: IdentityDelegationV1, revocations: readonly RevocationV1[], at: string): boolean {
	const evaluationTime = Date.parse(at);
	return revocations.some(revocation => {
		if (Date.parse(revocation.effectiveAt) > evaluationTime) return false;
		return revocation.delegationId === delegation.delegationId || revocation.subjectPubkey === delegation.subjectPubkey || (revocation.serial !== undefined && revocation.serial === delegation.serial) || (revocation.revocationEpoch !== undefined && revocation.revocationEpoch >= delegation.revocationEpoch);
	});
}

/** Authorization is an intersection: signature proves origin, while delegation, revocation, task scope, and approval establish authority. */
export function evaluateAuthorization(request: AuthorizationRequest): PolicyDecision {
	const attenuation = evaluateAssignmentAttenuation(request.task, request.scope);
	if (!request.signatureVerified) return frozenDecision("deny", ["signature_unverified", ...attenuation.reasons]);
	if (request.delegation === undefined) return frozenDecision("deny", ["delegation_required", ...attenuation.reasons]);
	const delegation = request.delegation;
	const reasons = [...attenuation.reasons];
	if (delegation.subjectPubkey !== request.subjectPubkey) reasons.push("delegation_subject_mismatch");
	if (Date.parse(request.evaluatedAt) < Date.parse(delegation.notBefore) || Date.parse(request.evaluatedAt) >= Date.parse(delegation.expiresAt)) reasons.push("delegation_not_current");
	if (isRevoked(delegation, request.revocations, request.evaluatedAt)) reasons.push("delegation_revoked");
	if (!delegation.allowedActions.includes(request.action)) reasons.push("action_outside_delegation");
	if (!stringsAreSubset(request.tools, delegation.toolScopes)) reasons.push("tool_outside_delegation");
	if (!stringsAreSubset(request.secrets, delegation.secretScopes)) reasons.push("secret_outside_delegation");
	if (request.repository !== undefined && !delegation.repositoryScopes.includes(request.repository)) reasons.push("repository_outside_delegation");
	if (TRUST_ORDER[request.trustZone] > TRUST_ORDER[delegation.trustZone]) reasons.push("trust_zone_downgraded");
	if (request.costUsd !== undefined && delegation.maxCostUsd !== undefined && request.costUsd > delegation.maxCostUsd) reasons.push("delegation_cost_exceeded");
	if (reasons.length > 0) return frozenDecision("deny", reasons);
	const approvalNeeded = request.task.permissions.externalSideEffects === "approval_required" || request.task.approvalPolicy?.requiredFor?.includes(request.action) === true;
	if (approvalNeeded && !request.approvalGranted) return frozenDecision("require_approval", ["approval_required"], ["bind_exact_action_parameters"]);
	return frozenDecision("allow", []);
}

export { assertMeshId };
