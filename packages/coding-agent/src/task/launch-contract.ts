/**
 * Immutable Versioned Launch Contracts (A02) — frozen W1 contract surface.
 *
 * Compilation (pure, allocation-free) is separated from runtime binding:
 * - compileLaunchContract validates + deep-freezes a mission/policy snapshot.
 * - bindLaunchContract attaches store-admitted runtime identities.
 * - parseLaunchContract strictly revalidates a serialized contract.
 *
 * Hashing: SHA-256 over canonical JSON with UTF-16 code-unit key ordering.
 * Array order is significant and retained. Absent fields are distinct from
 * null/zero/empty — the encoder never collapses them. Non-finite numbers
 * are rejected before hashing.
 */
import { createHash } from "node:crypto";
import type { AgentExecutionProfile } from "../orchestration/agent-execution-profile";
import type { CollaborationPolicy } from "../orchestration/collaboration-policy";
import type { ResolvedToolProfile, ToolSource } from "../tools/tool-profiles";
import { TOOL_SOURCES } from "../tools/tool-profiles";

export const LAUNCH_CONTRACT_VERSION = 1 as const;
export type LaunchContractVersion = typeof LAUNCH_CONTRACT_VERSION;

/** Canonical tool-capability source vocabulary (reuses ToolSource). */
export type ToolCapabilitySource = ToolSource;
export const TOOL_CAPABILITY_SOURCES: readonly ToolCapabilitySource[] = TOOL_SOURCES;

export type AgentRole = "root-planner" | "subplanner" | "worker" | "verifier";
export const KNOWN_AGENT_ROLES: readonly AgentRole[] = ["root-planner", "subplanner", "worker", "verifier"] as const;

export type TopologyKind = "hierarchical" | "legacy" | "direct";
export const KNOWN_TOPOLOGIES: readonly TopologyKind[] = ["hierarchical", "legacy", "direct"] as const;

export interface SnapshotRefV1 {
	readonly schemaVersion: 1;
	readonly manifestHash: string;
	readonly manifestUri: string;
}

export interface ArtifactRefV1 {
	readonly schemaVersion: 1;
	readonly artifactId: string;
	readonly uri: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly mediaType: string;
	readonly provenanceId: string;
}

export interface MutationContractV1 {
	readonly schemaVersion: 1;
	readonly apply: boolean;
	readonly allowCommit: boolean;
	readonly allowPush: boolean;
	readonly allowMerge: boolean;
	readonly approvalRef: string | null;
}

export interface RunLimitsV1 {
	readonly schemaVersion: 1;
	readonly maxNodes: number;
	readonly maxDepth: number;
	readonly maxAttemptsPerNode: number;
	readonly maxOutstanding: number;
	readonly maxActiveCompute: number;
	readonly maxRequests: number;
	readonly maxRuntimeMs: number;
	readonly maxComputeRuntimeMs: number;
	readonly maxTokens: number | null;
	readonly maxCostMicrounits: number | null;
	readonly currency: string | null;
	readonly maxHandoffBytes: number;
	readonly maxInboxEvents: number;
}

export interface ReservationVector {
	readonly requests: number;
	readonly runtimeMs: number;
	readonly tokens: number | null;
	readonly costMicrounits: number | null;
}

export interface LifecycleFence {
	readonly runId: string;
	readonly nodeId: string;
	readonly attemptId: string;
	readonly leaseOwner: string;
	readonly leaseEpoch: number;
	readonly cancellationGeneration: number;
	readonly contractVersion: number;
}

export interface RuntimePolicySnapshotV1 {
	readonly schemaVersion: 1;
	readonly role: AgentRole;
	readonly topology: TopologyKind;
	readonly executionProfile: AgentExecutionProfile;
	readonly toolProfile: ResolvedToolProfile;
	readonly collaborationPolicy: CollaborationPolicy;
	readonly mutation: MutationContractV1;
	readonly limits: RunLimitsV1;
	readonly baseline: SnapshotRefV1;
	readonly grantRefs: readonly string[];
	readonly harnessRef: string;
	readonly projectionVersion: 1;
	readonly environmentRef: string;
	readonly isolationLevel: "cooperative-worktree" | "confined";
}

/** Mission input: registered artifact + description + owning grant. */
export interface MissionInputV1 {
	readonly artifact: ArtifactRefV1;
	readonly description: string;
	readonly grantId: string;
}

export interface BudgetView {
	readonly maxRequests: number;
	readonly maxRuntimeMs: number;
	readonly maxTokens?: number | null;
}

export interface MissionCriterion {
	readonly id: string;
	readonly description: string;
}

export interface MissionCapsule {
	readonly schemaVersion: 1;
	readonly objective: string;
	readonly nonGoals: readonly string[];
	readonly relevantRationale?: string;
	readonly baselineRef: SnapshotRefV1;
	readonly inputs: readonly MissionInputV1[];
	readonly readableScope: readonly string[];
	readonly writableScope: readonly string[];
	readonly acceptance: readonly MissionCriterion[];
	readonly verificationPlanRef?: string;
	readonly capabilitySummary: readonly string[];
	readonly localBudget: BudgetView;
	readonly escalationContractRef?: string;
	readonly outputSchemaRef?: string;
}

export interface LaunchEnvelope {
	readonly schemaVersion: 1;
	readonly version: LaunchContractVersion;
	readonly runId: string;
	readonly nodeId: string;
	readonly ownerNodeId: string | null;
	readonly attemptId: string;
	readonly role: AgentRole;
	readonly topology: TopologyKind;
	readonly missionHash: string;
	readonly policyHash: string;
	readonly harnessVersion: string;
	/** Content-addressed capability manifest digest (`cap-<sha256>`). */
	readonly capabilityManifestRef: string;
	readonly budgetReservationId: string;
	readonly executionEnvironmentRef: string;
	readonly leaseEpoch: number;
	readonly cancellationGeneration: number;
}

export interface LaunchContract {
	readonly capsule: MissionCapsule;
	readonly envelope: LaunchEnvelope;
	readonly policy: RuntimePolicySnapshotV1;
	readonly contractVersion: number;
	readonly policySchemaVersion: 1;
	readonly harnessSchemaVersion: 1;
}

export interface LaunchContractDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly path?: string;
}

export interface LaunchCompileInput {
	readonly capsule: MissionCapsule;
	readonly policy: RuntimePolicySnapshotV1;
	readonly parentPolicy: RuntimePolicySnapshotV1 | null;
	readonly requiredInputIds: readonly string[];
}

export interface CompiledLaunchContract {
	readonly schemaVersion: 1;
	readonly contractVersion: number;
	readonly capsule: MissionCapsule;
	readonly policy: RuntimePolicySnapshotV1;
	readonly missionHash: string;
	readonly policyHash: string;
}

export type LaunchCompileResult =
	| { readonly ok: true; readonly compiled: CompiledLaunchContract }
	| { readonly ok: false; readonly diagnostics: readonly LaunchContractDiagnostic[] };

export interface LaunchBinding {
	readonly runId: string;
	readonly nodeId: string;
	readonly ownerNodeId: string | null;
	readonly attemptId: string;
	readonly budgetReservationId: string;
	readonly leaseEpoch: number;
	readonly cancellationGeneration: number;
}

export interface LifecycleHandoffV1 {
	readonly schemaVersion: 1;
	readonly kind: "settled" | "clarification" | "reply";
	readonly eventId: string;
	readonly fence: LifecycleFence;
	readonly ownerNodeId: string | null;
	readonly targetNodeId: string | null;
	readonly correlationId: string | null;
	readonly missionHash: string;
	readonly baseline: SnapshotRefV1;
	readonly outcome: "completed" | "blocked" | "failed" | "cancelled" | "needs-replan" | null;
	readonly summary: string;
	readonly manifest: ArtifactRefV1 | null;
	readonly evidenceRefs: readonly string[];
	readonly observedExitCode: number | null;
	readonly changedPaths: readonly string[];
	readonly obligationIds: readonly string[];
	readonly proposedNextAction: string | null;
}

export interface ObligationV1 {
	readonly schemaVersion: 1;
	readonly obligationId: string;
	readonly runId: string;
	readonly nodeId: string;
	readonly criterionId: string;
	readonly kind: "mandatory_criterion" | "unresolved_dependency" | "scope_verification" | "publication_partial";
	readonly state: "open" | "resolved" | "waived";
	readonly evidenceReceiptIds: readonly string[];
	readonly waiverAuthorizationRef: string | null;
	readonly version: number;
}

// ---------------------------------------------------------------------------
// Shared canonical JSON encoder (also used for contract-freeze digests).
// ---------------------------------------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Canonical JSON: object keys in UTF-16 code-unit order, array order
 * retained, values encoded exactly (absence stays absent — callers must
 * not collapse undefined into null/empty). Throws on non-finite numbers.
 */
export function canonicalJson(value: unknown): string {
	if (value === undefined) throw new Error("canonical_json_undefined");
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("canonical_json_non_finite_number");
		return JSON.stringify(value);
	}
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
	if (!isPlainObject(value)) throw new Error("canonical_json_non_plain_object");
	const keys = Object.keys(value).sort();
	const entries = keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
	return `{${entries.join(",")}}`;
}

export function sha256Hex(canonical: string): string {
	return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;

export function isHex64(value: unknown): value is string {
	return typeof value === "string" && HEX64.test(value);
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isSafeNonNegativeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function diag(code: string, message: string, path?: string): LaunchContractDiagnostic {
	return path === undefined ? { code, message } : { code, message, path };
}

// ---------------------------------------------------------------------------
// Scope validation (lexical stage; realpath containment is async preflight).
// ---------------------------------------------------------------------------

const NULL_CHAR = "\0";
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const DRIVE_ROOT = /^[A-Za-z]:[\\/]/;
const DRIVE_RELATIVE = /^[A-Za-z]:[^\\/]/;
const HAS_GLOB = /[*?[\]{}]/;

export interface NormalizedScope {
	readonly kind: "root" | "concrete" | "glob";
	/** Normalized posix form ("." for repo root). */
	readonly normalized: string;
}

/**
 * Lexically validates + normalizes one repository-relative scope entry.
 * Rejects absolute/drive/UNC/drive-relative roots, URI-scheme backends,
 * URI-encoded separators/traversal, null bytes, and `..` escapes (resolved
 * segment-by-segment, never by substring search). Returns null when invalid.
 */
export function normalizeScopeEntry(entry: string): NormalizedScope | null {
	if (typeof entry !== "string") return null;
	const trimmed = entry.trim();
	if (!trimmed || trimmed.includes(NULL_CHAR)) return null;
	if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) return null;
	if (DRIVE_ROOT.test(trimmed) || DRIVE_RELATIVE.test(trimmed)) return null;
	if (trimmed.startsWith("/")) return null;
	if (URI_SCHEME.test(trimmed)) return null;
	if (trimmed.includes("%")) {
		try {
			const decoded = decodeURIComponent(trimmed);
			if (decoded !== trimmed && (decoded.includes("/") || decoded.includes("\\") || decoded.includes(".."))) {
				return null;
			}
		} catch {
			// Not valid percent-encoding: treat literally below.
		}
	}
	const unified = trimmed.replace(/\\/g, "/");
	const rawSegments = unified.split("/");
	const resolved: string[] = [];
	for (const seg of rawSegments) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (resolved.length === 0) return null;
			resolved.pop();
			continue;
		}
		resolved.push(seg);
	}
	if (resolved.length === 0) return { kind: "root", normalized: "." };
	const normalized = resolved.join("/");
	if (HAS_GLOB.test(normalized)) return { kind: "glob", normalized };
	return { kind: "concrete", normalized };
}

/**
 * Child scope-narrowing rule: accepts equal inherited grants or narrower
 * canonical concrete roots, otherwise not a proven subset. Parent globs
 * only match by exact equality (no heuristic narrowing).
 */
export function isScopeSubsetOfParent(childRaw: string, parentRawScopes: readonly string[]): boolean {
	const child = normalizeScopeEntry(childRaw);
	if (!child) return false;
	for (const parentRaw of parentRawScopes) {
		const parent = normalizeScopeEntry(parentRaw);
		if (!parent) continue;
		if (parent.normalized === child.normalized) return true;
		if (parent.kind === "glob") continue;
		if (parent.kind === "root" && child.kind === "concrete") return true;
		if (
			parent.kind === "concrete" &&
			child.kind === "concrete" &&
			child.normalized.startsWith(`${parent.normalized}/`)
		) {
			return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Strict structural validators (return diagnostics, never throw).
// ---------------------------------------------------------------------------

function checkUnknownKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	diagnostics: LaunchContractDiagnostic[],
	path: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			diagnostics.push(diag("unknown_authority_field", `Unknown field '${path}.${key}'.`, path));
		}
	}
}

const SNAPSHOT_KEYS = ["schemaVersion", "manifestHash", "manifestUri"] as const;

function validateSnapshotRef(
	value: unknown,
	diagnostics: LaunchContractDiagnostic[],
	path: string,
): SnapshotRefV1 | null {
	if (!isPlainObject(value)) {
		diagnostics.push(diag("invalid_snapshot_ref", "Snapshot ref must be an object.", path));
		return null;
	}
	checkUnknownKeys(value, SNAPSHOT_KEYS, diagnostics, path);
	let ok = true;
	if (value.schemaVersion !== 1) {
		diagnostics.push(diag("unknown_version", "SnapshotRef schemaVersion must be 1.", `${path}.schemaVersion`));
		ok = false;
	}
	if (!isHex64(value.manifestHash)) {
		diagnostics.push(
			diag("invalid_manifest_hash", "manifestHash must be lowercase 64-hex SHA-256.", `${path}.manifestHash`),
		);
		ok = false;
	}
	if (!isNonEmptyString(value.manifestUri)) {
		diagnostics.push(
			diag("invalid_manifest_uri", "manifestUri must be a non-empty registered reference.", `${path}.manifestUri`),
		);
		ok = false;
	} else if (value.manifestUri.trim().toLowerCase() === "head") {
		diagnostics.push(
			diag(
				"symbolic_baseline",
				"Baseline must be a content snapshot digest, never symbolic HEAD.",
				`${path}.manifestUri`,
			),
		);
		ok = false;
	}
	if (!ok) return null;
	return { schemaVersion: 1, manifestHash: value.manifestHash as string, manifestUri: value.manifestUri as string };
}

const ARTIFACT_KEYS = ["schemaVersion", "artifactId", "uri", "sha256", "bytes", "mediaType", "provenanceId"] as const;

function validateArtifactRef(
	value: unknown,
	diagnostics: LaunchContractDiagnostic[],
	path: string,
): ArtifactRefV1 | null {
	if (!isPlainObject(value)) {
		diagnostics.push(diag("invalid_artifact_ref", "Artifact ref must be an object.", path));
		return null;
	}
	checkUnknownKeys(value, ARTIFACT_KEYS, diagnostics, path);
	let ok = true;
	if (value.schemaVersion !== 1) {
		diagnostics.push(diag("unknown_version", "ArtifactRef schemaVersion must be 1.", `${path}.schemaVersion`));
		ok = false;
	}
	for (const field of ["artifactId", "uri", "mediaType", "provenanceId"] as const) {
		if (!isNonEmptyString(value[field])) {
			diagnostics.push(
				diag("invalid_artifact_ref", `Artifact ref '${field}' must be a non-empty string.`, `${path}.${field}`),
			);
			ok = false;
		}
	}
	if (!isHex64(value.sha256)) {
		diagnostics.push(diag("invalid_artifact_hash", "Artifact sha256 must be lowercase 64-hex.", `${path}.sha256`));
		ok = false;
	}
	if (!isSafeNonNegativeInt(value.bytes)) {
		diagnostics.push(
			diag("invalid_artifact_bytes", "Artifact bytes must be a safe non-negative integer.", `${path}.bytes`),
		);
		ok = false;
	}
	if (!ok) return null;
	return {
		schemaVersion: 1,
		artifactId: value.artifactId as string,
		uri: value.uri as string,
		sha256: value.sha256 as string,
		bytes: value.bytes as number,
		mediaType: value.mediaType as string,
		provenanceId: value.provenanceId as string,
	};
}

const MUTATION_KEYS = ["schemaVersion", "apply", "allowCommit", "allowPush", "allowMerge", "approvalRef"] as const;

function validateMutationContract(
	value: unknown,
	diagnostics: LaunchContractDiagnostic[],
	path: string,
): MutationContractV1 | null {
	if (!isPlainObject(value)) {
		diagnostics.push(diag("invalid_mutation_contract", "Mutation contract must be an object.", path));
		return null;
	}
	checkUnknownKeys(value, MUTATION_KEYS, diagnostics, path);
	let ok = true;
	if (value.schemaVersion !== 1) {
		diagnostics.push(diag("unknown_version", "MutationContract schemaVersion must be 1.", `${path}.schemaVersion`));
		ok = false;
	}
	for (const field of ["apply", "allowCommit", "allowPush", "allowMerge"] as const) {
		if (typeof value[field] !== "boolean") {
			diagnostics.push(
				diag(
					"invalid_mutation_contract",
					`Mutation flag '${field}' must be an explicit boolean.`,
					`${path}.${field}`,
				),
			);
			ok = false;
		}
	}
	if (value.approvalRef !== null && !isNonEmptyString(value.approvalRef)) {
		diagnostics.push(
			diag("invalid_mutation_contract", "approvalRef must be a string or null.", `${path}.approvalRef`),
		);
		ok = false;
	}
	if (!ok) return null;
	return {
		schemaVersion: 1,
		apply: value.apply as boolean,
		allowCommit: value.allowCommit as boolean,
		allowPush: value.allowPush as boolean,
		allowMerge: value.allowMerge as boolean,
		approvalRef: value.approvalRef as string | null,
	};
}

const LIMITS_KEYS = [
	"schemaVersion",
	"maxNodes",
	"maxDepth",
	"maxAttemptsPerNode",
	"maxOutstanding",
	"maxActiveCompute",
	"maxRequests",
	"maxRuntimeMs",
	"maxComputeRuntimeMs",
	"maxTokens",
	"maxCostMicrounits",
	"currency",
	"maxHandoffBytes",
	"maxInboxEvents",
] as const;

const COUNT_FIELDS = [
	"maxNodes",
	"maxDepth",
	"maxAttemptsPerNode",
	"maxOutstanding",
	"maxActiveCompute",
	"maxRequests",
	"maxRuntimeMs",
	"maxComputeRuntimeMs",
	"maxHandoffBytes",
	"maxInboxEvents",
] as const;
function validateRunLimits(value: unknown, diagnostics: LaunchContractDiagnostic[], path: string): RunLimitsV1 | null {
	if (!isPlainObject(value)) {
		diagnostics.push(diag("invalid_limits", "Run limits must be an object.", path));
		return null;
	}
	checkUnknownKeys(value, LIMITS_KEYS, diagnostics, path);
	let ok = true;
	if (value.schemaVersion !== 1) {
		diagnostics.push(diag("unknown_version", "RunLimits schemaVersion must be 1.", `${path}.schemaVersion`));
		ok = false;
	}
	for (const field of COUNT_FIELDS) {
		if (!isSafeNonNegativeInt(value[field])) {
			diagnostics.push(
				diag(
					"invalid_budget",
					`Limit '${field}' must be a safe non-negative integer (no NaN/infinity/negative/fraction).`,
					`${path}.${field}`,
				),
			);
			ok = false;
		}
	}
	for (const field of ["maxTokens", "maxCostMicrounits"] as const) {
		const v = value[field];
		if (v !== null && v !== undefined && !isSafeNonNegativeInt(v)) {
			diagnostics.push(
				diag("invalid_budget", `Limit '${field}' must be null or a safe non-negative integer.`, `${path}.${field}`),
			);
			ok = false;
		}
	}
	const currency = value.currency;
	if (currency !== null && currency !== undefined && !isNonEmptyString(currency)) {
		diagnostics.push(diag("invalid_budget", "currency must be null or a non-empty string.", `${path}.currency`));
		ok = false;
	}
	const costBounded = value.maxCostMicrounits !== null && value.maxCostMicrounits !== undefined;
	const currencySet = currency !== null && currency !== undefined;
	if (costBounded !== currencySet) {
		diagnostics.push(
			diag("invalid_budget", "maxCostMicrounits and currency must both be null or both be specified.", path),
		);
		ok = false;
	}
	if (!ok) return null;
	return {
		schemaVersion: 1,
		maxNodes: value.maxNodes as number,
		maxDepth: value.maxDepth as number,
		maxAttemptsPerNode: value.maxAttemptsPerNode as number,
		maxOutstanding: value.maxOutstanding as number,
		maxActiveCompute: value.maxActiveCompute as number,
		maxRequests: value.maxRequests as number,
		maxRuntimeMs: value.maxRuntimeMs as number,
		maxComputeRuntimeMs: value.maxComputeRuntimeMs as number,
		maxTokens: (value.maxTokens ?? null) as number | null,
		maxCostMicrounits: (value.maxCostMicrounits ?? null) as number | null,
		currency: (currency ?? null) as string | null,
		maxHandoffBytes: value.maxHandoffBytes as number,
		maxInboxEvents: value.maxInboxEvents as number,
	};
}

const RESERVATION_KEYS = ["requests", "runtimeMs", "tokens", "costMicrounits"] as const;

function validateReservationVector(
	value: unknown,
	diagnostics: LaunchContractDiagnostic[],
	path: string,
): ReservationVector | null {
	if (!isPlainObject(value)) {
		diagnostics.push(diag("invalid_reservation", "Reservation vector must be an object.", path));
		return null;
	}
	checkUnknownKeys(value, RESERVATION_KEYS, diagnostics, path);
	let ok = true;
	for (const field of ["requests", "runtimeMs"] as const) {
		if (!isSafeNonNegativeInt(value[field])) {
			diagnostics.push(
				diag(
					"invalid_reservation",
					`Reservation '${field}' must be a safe non-negative integer.`,
					`${path}.${field}`,
				),
			);
			ok = false;
		}
	}
	for (const field of ["tokens", "costMicrounits"] as const) {
		const v = value[field];
		if (v !== null && v !== undefined && !isSafeNonNegativeInt(v)) {
			diagnostics.push(
				diag(
					"invalid_reservation",
					`Reservation '${field}' must be null or a safe non-negative integer.`,
					`${path}.${field}`,
				),
			);
			ok = false;
		}
	}
	if (!ok) return null;
	return {
		requests: value.requests as number,
		runtimeMs: value.runtimeMs as number,
		tokens: (value.tokens ?? null) as number | null,
		costMicrounits: (value.costMicrounits ?? null) as number | null,
	};
}

const FENCE_KEYS = [
	"runId",
	"nodeId",
	"attemptId",
	"leaseOwner",
	"leaseEpoch",
	"cancellationGeneration",
	"contractVersion",
] as const;

export function parseLifecycleFence(value: unknown): LifecycleFence {
	const diagnostics: LaunchContractDiagnostic[] = [];
	if (!isPlainObject(value)) throw new Error("invalid_fence: fence must be an object");
	checkUnknownKeys(value, FENCE_KEYS, diagnostics, "fence");
	for (const field of ["runId", "nodeId", "attemptId", "leaseOwner"] as const) {
		if (!isNonEmptyString(value[field]))
			diagnostics.push(diag("invalid_fence", `Fence '${field}' must be a non-empty string.`, `fence.${field}`));
	}
	for (const field of ["leaseEpoch", "cancellationGeneration", "contractVersion"] as const) {
		if (!isSafeNonNegativeInt(value[field])) {
			diagnostics.push(
				diag("invalid_fence", `Fence '${field}' must be a safe non-negative integer.`, `fence.${field}`),
			);
		}
	}
	if (diagnostics.length > 0) throw new Error(diagnostics[0]?.code ?? "invalid_fence");
	return {
		runId: value.runId as string,
		nodeId: value.nodeId as string,
		attemptId: value.attemptId as string,
		leaseOwner: value.leaseOwner as string,
		leaseEpoch: value.leaseEpoch as number,
		cancellationGeneration: value.cancellationGeneration as number,
		contractVersion: value.contractVersion as number,
	};
}

/**
 * Strict parse wrappers over the shared diagnostic validators.
 *
 * Persisted-record parsers (operational/lifecycle-types.ts) MUST use these
 * rather than re-deriving field rules, so one definition of "valid ref /
 * limits / reservation" governs both compilation and storage round-trips.
 */
function parseWithValidator<T>(
	value: unknown,
	path: string,
	validator: (value: unknown, diagnostics: LaunchContractDiagnostic[], path: string) => T | null,
): T {
	const diagnostics: LaunchContractDiagnostic[] = [];
	const parsed = validator(value, diagnostics, path);
	if (parsed === null || diagnostics.length > 0) {
		throw new Error(`${diagnostics[0]?.code ?? "invalid_record"}: ${diagnostics[0]?.message ?? path}`);
	}
	return parsed;
}

export function parseSnapshotRefV1(value: unknown, path = "snapshotRef"): SnapshotRefV1 {
	return parseWithValidator(value, path, validateSnapshotRef);
}

export function parseArtifactRefV1(value: unknown, path = "artifactRef"): ArtifactRefV1 {
	return parseWithValidator(value, path, validateArtifactRef);
}

export function parseRunLimitsV1(value: unknown, path = "limits"): RunLimitsV1 {
	return parseWithValidator(value, path, validateRunLimits);
}

export function parseReservationVector(value: unknown, path = "reservation"): ReservationVector {
	return parseWithValidator(value, path, validateReservationVector);
}

function validateExecutionProfile(
	value: unknown,
	diagnostics: LaunchContractDiagnostic[],
	path: string,
): AgentExecutionProfile | null {
	if (!isPlainObject(value)) {
		diagnostics.push(diag("invalid_execution_profile", "executionProfile must be an object.", path));
		return null;
	}
	let ok = true;
	for (const field of ["tier", "autonomy", "collaboration", "workClass", "editMode"] as const) {
		if (!isNonEmptyString(value[field])) {
			diagnostics.push(
				diag(
					"invalid_execution_profile",
					`executionProfile.${field} must be a non-empty string.`,
					`${path}.${field}`,
				),
			);
			ok = false;
		}
	}
	for (const field of ["maxRequests", "maxRuntimeMs"] as const) {
		if (!isSafeNonNegativeInt(value[field])) {
			diagnostics.push(
				diag(
					"invalid_execution_profile",
					`executionProfile.${field} must be a safe non-negative integer.`,
					`${path}.${field}`,
				),
			);
			ok = false;
		}
	}
	if (!Array.isArray(value.modelPool) || !value.modelPool.every(isNonEmptyString)) {
		diagnostics.push(
			diag(
				"invalid_execution_profile",
				"executionProfile.modelPool must be an array of non-empty strings.",
				`${path}.modelPool`,
			),
		);
		ok = false;
	}
	if (typeof value.modelPoolConstrained !== "boolean") {
		diagnostics.push(
			diag(
				"invalid_execution_profile",
				"executionProfile.modelPoolConstrained must be boolean.",
				`${path}.modelPoolConstrained`,
			),
		);
		ok = false;
	}
	if (!ok) return null;
	return value as unknown as AgentExecutionProfile;
}

function validateToolProfile(
	value: unknown,
	diagnostics: LaunchContractDiagnostic[],
	path: string,
): ResolvedToolProfile | null {
	if (!isPlainObject(value)) {
		diagnostics.push(diag("invalid_tool_profile", "toolProfile must be an object.", path));
		return null;
	}
	let ok = true;
	const maximum = value.maximum;
	if (!Array.isArray(maximum)) {
		diagnostics.push(diag("invalid_tool_profile", "toolProfile.maximum must be an array.", `${path}.maximum`));
		ok = false;
	} else {
		maximum.forEach((entry, index) => {
			if (
				!isPlainObject(entry) ||
				!TOOL_CAPABILITY_SOURCES.includes(entry.source as ToolCapabilitySource) ||
				!isNonEmptyString(entry.name)
			) {
				diagnostics.push(
					diag(
						"invalid_tool_profile",
						`toolProfile.maximum[${index}] must be {source,name} with a known source.`,
						`${path}.maximum.${index}`,
					),
				);
				ok = false;
			}
		});
	}
	if (!isNonEmptyString(value.editMode)) {
		diagnostics.push(
			diag("invalid_tool_profile", "toolProfile.editMode must be a non-empty string.", `${path}.editMode`),
		);
		ok = false;
	}
	if (typeof value.allowDiscovery !== "boolean" || typeof value.toolsConstrained !== "boolean") {
		diagnostics.push(
			diag("invalid_tool_profile", "toolProfile.allowDiscovery/toolsConstrained must be booleans.", path),
		);
		ok = false;
	}
	if (!isNonEmptyString(value.tier) || !isNonEmptyString(value.autonomy)) {
		diagnostics.push(diag("invalid_tool_profile", "toolProfile.tier/autonomy must be non-empty strings.", path));
		ok = false;
	}
	if (!ok) return null;
	return value as unknown as ResolvedToolProfile;
}

function validateCollaborationPolicy(
	value: unknown,
	diagnostics: LaunchContractDiagnostic[],
	path: string,
): CollaborationPolicy | null {
	if (!isPlainObject(value)) {
		diagnostics.push(diag("invalid_collaboration_policy", "collaborationPolicy must be an object.", path));
		return null;
	}
	let ok = true;
	for (const field of ["mode", "peerScope", "wakePolicy"] as const) {
		if (!isNonEmptyString(value[field])) {
			diagnostics.push(
				diag(
					"invalid_collaboration_policy",
					`collaborationPolicy.${field} must be a non-empty string.`,
					`${path}.${field}`,
				),
			);
			ok = false;
		}
	}
	if (!Array.isArray(value.allowedPeers) || !value.allowedPeers.every(isNonEmptyString)) {
		diagnostics.push(
			diag(
				"invalid_collaboration_policy",
				"collaborationPolicy.allowedPeers must be string[].",
				`${path}.allowedPeers`,
			),
		);
		ok = false;
	}
	if (!Array.isArray(value.familyIds) || !value.familyIds.every(isNonEmptyString)) {
		diagnostics.push(
			diag("invalid_collaboration_policy", "collaborationPolicy.familyIds must be string[].", `${path}.familyIds`),
		);
		ok = false;
	}
	if (typeof value.wakeBudget !== "number" || !Number.isSafeInteger(value.wakeBudget)) {
		diagnostics.push(
			diag(
				"invalid_collaboration_policy",
				"collaborationPolicy.wakeBudget must be a safe integer.",
				`${path}.wakeBudget`,
			),
		);
		ok = false;
	}
	if (typeof value.allowBusyModelReply !== "boolean") {
		diagnostics.push(
			diag(
				"invalid_collaboration_policy",
				"collaborationPolicy.allowBusyModelReply must be boolean.",
				`${path}.allowBusyModelReply`,
			),
		);
		ok = false;
	}
	if (!ok) return null;
	return value as unknown as CollaborationPolicy;
}

const POLICY_KEYS = [
	"schemaVersion",
	"role",
	"topology",
	"executionProfile",
	"toolProfile",
	"collaborationPolicy",
	"mutation",
	"limits",
	"baseline",
	"grantRefs",
	"harnessRef",
	"projectionVersion",
	"environmentRef",
	"isolationLevel",
] as const;

function validateRuntimePolicy(
	value: unknown,
	diagnostics: LaunchContractDiagnostic[],
	path: string,
): RuntimePolicySnapshotV1 | null {
	if (!isPlainObject(value)) {
		diagnostics.push(diag("invalid_policy", "Policy snapshot must be an object.", path));
		return null;
	}
	checkUnknownKeys(value, POLICY_KEYS, diagnostics, path);
	let ok = true;
	if (value.schemaVersion !== 1) {
		diagnostics.push(
			diag("unknown_version", "RuntimePolicySnapshot schemaVersion must be 1.", `${path}.schemaVersion`),
		);
		ok = false;
	}
	if (!KNOWN_AGENT_ROLES.includes(value.role as AgentRole)) {
		diagnostics.push(diag("unknown_role", `Unknown role '${String(value.role)}'.`, `${path}.role`));
		ok = false;
	}
	if (!KNOWN_TOPOLOGIES.includes(value.topology as TopologyKind)) {
		diagnostics.push(diag("invalid_topology", `Unknown topology '${String(value.topology)}'.`, `${path}.topology`));
		ok = false;
	}
	const executionProfile = validateExecutionProfile(value.executionProfile, diagnostics, `${path}.executionProfile`);
	const toolProfile = validateToolProfile(value.toolProfile, diagnostics, `${path}.toolProfile`);
	const collaborationPolicy = validateCollaborationPolicy(
		value.collaborationPolicy,
		diagnostics,
		`${path}.collaborationPolicy`,
	);
	const mutation = validateMutationContract(value.mutation, diagnostics, `${path}.mutation`);
	const limits = validateRunLimits(value.limits, diagnostics, `${path}.limits`);
	const baseline = validateSnapshotRef(value.baseline, diagnostics, `${path}.baseline`);
	if (!executionProfile || !toolProfile || !collaborationPolicy || !mutation || !limits || !baseline) ok = false;
	if (!Array.isArray(value.grantRefs) || !value.grantRefs.every(isNonEmptyString)) {
		diagnostics.push(diag("invalid_policy", "grantRefs must be an array of non-empty strings.", `${path}.grantRefs`));
		ok = false;
	}
	if (!isNonEmptyString(value.harnessRef) || !isNonEmptyString(value.environmentRef)) {
		diagnostics.push(diag("invalid_policy", "harnessRef/environmentRef must be non-empty strings.", path));
		ok = false;
	}
	if (value.projectionVersion !== 1) {
		diagnostics.push(diag("unknown_version", "projectionVersion must be 1.", `${path}.projectionVersion`));
		ok = false;
	}
	if (value.isolationLevel !== "cooperative-worktree" && value.isolationLevel !== "confined") {
		diagnostics.push(
			diag(
				"invalid_isolation",
				"isolationLevel must be 'cooperative-worktree' or 'confined'.",
				`${path}.isolationLevel`,
			),
		);
		ok = false;
	}
	if (!ok || !executionProfile || !toolProfile || !collaborationPolicy || !mutation || !limits || !baseline)
		return null;
	return {
		schemaVersion: 1,
		role: value.role as AgentRole,
		topology: value.topology as TopologyKind,
		executionProfile,
		toolProfile,
		collaborationPolicy,
		mutation,
		limits,
		baseline,
		grantRefs: [...(value.grantRefs as string[])],
		harnessRef: value.harnessRef as string,
		projectionVersion: 1,
		environmentRef: value.environmentRef as string,
		isolationLevel: value.isolationLevel as "cooperative-worktree" | "confined",
	};
}

// ---------------------------------------------------------------------------
// Mission hashing (array order significant; every visible field hashed).
// ---------------------------------------------------------------------------

export function computeMissionHash(capsule: MissionCapsule): string {
	const canonical = canonicalJson({
		schemaVersion: capsule.schemaVersion,
		objective: capsule.objective,
		nonGoals: [...capsule.nonGoals],
		relevantRationale: "relevantRationale" in capsule ? (capsule.relevantRationale ?? null) : null,
		baselineRef: capsule.baselineRef,
		inputs: capsule.inputs.map(i => ({
			artifact: i.artifact,
			description: i.description,
			grantId: i.grantId,
		})),
		readableScope: [...capsule.readableScope],
		writableScope: [...capsule.writableScope],
		acceptance: capsule.acceptance.map(a => ({ id: a.id, description: a.description })),
		verificationPlanRef: "verificationPlanRef" in capsule ? (capsule.verificationPlanRef ?? null) : null,
		capabilitySummary: [...capsule.capabilitySummary],
		localBudget: {
			maxRequests: capsule.localBudget.maxRequests,
			maxRuntimeMs: capsule.localBudget.maxRuntimeMs,
			maxTokens: capsule.localBudget.maxTokens ?? null,
		},
		escalationContractRef: "escalationContractRef" in capsule ? (capsule.escalationContractRef ?? null) : null,
		outputSchemaRef: "outputSchemaRef" in capsule ? (capsule.outputSchemaRef ?? null) : null,
	});
	return sha256Hex(canonical);
}

export function computePolicyHash(policy: RuntimePolicySnapshotV1): string {
	const canonical = canonicalJson({
		schemaVersion: policy.schemaVersion,
		role: policy.role,
		topology: policy.topology,
		executionProfile: policy.executionProfile,
		toolProfile: policy.toolProfile,
		collaborationPolicy: policy.collaborationPolicy,
		mutation: policy.mutation,
		limits: policy.limits,
		baseline: policy.baseline,
		grantRefs: [...policy.grantRefs],
		harnessRef: policy.harnessRef,
		projectionVersion: policy.projectionVersion,
		environmentRef: policy.environmentRef,
		isolationLevel: policy.isolationLevel,
	});
	return sha256Hex(canonical);
}

/**
 * Content-addressed capability manifest reference: digest of the
 * source-qualified tool ceiling plus harness ref. Never a synthetic
 * role-derived string. Runtime CAS registration lands with C0 admission.
 */
export function computeCapabilityManifestRef(policy: RuntimePolicySnapshotV1): string {
	const maximum = [...policy.toolProfile.maximum]
		.map(entry => ({ source: entry.source, name: entry.name }))
		.sort((a, b) =>
			a.source === b.source ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.source < b.source ? -1 : 1,
		);
	return `cap-${sha256Hex(canonicalJson({ maximum, harnessRef: policy.harnessRef }))}`;
}

// ---------------------------------------------------------------------------
// Compilation (pure; allocation-free).
// ---------------------------------------------------------------------------

const CAPSULE_KEYS = [
	"schemaVersion",
	"objective",
	"nonGoals",
	"relevantRationale",
	"baselineRef",
	"inputs",
	"readableScope",
	"writableScope",
	"acceptance",
	"verificationPlanRef",
	"capabilitySummary",
	"localBudget",
	"escalationContractRef",
	"outputSchemaRef",
] as const;

const INPUT_KEYS = ["artifact", "description", "grantId"] as const;
const CRITERION_KEYS = ["id", "description"] as const;
const BUDGET_KEYS = ["maxRequests", "maxRuntimeMs", "maxTokens"] as const;

function validateMissionCapsule(
	value: unknown,
	diagnostics: LaunchContractDiagnostic[],
	path: string,
): MissionCapsule | null {
	if (!isPlainObject(value)) {
		diagnostics.push(diag("missing_capsule", "Capsule must be an object.", path));
		return null;
	}
	checkUnknownKeys(value, CAPSULE_KEYS, diagnostics, path);
	let ok = true;
	if (value.schemaVersion !== 1) {
		diagnostics.push(diag("unknown_version", "MissionCapsule schemaVersion must be 1.", `${path}.schemaVersion`));
		ok = false;
	}
	// Only the objective (documented identity field) is trimmed; every other
	// string is hashed exactly as supplied.
	const objective = typeof value.objective === "string" ? value.objective.trim() : "";
	if (!objective) {
		diagnostics.push(diag("missing_objective", "Objective is required and cannot be empty.", `${path}.objective`));
		ok = false;
	}
	if (!Array.isArray(value.nonGoals) || !value.nonGoals.every(isNonEmptyString)) {
		diagnostics.push(diag("invalid_capsule", "nonGoals must be an array of non-empty strings.", `${path}.nonGoals`));
		ok = false;
	}
	if (value.relevantRationale !== undefined && typeof value.relevantRationale !== "string") {
		diagnostics.push(
			diag("invalid_capsule", "relevantRationale must be a string when present.", `${path}.relevantRationale`),
		);
		ok = false;
	}
	const baselineRef = validateSnapshotRef(value.baselineRef, diagnostics, `${path}.baselineRef`);
	if (!baselineRef) ok = false;
	const inputs: MissionInputV1[] = [];
	if (!Array.isArray(value.inputs)) {
		diagnostics.push(diag("invalid_capsule", "inputs must be an array.", `${path}.inputs`));
		ok = false;
	} else {
		value.inputs.forEach((entry, index) => {
			const entryPath = `${path}.inputs.${index}`;
			if (!isPlainObject(entry)) {
				diagnostics.push(diag("invalid_capsule", "Mission input must be an object.", entryPath));
				ok = false;
				return;
			}
			checkUnknownKeys(entry, INPUT_KEYS, diagnostics, entryPath);
			const artifact = validateArtifactRef(entry.artifact, diagnostics, `${entryPath}.artifact`);
			if (typeof entry.description !== "string" || !isNonEmptyString(entry.grantId)) {
				diagnostics.push(
					diag("invalid_capsule", "Mission input needs a string description and non-empty grantId.", entryPath),
				);
				ok = false;
			}
			if (artifact)
				inputs.push({ artifact, description: entry.description as string, grantId: entry.grantId as string });
			else ok = false;
		});
	}
	for (const field of ["readableScope", "writableScope"] as const) {
		const scopes = value[field];
		if (!Array.isArray(scopes) || !scopes.every((s): s is string => typeof s === "string")) {
			diagnostics.push(diag("invalid_scope", `${field} must be an array of strings.`, `${path}.${field}`));
			ok = false;
			continue;
		}
		scopes.forEach((scope, index) => {
			const normalized = normalizeScopeEntry(scope);
			if (!normalized) {
				diagnostics.push(
					diag(
						URI_SCHEME.test(scope.trim()) ? "unknown_scope_backend" : "invalid_scope_escape",
						`Scope entry '${scope}' is not a valid repository-relative root (absolute/drive/UNC/encoded/escaping/unknown-backend rejected).`,
						`${path}.${field}.${index}`,
					),
				);
				ok = false;
			}
		});
	}
	const acceptance: MissionCriterion[] = [];
	if (!Array.isArray(value.acceptance) || value.acceptance.length === 0) {
		diagnostics.push(diag("invalid_capsule", "acceptance must be a non-empty array.", `${path}.acceptance`));
		ok = false;
	} else {
		value.acceptance.forEach((criterion, index) => {
			const criterionPath = `${path}.acceptance.${index}`;
			if (!isPlainObject(criterion)) {
				diagnostics.push(diag("invalid_capsule", "Acceptance criterion must be an object.", criterionPath));
				ok = false;
				return;
			}
			checkUnknownKeys(criterion, CRITERION_KEYS, diagnostics, criterionPath);
			if (!isNonEmptyString(criterion.id) || typeof criterion.description !== "string") {
				diagnostics.push(
					diag(
						"invalid_capsule",
						"Acceptance criterion needs a non-empty id and string description.",
						criterionPath,
					),
				);
				ok = false;
				return;
			}
			acceptance.push({ id: criterion.id, description: criterion.description });
		});
	}
	if (value.verificationPlanRef !== undefined && typeof value.verificationPlanRef !== "string") {
		diagnostics.push(
			diag("invalid_capsule", "verificationPlanRef must be a string when present.", `${path}.verificationPlanRef`),
		);
		ok = false;
	}
	if (
		!Array.isArray(value.capabilitySummary) ||
		!value.capabilitySummary.every((s): s is string => typeof s === "string")
	) {
		diagnostics.push(
			diag("invalid_capsule", "capabilitySummary must be an array of strings.", `${path}.capabilitySummary`),
		);
		ok = false;
	}
	const budgetRaw = value.localBudget;
	if (!isPlainObject(budgetRaw)) {
		diagnostics.push(diag("invalid_budget", "localBudget must be an object.", `${path}.localBudget`));
		ok = false;
	} else {
		checkUnknownKeys(budgetRaw, BUDGET_KEYS, diagnostics, `${path}.localBudget`);
		for (const field of ["maxRequests", "maxRuntimeMs"] as const) {
			if (!isSafeNonNegativeInt(budgetRaw[field])) {
				diagnostics.push(
					diag(
						"invalid_budget",
						`localBudget.${field} must be a safe non-negative integer.`,
						`${path}.localBudget.${field}`,
					),
				);
				ok = false;
			}
		}
		const maxTokens = budgetRaw.maxTokens;
		if (maxTokens !== undefined && maxTokens !== null && !isSafeNonNegativeInt(maxTokens)) {
			diagnostics.push(
				diag(
					"invalid_budget",
					"localBudget.maxTokens must be null or a safe non-negative integer.",
					`${path}.localBudget.maxTokens`,
				),
			);
			ok = false;
		}
	}
	for (const field of ["escalationContractRef", "outputSchemaRef"] as const) {
		if (value[field] !== undefined && typeof value[field] !== "string") {
			diagnostics.push(diag("invalid_capsule", `${field} must be a string when present.`, `${path}.${field}`));
			ok = false;
		}
	}
	if (!ok || !baselineRef) return null;
	const capsule: MissionCapsule = {
		schemaVersion: 1,
		objective,
		nonGoals: [...(value.nonGoals as string[])],
		...(typeof value.relevantRationale === "string" ? { relevantRationale: value.relevantRationale } : {}),
		baselineRef,
		inputs,
		readableScope: [...(value.readableScope as string[])],
		writableScope: [...(value.writableScope as string[])],
		acceptance,
		...(typeof value.verificationPlanRef === "string" ? { verificationPlanRef: value.verificationPlanRef } : {}),
		capabilitySummary: [...(value.capabilitySummary as string[])],
		localBudget: {
			maxRequests: (budgetRaw as Record<string, unknown>).maxRequests as number,
			maxRuntimeMs: (budgetRaw as Record<string, unknown>).maxRuntimeMs as number,
			...((budgetRaw as Record<string, unknown>).maxTokens !== undefined
				? { maxTokens: (budgetRaw as Record<string, unknown>).maxTokens as number | null }
				: {}),
		},
		...(typeof value.escalationContractRef === "string"
			? { escalationContractRef: value.escalationContractRef }
			: {}),
		...(typeof value.outputSchemaRef === "string" ? { outputSchemaRef: value.outputSchemaRef } : {}),
	};
	return capsule;
}

function deepFreezeCopy<T>(value: T): T {
	if (Array.isArray(value)) return Object.freeze(value.map(item => deepFreezeCopy(item))) as T;
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value)) out[key] = deepFreezeCopy(value[key]);
		return Object.freeze(out) as T;
	}
	return value;
}

export function compileLaunchContract(input: LaunchCompileInput): LaunchCompileResult {
	const diagnostics: LaunchContractDiagnostic[] = [];
	if (!isPlainObject(input)) {
		return { ok: false, diagnostics: [diag("missing_capsule", "Compile input must be an object.")] };
	}
	const capsule = validateMissionCapsule((input as Record<string, unknown>).capsule, diagnostics, "capsule");
	const policy = validateRuntimePolicy((input as Record<string, unknown>).policy, diagnostics, "policy");
	if (diagnostics.length > 0 || !capsule || !policy) {
		return { ok: false, diagnostics: Object.freeze([...diagnostics]) };
	}

	// Required inputs must resolve to capsule artifacts whose grants the
	// policy actually holds — never an empty successful mission.
	const requiredInputIds = (input as { requiredInputIds?: unknown }).requiredInputIds ?? [];
	if (!Array.isArray(requiredInputIds)) {
		return {
			ok: false,
			diagnostics: [diag("missing_required_input", "requiredInputIds must be an array.", "requiredInputIds")],
		};
	}
	const grantIds = new Set(policy.grantRefs);
	const byArtifactId = new Map(capsule.inputs.map(i => [i.artifact.artifactId, i] as const));
	for (const reqId of requiredInputIds) {
		const resolved = typeof reqId === "string" ? byArtifactId.get(reqId) : undefined;
		if (!resolved || !grantIds.has(resolved.grantId)) {
			diagnostics.push(
				diag(
					"missing_required_input",
					`Required input '${String(reqId)}' does not resolve to a granted capsule artifact.`,
					"requiredInputIds",
				),
			);
		}
	}

	// Parent narrowing: the child policy may only hold grants its parent
	// holds, and must not exceed the parent depth. Literal scope-vs-scope
	// narrowing (equal inherited globs or narrower concrete roots via
	// isScopeSubsetOfParent) is proven at admission preflight, where the
	// parent capsule scopes are loadable from the store.
	const parent = (input as { parentPolicy?: unknown }).parentPolicy ?? null;
	if (parent !== null) {
		if (!isPlainObject(parent)) {
			diagnostics.push(diag("invalid_policy", "parentPolicy must be an object or null.", "parentPolicy"));
		} else {
			const parentPolicy = validateRuntimePolicy(parent, diagnostics, "parentPolicy");
			if (parentPolicy) {
				const parentGrants = new Set(parentPolicy.grantRefs);
				for (const grant of policy.grantRefs) {
					if (!parentGrants.has(grant)) {
						diagnostics.push(
							diag(
								"scope_not_proven_subset",
								`Grant '${grant}' is not held by the parent policy.`,
								"policy.grantRefs",
							),
						);
					}
				}
				if (policy.limits.maxDepth > parentPolicy.limits.maxDepth) {
					diagnostics.push(
						diag(
							"depth_exceeds_parent",
							`Child maxDepth (${policy.limits.maxDepth}) exceeds parent maxDepth (${parentPolicy.limits.maxDepth}).`,
							"policy.limits.maxDepth",
						),
					);
				}
			}
		}
	}

	if (diagnostics.length > 0) {
		return { ok: false, diagnostics: Object.freeze([...diagnostics]) };
	}

	const frozenCapsule = deepFreezeCopy(capsule);
	const frozenPolicy = deepFreezeCopy(policy);
	const missionHash = computeMissionHash(frozenCapsule);
	const policyHash = computePolicyHash(frozenPolicy);
	const compiled: CompiledLaunchContract = Object.freeze({
		schemaVersion: 1,
		contractVersion: LAUNCH_CONTRACT_VERSION,
		capsule: frozenCapsule,
		policy: frozenPolicy,
		missionHash,
		policyHash,
	});
	return { ok: true, compiled };
}

function validateBinding(value: unknown): { diagnostics: LaunchContractDiagnostic[]; binding: LaunchBinding | null } {
	const diagnostics: LaunchContractDiagnostic[] = [];
	if (!isPlainObject(value)) {
		return { diagnostics: [diag("invalid_binding", "Binding must be an object.", "binding")], binding: null };
	}
	let ok = true;
	for (const field of ["runId", "nodeId", "attemptId", "budgetReservationId"] as const) {
		if (!isNonEmptyString(value[field])) {
			diagnostics.push(
				diag(
					"invalid_binding",
					`Binding '${field}' must be a non-empty runtime-issued string.`,
					`binding.${field}`,
				),
			);
			ok = false;
		}
	}
	const owner = value.ownerNodeId;
	if (owner !== null && !isNonEmptyString(owner)) {
		diagnostics.push(
			diag(
				"invalid_binding",
				"Binding ownerNodeId must be null (root) or a non-empty string.",
				"binding.ownerNodeId",
			),
		);
		ok = false;
	}
	for (const field of ["leaseEpoch", "cancellationGeneration"] as const) {
		if (!isSafeNonNegativeInt(value[field])) {
			diagnostics.push(
				diag("invalid_binding", `Binding '${field}' must be a safe non-negative integer.`, `binding.${field}`),
			);
			ok = false;
		}
	}
	if (!ok) return { diagnostics, binding: null };
	return {
		diagnostics,
		binding: {
			runId: value.runId as string,
			nodeId: value.nodeId as string,
			ownerNodeId: owner as string | null,
			attemptId: value.attemptId as string,
			budgetReservationId: value.budgetReservationId as string,
			leaseEpoch: value.leaseEpoch as number,
			cancellationGeneration: value.cancellationGeneration as number,
		},
	};
}

export function bindLaunchContract(compiled: CompiledLaunchContract, binding: LaunchBinding): LaunchContract {
	const checked = validateBinding(binding);
	if (!checked.binding) throw new Error(checked.diagnostics[0]?.code ?? "invalid_binding");
	const validBinding = checked.binding;
	if (!isPlainObject(compiled) || compiled.schemaVersion !== 1) throw new Error("unknown_version");
	// Tamper-evident: bound hashes must reproduce from the frozen snapshot.
	if (computeMissionHash(compiled.capsule) !== compiled.missionHash) throw new Error("contract_hash_mismatch");
	if (computePolicyHash(compiled.policy) !== compiled.policyHash) throw new Error("contract_hash_mismatch");
	if (!KNOWN_AGENT_ROLES.includes(compiled.policy.role) || !KNOWN_TOPOLOGIES.includes(compiled.policy.topology)) {
		throw new Error("unknown_role");
	}
	const envelope: LaunchEnvelope = Object.freeze({
		schemaVersion: 1,
		version: LAUNCH_CONTRACT_VERSION,
		runId: validBinding.runId,
		nodeId: validBinding.nodeId,
		ownerNodeId: validBinding.ownerNodeId,
		attemptId: validBinding.attemptId,
		role: compiled.policy.role,
		topology: compiled.policy.topology,
		missionHash: compiled.missionHash,
		policyHash: compiled.policyHash,
		harnessVersion: compiled.policy.harnessRef,
		capabilityManifestRef: computeCapabilityManifestRef(compiled.policy),
		budgetReservationId: validBinding.budgetReservationId,
		executionEnvironmentRef: compiled.policy.environmentRef,
		leaseEpoch: validBinding.leaseEpoch,
		cancellationGeneration: validBinding.cancellationGeneration,
	});
	return Object.freeze({
		capsule: compiled.capsule,
		envelope,
		policy: compiled.policy,
		contractVersion: compiled.contractVersion,
		policySchemaVersion: 1 as const,
		harnessSchemaVersion: 1 as const,
	});
}

const CONTRACT_KEYS = [
	"capsule",
	"envelope",
	"policy",
	"contractVersion",
	"policySchemaVersion",
	"harnessSchemaVersion",
] as const;
const ENVELOPE_KEYS = [
	"schemaVersion",
	"version",
	"runId",
	"nodeId",
	"ownerNodeId",
	"attemptId",
	"role",
	"topology",
	"missionHash",
	"policyHash",
	"harnessVersion",
	"capabilityManifestRef",
	"budgetReservationId",
	"executionEnvironmentRef",
	"leaseEpoch",
	"cancellationGeneration",
] as const;

/**
 * Strictly revalidates a serialized contract. Recomputes both hashes and
 * the capability manifest ref; any mismatch, unknown version, or extra
 * authority field rejects instead of being dropped.
 */
export function parseLaunchContract(value: unknown): LaunchContract {
	if (!isPlainObject(value)) throw new Error("Invalid LaunchContract: expected object");
	checkThrow(value, CONTRACT_KEYS, "contract");
	const capsule = validateMissionCapsule(value.capsule, throwDiagnostics("contract.capsule"), "capsule");
	const policy = validateRuntimePolicy(value.policy, throwDiagnostics("contract.policy"), "policy");
	if (!capsule || !policy) throw new Error("Invalid LaunchContract: capsule/policy failed validation");
	if (!isPlainObject(value.envelope)) throw new Error("Invalid LaunchContract: envelope must be an object");
	checkThrow(value.envelope as Record<string, unknown>, ENVELOPE_KEYS, "contract.envelope");
	const envelope = value.envelope as Record<string, unknown>;
	if (envelope.schemaVersion !== 1 || envelope.version !== LAUNCH_CONTRACT_VERSION) {
		throw new Error("Invalid LaunchContract: unknown version");
	}
	if (
		value.contractVersion !== LAUNCH_CONTRACT_VERSION ||
		value.policySchemaVersion !== 1 ||
		value.harnessSchemaVersion !== 1
	) {
		throw new Error("Invalid LaunchContract: unknown version");
	}
	if (computeMissionHash(capsule) !== envelope.missionHash)
		throw new Error("Invalid LaunchContract: contract_hash_mismatch");
	if (computePolicyHash(policy) !== envelope.policyHash)
		throw new Error("Invalid LaunchContract: contract_hash_mismatch");
	if (computeCapabilityManifestRef(policy) !== envelope.capabilityManifestRef) {
		throw new Error("Invalid LaunchContract: contract_hash_mismatch");
	}
	for (const field of ["runId", "nodeId", "attemptId", "budgetReservationId"] as const) {
		if (!isNonEmptyString(envelope[field]))
			throw new Error(`Invalid LaunchContract: envelope.${field} must be non-empty`);
	}
	if (envelope.ownerNodeId !== null && !isNonEmptyString(envelope.ownerNodeId)) {
		throw new Error("Invalid LaunchContract: envelope.ownerNodeId must be null or non-empty");
	}
	for (const field of ["leaseEpoch", "cancellationGeneration"] as const) {
		if (!isSafeNonNegativeInt(envelope[field]))
			throw new Error(`Invalid LaunchContract: envelope.${field} must be a safe non-negative integer`);
	}
	return Object.freeze({
		capsule,
		envelope: {
			schemaVersion: 1 as const,
			version: LAUNCH_CONTRACT_VERSION,
			runId: envelope.runId as string,
			nodeId: envelope.nodeId as string,
			ownerNodeId: envelope.ownerNodeId as string | null,
			attemptId: envelope.attemptId as string,
			role: policy.role,
			topology: policy.topology,
			missionHash: envelope.missionHash as string,
			policyHash: envelope.policyHash as string,
			harnessVersion: envelope.harnessVersion as string,
			capabilityManifestRef: envelope.capabilityManifestRef as string,
			budgetReservationId: envelope.budgetReservationId as string,
			executionEnvironmentRef: envelope.executionEnvironmentRef as string,
			leaseEpoch: envelope.leaseEpoch as number,
			cancellationGeneration: envelope.cancellationGeneration as number,
		},
		policy,
		contractVersion: LAUNCH_CONTRACT_VERSION,
		policySchemaVersion: 1 as const,
		harnessSchemaVersion: 1 as const,
	});
}

function checkThrow(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`Invalid LaunchContract: unknown field '${path}.${key}'`);
	}
}

function throwDiagnostics(path: string): LaunchContractDiagnostic[] {
	const diagnostics: LaunchContractDiagnostic[] = [];
	const proxy = new Proxy(diagnostics, {
		get(target, prop, receiver) {
			if (prop === "push") {
				return (...items: LaunchContractDiagnostic[]) => {
					throw new Error(
						`Invalid LaunchContract at ${path}: ${items[0]?.code ?? "invalid"} ${items[0]?.message ?? ""}`,
					);
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});
	return proxy;
}

const HANDOFF_KEYS = [
	"schemaVersion",
	"kind",
	"eventId",
	"fence",
	"ownerNodeId",
	"targetNodeId",
	"correlationId",
	"missionHash",
	"baseline",
	"outcome",
	"summary",
	"manifest",
	"evidenceRefs",
	"observedExitCode",
	"changedPaths",
	"obligationIds",
	"proposedNextAction",
] as const;

/** Strict handoff parser enforcing per-kind event identity + outcome rules. */
export function parseLifecycleHandoff(value: unknown): LifecycleHandoffV1 {
	if (!isPlainObject(value)) throw new Error("invalid_handoff: handoff must be an object");
	checkThrow(value, HANDOFF_KEYS, "handoff");
	if (value.schemaVersion !== 1) throw new Error("invalid_handoff: unknown version");
	const kind = value.kind;
	if (kind !== "settled" && kind !== "clarification" && kind !== "reply")
		throw new Error("invalid_handoff: unknown kind");
	const fence = parseLifecycleFence(value.fence);
	if (!isHex64(value.missionHash)) throw new Error("invalid_handoff: missionHash must be 64-hex");
	if (typeof value.summary !== "string") throw new Error("invalid_handoff: summary must be a string");
	const eventId = value.eventId;
	if (!isNonEmptyString(eventId)) throw new Error("invalid_handoff: eventId required");
	if (kind === "settled") {
		if (eventId !== `settled:${fence.attemptId}`)
			throw new Error("invalid_handoff: settled eventId must be settled:<attemptId>");
		if (value.targetNodeId !== null) throw new Error("invalid_handoff: settled targetNodeId must be null");
		if (value.outcome === null || value.outcome === undefined)
			throw new Error("invalid_handoff: settled outcome required");
	} else if (kind === "clarification") {
		if (!eventId.startsWith(`clarification:${fence.attemptId}:`) || eventId === `clarification:${fence.attemptId}:`) {
			throw new Error("invalid_handoff: clarification eventId must be clarification:<attemptId>:<requestId>");
		}
		if (!isNonEmptyString(value.ownerNodeId)) throw new Error("invalid_handoff: clarification ownerNodeId required");
		if (value.outcome !== null && value.outcome !== undefined)
			throw new Error("invalid_handoff: clarification outcome must be null");
	} else {
		if (!isNonEmptyString(value.correlationId)) throw new Error("invalid_handoff: reply correlationId required");
		if (eventId !== `reply:${value.correlationId}`)
			throw new Error("invalid_handoff: reply eventId must be reply:<correlationId>");
		if (!isNonEmptyString(value.targetNodeId)) throw new Error("invalid_handoff: reply targetNodeId required");
	}
	const outcome = value.outcome ?? null;
	if (
		outcome !== null &&
		!["completed", "blocked", "failed", "cancelled", "needs-replan"].includes(outcome as string)
	) {
		throw new Error("invalid_handoff: unknown outcome");
	}
	for (const field of ["evidenceRefs", "changedPaths", "obligationIds"] as const) {
		const arr = value[field];
		if (!Array.isArray(arr) || !arr.every((s): s is string => typeof s === "string")) {
			throw new Error(`invalid_handoff: ${field} must be string[]`);
		}
	}
	const exitCode = value.observedExitCode;
	if (exitCode !== null && exitCode !== undefined && !Number.isSafeInteger(exitCode)) {
		throw new Error("invalid_handoff: observedExitCode must be a safe integer or null");
	}
	let manifest: ArtifactRefV1 | null = null;
	if (value.manifest !== null && value.manifest !== undefined) {
		const diagnostics: LaunchContractDiagnostic[] = [];
		const parsed = validateArtifactRef(value.manifest, diagnostics, "handoff.manifest");
		if (!parsed) throw new Error(`invalid_handoff: ${diagnostics[0]?.code ?? "bad manifest"}`);
		manifest = parsed;
	}
	const diagnostics: LaunchContractDiagnostic[] = [];
	const baseline = validateSnapshotRef(value.baseline, diagnostics, "handoff.baseline");
	if (!baseline) throw new Error(`invalid_handoff: ${diagnostics[0]?.code ?? "bad baseline"}`);
	const proposed = value.proposedNextAction;
	if (proposed !== null && proposed !== undefined && typeof proposed !== "string") {
		throw new Error("invalid_handoff: proposedNextAction must be a string or null");
	}
	const target = value.targetNodeId;
	if (target !== null && target !== undefined && !isNonEmptyString(target)) {
		throw new Error("invalid_handoff: targetNodeId must be null or non-empty");
	}
	const owner = value.ownerNodeId;
	if (owner !== null && owner !== undefined && !isNonEmptyString(owner)) {
		throw new Error("invalid_handoff: ownerNodeId must be null or non-empty");
	}
	const correlation = value.correlationId;
	if (correlation !== null && correlation !== undefined && typeof correlation !== "string") {
		throw new Error("invalid_handoff: correlationId must be a string or null");
	}
	return {
		schemaVersion: 1,
		kind,
		eventId,
		fence,
		ownerNodeId: (owner ?? null) as string | null,
		targetNodeId: (target ?? null) as string | null,
		correlationId: (correlation ?? null) as string | null,
		missionHash: value.missionHash as string,
		baseline,
		outcome: outcome as LifecycleHandoffV1["outcome"],
		summary: value.summary as string,
		manifest,
		evidenceRefs: [...(value.evidenceRefs as string[])],
		observedExitCode: (exitCode ?? null) as number | null,
		changedPaths: [...(value.changedPaths as string[])],
		obligationIds: [...(value.obligationIds as string[])],
		proposedNextAction: (proposed ?? null) as string | null,
	};
}

const OBLIGATION_KEYS = [
	"schemaVersion",
	"obligationId",
	"runId",
	"nodeId",
	"criterionId",
	"kind",
	"state",
	"evidenceReceiptIds",
	"waiverAuthorizationRef",
	"version",
] as const;

/** Strict obligation parser: resolved needs evidence, waived needs authorization. */
export function parseObligationV1(value: unknown): ObligationV1 {
	if (!isPlainObject(value)) throw new Error("invalid_obligation: obligation must be an object");
	checkThrow(value, OBLIGATION_KEYS, "obligation");
	if (value.schemaVersion !== 1) throw new Error("invalid_obligation: unknown version");
	for (const field of ["obligationId", "runId", "nodeId", "criterionId"] as const) {
		if (!isNonEmptyString(value[field])) throw new Error(`invalid_obligation: ${field} must be non-empty`);
	}
	if (
		!["mandatory_criterion", "unresolved_dependency", "scope_verification", "publication_partial"].includes(
			value.kind as string,
		)
	) {
		throw new Error("invalid_obligation: unknown kind");
	}
	const state = value.state;
	if (state !== "open" && state !== "resolved" && state !== "waived")
		throw new Error("invalid_obligation: unknown state");
	if (!Array.isArray(value.evidenceReceiptIds) || !value.evidenceReceiptIds.every(isNonEmptyString)) {
		throw new Error("invalid_obligation: evidenceReceiptIds must be string[]");
	}
	const waiver = value.waiverAuthorizationRef;
	if (waiver !== null && waiver !== undefined && !isNonEmptyString(waiver)) {
		throw new Error("invalid_obligation: waiverAuthorizationRef must be null or non-empty");
	}
	if (!isSafeNonNegativeInt(value.version))
		throw new Error("invalid_obligation: version must be a safe non-negative integer");
	if (state === "resolved" && value.evidenceReceiptIds.length === 0) {
		throw new Error("invalid_obligation: resolved obligations require evidenceReceiptIds");
	}
	if (state === "waived" && (waiver === null || waiver === undefined)) {
		throw new Error("invalid_obligation: waived obligations require waiverAuthorizationRef");
	}
	return {
		schemaVersion: 1,
		obligationId: value.obligationId as string,
		runId: value.runId as string,
		nodeId: value.nodeId as string,
		criterionId: value.criterionId as string,
		kind: value.kind as ObligationV1["kind"],
		state,
		evidenceReceiptIds: [...(value.evidenceReceiptIds as string[])],
		waiverAuthorizationRef: (waiver ?? null) as string | null,
		version: value.version as number,
	};
}
