/**
 * Immutable Versioned Launch Contracts (A02) — frozen W1 contract surface.
 *
 * Compilation (pure, allocation-free) is separated from durable binding:
 * - compileLaunchContract validates + deep-freezes a mission/policy snapshot.
 * - bindLaunchContract pairs that compiled body with the persisted
 *   `launch_bindings` record that admitted it, proving both halves name the
 *   same contract identity. It invents no runtime ids of its own.
 * - parseLaunchContract strictly revalidates a serialized v2 contract;
 *   parseArchivalLaunchContractV1 reads pre-cutover v1 records only.
 *
 * The runtime wire is schema v2: `{schemaVersion: 2, compiled, binding}`.
 *
 * Hashing: SHA-256 over canonical JSON with UTF-16 code-unit key ordering.
 * Array order is significant and retained. Absent fields are distinct from
 * null/zero/empty — the encoder never collapses them. Non-finite numbers
 * are rejected before hashing.
 */
import { createHash } from "node:crypto";
import type { AgentExecutionProfile } from "../orchestration/agent-execution-profile";
import type { CollaborationPolicy } from "../orchestration/collaboration-policy";
import type { ResolvedToolProfile, ToolCapability, ToolSource } from "../tools/tool-profiles";
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

/**
 * Write-authentication token for one claimed attempt.
 *
 * `launchAuthority` replaces the precursor `contractVersion: number`. A wire
 * revision integer said nothing about WHICH authority admitted the writer,
 * so it could not fence out a stale, superseded or revoked binding; the
 * durable reference can.
 */
export interface LifecycleFence {
	readonly runId: string;
	readonly nodeId: string;
	readonly attemptId: string;
	readonly leaseOwner: string;
	readonly leaseEpoch: number;
	readonly cancellationGeneration: number;
	readonly launchAuthority: LaunchAuthorityRefV1;
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

/**
 * ARCHIVAL v1 envelope. Retained only to read records serialized before the
 * §14.2 wire cutover; the runtime carries a durable `LaunchBinding` instead,
 * so nothing new should synthesize one of these.
 */
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

/**
 * ARCHIVAL v1 contract.
 *
 * Deliberately NOT assignable to the runtime `LaunchContract`: it carries a
 * synthesized envelope rather than the durable binding that admitted it, so
 * handing one to a runtime consumer would reintroduce exactly the invented
 * identities the v2 wire removes. Reading an archived record is allowed;
 * executing under it requires recompilation and readmission.
 */
export interface ArchivalLaunchContractV1 {
	readonly capsule: MissionCapsule;
	readonly envelope: LaunchEnvelope;
	readonly policy: RuntimePolicySnapshotV1;
	readonly contractVersion: number;
	readonly policySchemaVersion: 1;
	readonly harnessSchemaVersion: 1;
}

/**
 * The runtime launch contract (§14.2 schema v2).
 *
 * Exactly two parts, both authenticated: the compiled authority and the
 * persisted `launch_bindings` record that admitted it. Consumers read
 * runtime identity from `binding` — `bindingId` for the durable record,
 * `attemptId` for the attempt, `lifecycle` for graph placement — instead of
 * from ids fabricated at bind time.
 */
export interface LaunchContract {
	readonly schemaVersion: 2;
	readonly compiled: CompiledLaunchContract;
	readonly binding: LaunchBinding;
}

export interface LaunchContractDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly path?: string;
}

export interface LaunchCompileInput {
	readonly capsule: MissionCapsule;
	readonly policy: RuntimePolicySnapshotV1;
	/**
	 * Complete authenticated preflight snapshot (§14.2), replacing the former
	 * bare `parentPolicy`. Parent ceilings, source grants and the requested
	 * authority arrive together, so the compiler proves narrowing instead of
	 * taking the caller's word for the parent's shape.
	 */
	readonly authorization: LaunchAuthorizationSnapshotV1;
	readonly requiredInputIds: readonly string[];
}

export interface CompiledLaunchContract {
	readonly schemaVersion: 2;
	readonly policyVersion: 1;
	/** Stable across a child's lineage; revision increments per authority change. */
	readonly contractId: string;
	readonly contractRevision: number;
	/** Digest over every field except itself. */
	readonly contractDigest: string;
	readonly priorContractDigest: string | null;
	readonly rootPrincipalId: string;
	readonly parentPrincipalId: string;
	readonly childPrincipalId: string;
	readonly capsule: MissionCapsule;
	readonly policy: RuntimePolicySnapshotV1;
	readonly missionHash: string;
	readonly policyHash: string;
	readonly authority: LaunchAuthorityV1;
	readonly provenance: {
		readonly authorizationRef: string;
		readonly reason: string;
		readonly issuerPrincipalId: string;
	};
}

export type LaunchCompileResult =
	| { readonly ok: true; readonly compiled: CompiledLaunchContract }
	| { readonly ok: false; readonly diagnostics: readonly LaunchContractDiagnostic[] };

/**
 * Runtime identities the store allocates before writing a binding row.
 *
 * This is the store's ROW-WRITER input, not an authority record and no
 * longer a `bindLaunchContract` argument: the durable record is
 * `LaunchBinding` (§14.2), which carries these fields in its `lifecycle`
 * block alongside principal, grant and guarantee state. Validate one with
 * `parseLaunchBindingInput` at the point the row is written.
 */
export interface LaunchBindingInput {
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
	"launchAuthority",
] as const;

/**
 * Strict parse of an execution fence.
 *
 * The fence names the authority it was issued under, so a stale or revoked
 * binding is identifiable from the fence alone. `launchAuthority.attemptId`
 * must equal the fenced `attemptId`: a fence carrying another attempt's
 * authority would authenticate writes under a binding that never admitted
 * this attempt.
 */
export function parseLifecycleFence(value: unknown): LifecycleFence {
	const diagnostics: LaunchContractDiagnostic[] = [];
	if (!isPlainObject(value)) throw new Error("invalid_fence: fence must be an object");
	checkUnknownKeys(value, FENCE_KEYS, diagnostics, "fence");
	for (const field of ["runId", "nodeId", "attemptId", "leaseOwner"] as const) {
		if (!isNonEmptyString(value[field]))
			diagnostics.push(diag("invalid_fence", `Fence '${field}' must be a non-empty string.`, `fence.${field}`));
	}
	for (const field of ["leaseEpoch", "cancellationGeneration"] as const) {
		if (!isSafeNonNegativeInt(value[field])) {
			diagnostics.push(
				diag("invalid_fence", `Fence '${field}' must be a safe non-negative integer.`, `fence.${field}`),
			);
		}
	}
	if (diagnostics.length > 0) throw new Error(diagnostics[0]?.code ?? "invalid_fence");
	const launchAuthority = parseLaunchAuthorityRefV1(value.launchAuthority, "fence.launchAuthority");
	if (launchAuthority.attemptId !== value.attemptId) {
		throw new Error(
			`invalid_fence: launchAuthority.attemptId '${launchAuthority.attemptId}' does not fence attempt '${String(value.attemptId)}'`,
		);
	}
	return Object.freeze({
		runId: value.runId as string,
		nodeId: value.nodeId as string,
		attemptId: value.attemptId as string,
		leaseOwner: value.leaseOwner as string,
		leaseEpoch: value.leaseEpoch as number,
		cancellationGeneration: value.cancellationGeneration as number,
		launchAuthority,
	});
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

export function parseMutationContractV1(value: unknown, path = "mutation"): MutationContractV1 {
	return Object.freeze(parseWithValidator(value, path, validateMutationContract));
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

	// Parent narrowing now reads the authenticated snapshot rather than a
	// caller-supplied parent policy object: the child may only hold grants
	// the issuer actually holds, and must not exceed the issuer's depth.
	// Literal scope-vs-scope narrowing is still proven at admission preflight,
	// where parent capsule scopes are loadable from the store.
	const authorization = (input as { authorization?: unknown }).authorization;
	if (!isPlainObject(authorization)) {
		return {
			ok: false,
			diagnostics: [diag("invalid_authorization", "authorization snapshot must be an object.", "authorization")],
		};
	}
	const snapshot = authorization as unknown as LaunchAuthorizationSnapshotV1;
	for (const field of ["contractId", "rootPrincipalId", "parentPrincipalId", "childPrincipalId"] as const) {
		if (!isNonEmptyString(snapshot[field])) {
			diagnostics.push(
				diag("invalid_authorization", `authorization.${field} is required.`, `authorization.${field}`),
			);
		}
	}
	if (!isSafeNonNegativeInt(snapshot.contractRevision) || snapshot.contractRevision < 1) {
		diagnostics.push(
			diag(
				"invalid_authorization",
				"authorization.contractRevision must be >= 1.",
				"authorization.contractRevision",
			),
		);
	}

	const issuerGrants = new Set((snapshot.sourceGrants ?? []).map(grant => grant.grantId));
	for (const grant of policy.grantRefs) {
		if (!issuerGrants.has(grant)) {
			diagnostics.push(
				diag("scope_not_proven_subset", `Grant '${grant}' is not held by the issuer.`, "policy.grantRefs"),
			);
		}
	}
	const issuerDepth = snapshot.parentDelegable?.budget?.limits?.maxDepth;
	if (isSafeNonNegativeInt(issuerDepth) && policy.limits.maxDepth > issuerDepth) {
		diagnostics.push(
			diag(
				"depth_exceeds_parent",
				`Child maxDepth (${policy.limits.maxDepth}) exceeds issuer maxDepth (${issuerDepth}).`,
				"policy.limits.maxDepth",
			),
		);
	}

	const authorityResult = compileLaunchAuthority(snapshot);
	if (!authorityResult.ok) diagnostics.push(...authorityResult.diagnostics);

	if (diagnostics.length > 0 || !authorityResult.ok) {
		return { ok: false, diagnostics: Object.freeze([...diagnostics]) };
	}

	const frozenCapsule = deepFreezeCopy(capsule);
	const frozenPolicy = deepFreezeCopy(policy);
	const body = {
		schemaVersion: 2 as const,
		policyVersion: 1 as const,
		contractId: snapshot.contractId,
		contractRevision: snapshot.contractRevision,
		priorContractDigest: snapshot.priorContractDigest ?? null,
		rootPrincipalId: snapshot.rootPrincipalId,
		parentPrincipalId: snapshot.parentPrincipalId,
		childPrincipalId: snapshot.childPrincipalId,
		capsule: frozenCapsule,
		policy: frozenPolicy,
		missionHash: computeMissionHash(frozenCapsule),
		policyHash: computePolicyHash(frozenPolicy),
		authority: authorityResult.authority,
		provenance: Object.freeze({
			authorizationRef: snapshot.authorizationRef,
			reason: snapshot.reason,
			issuerPrincipalId: snapshot.issuerPrincipalId,
		}),
	};
	const compiled: CompiledLaunchContract = Object.freeze({
		...body,
		contractDigest: computeLaunchContractDigest(body),
	});
	return { ok: true, compiled };
}

function validateBinding(value: unknown): {
	diagnostics: LaunchContractDiagnostic[];
	binding: LaunchBindingInput | null;
} {
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

/**
 * Strict parse of the store's row-writer input.
 *
 * This is NOT the durable binding: it is the set of runtime identities the
 * store allocates before it writes a `launch_bindings` row. Exported so the
 * row writer validates them at its own boundary — `bindLaunchContract` no
 * longer accepts them, because a contract must be bound to a persisted
 * record rather than to ids that only exist in the caller's memory.
 */
export function parseLaunchBindingInput(value: unknown): LaunchBindingInput {
	const checked = validateBinding(value);
	if (!checked.binding) throw new Error(checked.diagnostics[0]?.code ?? "invalid_binding");
	return Object.freeze(checked.binding);
}

/**
 * Bind a compiled contract to the durable record that admitted it (§14.2).
 *
 * No identity is fabricated here. The binding argument is the persisted
 * `launch_bindings` record, so every runtime identity a consumer needs
 * (bindingId, attemptId, lifecycle graph ids, reservation, epochs) is read
 * from storage rather than invented at the wire boundary.
 *
 * Binding therefore proves two things and nothing else:
 * - the compiled body still reproduces its own mission hash, policy hash
 *   and contract digest, so a tampered capsule, policy or authority is
 *   rejected before it can be executed under; and
 * - the durable record names exactly that contract identity and lineage,
 *   so a valid binding for a different contract, revision, or principal
 *   chain cannot be paired with this body.
 */
export function bindLaunchContract(compiled: CompiledLaunchContract, binding: LaunchBinding): LaunchContract {
	if (!isPlainObject(compiled) || compiled.schemaVersion !== 2) throw new Error("unknown_version");
	// Tamper-evident: bound hashes must reproduce from the frozen snapshot.
	if (computeMissionHash(compiled.capsule) !== compiled.missionHash) throw new Error("contract_hash_mismatch");
	if (computePolicyHash(compiled.policy) !== compiled.policyHash) throw new Error("contract_hash_mismatch");
	// The contract digest covers the authority too, so a tampered capability
	// set cannot ride in behind matching mission and policy hashes.
	const { contractDigest, ...body } = compiled;
	if (computeLaunchContractDigest(body) !== contractDigest) throw new Error("contract_hash_mismatch");
	if (!KNOWN_AGENT_ROLES.includes(compiled.policy.role) || !KNOWN_TOPOLOGIES.includes(compiled.policy.topology)) {
		throw new Error("unknown_role");
	}
	const durable = parseLaunchBinding(binding, "binding");
	const mismatch = (field: string, expected: string, actual: string): never => {
		throw new Error(
			`launch_binding_identity_mismatch: binding ${field} '${actual}' does not match contract '${expected}'`,
		);
	};
	if (durable.contractId !== compiled.contractId) {
		mismatch("contractId", compiled.contractId, durable.contractId);
	}
	if (durable.contractDigest !== compiled.contractDigest) {
		mismatch("contractDigest", compiled.contractDigest, durable.contractDigest);
	}
	if (durable.contractRevision !== compiled.contractRevision) {
		mismatch("contractRevision", String(compiled.contractRevision), String(durable.contractRevision));
	}
	if (durable.rootPrincipalId !== compiled.rootPrincipalId) {
		mismatch("rootPrincipalId", compiled.rootPrincipalId, durable.rootPrincipalId);
	}
	if (durable.parentPrincipalId !== compiled.parentPrincipalId) {
		mismatch("parentPrincipalId", compiled.parentPrincipalId, durable.parentPrincipalId);
	}
	if (durable.childPrincipalId !== compiled.childPrincipalId) {
		mismatch("childPrincipalId", compiled.childPrincipalId, durable.childPrincipalId);
	}
	// Re-asserted at the bind boundary, not only inside the parser: a bound
	// child must never advertise runtime protections nobody probed for.
	validateLaunchBindingGuarantees(durable);
	return Object.freeze({ schemaVersion: 2 as const, compiled, binding: durable });
}

const CONTRACT_KEYS = ["schemaVersion", "compiled", "binding"] as const;
const ARCHIVAL_CONTRACT_KEYS = [
	"capsule",
	"envelope",
	"policy",
	"contractVersion",
	"policySchemaVersion",
	"harnessSchemaVersion",
] as const;
const ARCHIVAL_ENVELOPE_KEYS = [
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
 * Strictly revalidates a serialized runtime contract (schema v2).
 *
 * Both halves are re-parsed from scratch and then re-bound, so a serialized
 * contract gets exactly the same identity and tamper proof as a freshly
 * admitted one: recomputed hashes, a recomputed contract digest, and a
 * binding that must name that same contract lineage.
 */
export function parseLaunchContract(value: unknown): LaunchContract {
	if (!isPlainObject(value)) throw new Error("Invalid LaunchContract: expected object");
	checkThrow(value, CONTRACT_KEYS, "contract");
	if (value.schemaVersion !== 2) throw new Error("Invalid LaunchContract: unknown version");
	const compiled = parseCompiledLaunchContract(value.compiled, "contract.compiled");
	const binding = parseLaunchBinding(value.binding, "contract.binding");
	return bindLaunchContract(compiled, binding);
}

/**
 * Strictly revalidates an ARCHIVED v1 contract.
 *
 * Kept only for reading records serialized before the §14.2 wire cutover
 * (archival inspection and explicit reauthorization). Its result is
 * deliberately not a runtime `LaunchContract`: a v1 record carries a
 * synthesized envelope rather than a durable binding, so it must be
 * recompiled and readmitted before anything may execute under it.
 */
export function parseArchivalLaunchContractV1(value: unknown): ArchivalLaunchContractV1 {
	if (!isPlainObject(value)) throw new Error("Invalid ArchivalLaunchContractV1: expected object");
	checkThrow(value, ARCHIVAL_CONTRACT_KEYS, "contract");
	const capsule = validateMissionCapsule(value.capsule, throwDiagnostics("contract.capsule"), "capsule");
	const policy = validateRuntimePolicy(value.policy, throwDiagnostics("contract.policy"), "policy");
	if (!capsule || !policy) throw new Error("Invalid LaunchContract: capsule/policy failed validation");
	if (!isPlainObject(value.envelope)) throw new Error("Invalid LaunchContract: envelope must be an object");
	checkThrow(value.envelope as Record<string, unknown>, ARCHIVAL_ENVELOPE_KEYS, "contract.envelope");
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

// ---------------------------------------------------------------------------
// Launch authority dictionary (§14.2) — frozen W1 extension surface.
//
// These records describe what a delegated child is authorized to do. They are
// pure data: holding one confers nothing. Authority is conferred only when the
// runtime authenticates an issuer and commits a binding (W2/W3). A serialized
// grant is inert by construction.
//
// Every optional dimension is explicit. There is no "field absent means
// inherit" rule anywhere in this dictionary: omission is a validation error,
// because a silently inherited capability is exactly the escalation these
// records exist to prevent.
// ---------------------------------------------------------------------------

/**
 * Delegated launch classes. The interactive root is NOT a delegated class:
 * it is authorized at host bootstrap, so representing it here would let a
 * child request "root" as if it were a launch option.
 */
export type LaunchClass = "strict-worker" | "privileged-helper" | "legacy-compatible-worker";
export const KNOWN_LAUNCH_CLASSES: readonly LaunchClass[] = [
	"strict-worker",
	"privileged-helper",
	"legacy-compatible-worker",
] as const;

export type CompatibilityClassification =
	| "preserved-safe"
	| "privileged-explicit"
	| "legacy-compatibility"
	| "external-trust-boundary"
	| "temporarily-unenforced"
	| "deprecated"
	| "invalid";
export const KNOWN_COMPATIBILITY_CLASSIFICATIONS: readonly CompatibilityClassification[] = [
	"preserved-safe",
	"privileged-explicit",
	"legacy-compatibility",
	"external-trust-boundary",
	"temporarily-unenforced",
	"deprecated",
	"invalid",
] as const;

/**
 * A recorded gap between a guarantee a launch requires and what the runtime
 * actually provides. Legacy inherited access is represented here as an
 * exception rather than being written up as a strict grant it never was.
 */
export interface CompatibilityExceptionV1 {
	readonly classification: CompatibilityClassification;
	readonly code: string;
	readonly resourceKind: string;
	readonly requiredGuarantee: string | null;
	readonly actualGuarantee: string;
	readonly reason: string;
	readonly authorityRef: string | null;
}

export type ContextIndependence = "none" | "parent-history-independent" | "independent-verifier" | "adversarial-review";
export const KNOWN_CONTEXT_INDEPENDENCE: readonly ContextIndependence[] = [
	"none",
	"parent-history-independent",
	"independent-verifier",
	"adversarial-review",
] as const;

export type ContextStrategy = "shared" | "blind" | "staged";
export const KNOWN_CONTEXT_STRATEGIES: readonly ContextStrategy[] = ["shared", "blind", "staged"] as const;

/**
 * How a child's starting context is constituted.
 *
 * `fresh` builds context from explicitly selected grants; `shared` selects
 * grants, it does not imply inherited history. `privileged-fork` is a
 * deliberately distinct mode carrying an authorized parent snapshot, and can
 * never satisfy an independence requirement.
 */
export type ContextMode =
	| { readonly kind: "fresh"; readonly strategy: ContextStrategy; readonly independence: ContextIndependence }
	| {
			readonly kind: "privileged-fork";
			readonly parentSnapshotRef: ArtifactRefV1;
			readonly parentSnapshotGrantIntentId: string;
			readonly snapshotVersion: 1;
			readonly reason: string;
	  };

export type BaseContextSegmentKind = "safety" | "runtime-convention" | "tool-protocol" | "runtime-boilerplate";
export const KNOWN_BASE_SEGMENT_KINDS: readonly BaseContextSegmentKind[] = [
	"safety",
	"runtime-convention",
	"tool-protocol",
	"runtime-boilerplate",
] as const;

/**
 * Static global baseline prompt content only. Repository rules, role
 * templates, assignments, plans, workspace trees, skills and memory are NOT
 * base context — each requires its own grant, so that "what did this agent
 * start with" has exactly one answer.
 */
export interface BaseContextManifestV1 {
	readonly schemaVersion: 1;
	readonly manifestHash: string;
	readonly segments: readonly {
		readonly segmentId: string;
		readonly kind: BaseContextSegmentKind;
		readonly contentRef: ArtifactRefV1;
	}[];
}

export type ResourceKind =
	| "tool"
	| "workspace"
	| "artifact"
	| "memory"
	| "eval"
	| "transcript"
	| "registry"
	| "network"
	| "credential"
	| "mcp"
	| "extension"
	| "custom"
	| "client-bridge"
	| "plan"
	| "skill"
	| "instructions";
export const KNOWN_RESOURCE_KINDS: readonly ResourceKind[] = [
	"tool",
	"workspace",
	"artifact",
	"memory",
	"eval",
	"transcript",
	"registry",
	"network",
	"credential",
	"mcp",
	"extension",
	"custom",
	"client-bridge",
	"plan",
	"skill",
	"instructions",
] as const;

export type ResourceOperation =
	| "read"
	| "write"
	| "list"
	| "invoke"
	| "disclose"
	| "observe-status"
	| "observe-transcript"
	| "observe-artifacts"
	| "send"
	| "receive"
	| "wake"
	| "broadcast"
	| "busy-reply"
	| "control"
	| "publish";
export const KNOWN_RESOURCE_OPERATIONS: readonly ResourceOperation[] = [
	"read",
	"write",
	"list",
	"invoke",
	"disclose",
	"observe-status",
	"observe-transcript",
	"observe-artifacts",
	"send",
	"receive",
	"wake",
	"broadcast",
	"busy-reply",
	"control",
	"publish",
] as const;

/**
 * Identifies a resource precisely enough that possession of its name is not
 * possession of access. Tool `resourceId` is canonical JSON of
 * `{source,name}`; workspace roots are repository-relative; network entries
 * are normalized origins; credentials use opaque service IDs and NEVER carry
 * secret material.
 */
export interface ResourceSelectorV1 {
	readonly kind: ResourceKind;
	readonly resourceId: string;
	readonly versionDigest: string | null;
	readonly scope: {
		readonly roots: readonly string[];
		readonly exactIds: readonly string[];
		readonly maxBytes: number | null;
		readonly range: { readonly start: number; readonly end: number } | null;
	};
}

export interface ResourceAuthorityV1 {
	readonly resource: ResourceSelectorV1;
	readonly mayUse: readonly ResourceOperation[];
	/** Onward-issuance rights. `mayUse` never implies `mayIssue`. */
	readonly mayIssue: readonly ResourceOperation[];
	readonly recipientPrincipalIds: readonly string[];
	readonly maxDelegationDepth: number;
	readonly disclosureDomains: readonly DisclosureDomain[];
	readonly sourceGrantIds: readonly string[];
}

/**
 * Disclosure domains tag WHY material is restricted. `credential-sensitive`
 * is a restriction, never permission to reveal a secret.
 */
export type DisclosureDomain =
	| "public-task"
	| "parent-private"
	| "worker-family"
	| "review-independent"
	| "credential-sensitive"
	| { readonly kind: "artifact-scope"; readonly artifactId: string };
export const KNOWN_DISCLOSURE_DOMAIN_LITERALS: readonly string[] = [
	"public-task",
	"parent-private",
	"worker-family",
	"review-independent",
	"credential-sensitive",
] as const;

export type DisclosureKind =
	| "assignment"
	| "workspace-instructions"
	| "agent-template"
	| "selected-context"
	| "plan-excerpt"
	| "artifact"
	| "sibling-result"
	| "human-message"
	| "parent-message"
	| "agent-message";
export const KNOWN_DISCLOSURE_KINDS: readonly DisclosureKind[] = [
	"assignment",
	"workspace-instructions",
	"agent-template",
	"selected-context",
	"plan-excerpt",
	"artifact",
	"sibling-result",
	"human-message",
	"parent-message",
	"agent-message",
] as const;

/**
 * A policy-level statement of intended disclosure.
 *
 * `intentId` is NOT a grant id. Each binding transaction issues its own
 * runtime grant ids and records the intent to grant mapping, so recovery can
 * reissue attempt-bound grants without mutating the contract.
 */
export interface DisclosureIntentV1 {
	readonly intentId: string;
	readonly issuerPrincipalId: string;
	readonly recipientPrincipalId: string;
	readonly resource: ResourceSelectorV1;
	readonly contentRef: ArtifactRefV1;
	readonly kind: DisclosureKind;
	readonly domains: readonly DisclosureDomain[];
	readonly purpose: string;
	readonly sourceGrantIds: readonly string[];
	readonly required: boolean;
}

export interface DeliveryChannelV1 {
	readonly channelId: string;
	readonly senderPrincipalIds: readonly string[];
	readonly recipientPrincipalId: string;
	readonly resourceSelectors: readonly ResourceSelectorV1[];
	readonly domains: readonly DisclosureDomain[];
	readonly messageKinds: readonly DisclosureKind[];
	readonly revealCondition: "open" | "authorized-synthesis";
	readonly maxMessageBytes: number;
	readonly maxTotalBytes: number;
	readonly maxMessages: number;
	readonly expiresAt: number | null;
	readonly onwardRecipientPrincipalIds: readonly string[];
}

/**
 * Peer rights, split by verb. Existing collaboration clamping is an upper
 * bound on these sets, never authorization to populate an omitted one.
 */
export interface CommunicationAuthorityV1 {
	readonly policy: CollaborationPolicy;
	readonly visiblePrincipalIds: readonly string[];
	readonly sendPrincipalIds: readonly string[];
	readonly receivePrincipalIds: readonly string[];
	readonly wakePrincipalIds: readonly string[];
	readonly broadcastPrincipalIds: readonly string[];
	readonly busyReplyPrincipalIds: readonly string[];
	readonly controlPrincipalIds: readonly string[];
	readonly delegablePrincipalIds: readonly string[];
	readonly channelIds: readonly string[];
}

export type ObservationRight = "status" | "progress" | "result" | "artifacts" | "transcript" | "telemetry";
export const KNOWN_OBSERVATION_RIGHTS: readonly ObservationRight[] = [
	"status",
	"progress",
	"result",
	"artifacts",
	"transcript",
	"telemetry",
] as const;

/**
 * Parent supervision rights. Deliberately one-way: these are never mirrored
 * into the child's own read or peer rights.
 */
export interface ObservationAuthorityV1 {
	readonly observers: readonly {
		readonly principalId: string;
		readonly rights: readonly ObservationRight[];
	}[];
}

export interface SpawnAuthorityV1 {
	readonly maySpawn: boolean;
	readonly mayDelegateSpawn: boolean;
	readonly allowedAgentTypes: readonly string[];
	readonly allowedLaunchClasses: readonly LaunchClass[];
	readonly maxDepth: number;
	readonly maxChildren: number;
	readonly delegableResourceGrantIds: readonly string[];
}

/**
 * Strict unattended hierarchy requires `finite`. Only trusted compatibility
 * or root policy may select `legacy`, where the historical `0 = unlimited`
 * reading applies.
 */
export type LaunchBudgetV1 =
	| { readonly kind: "finite"; readonly limits: RunLimitsV1; readonly reservation: ReservationVector }
	| {
			readonly kind: "legacy";
			readonly limits: RunLimitsV1;
			readonly reservation: ReservationVector;
			readonly zeroMeansUnlimited: true;
			readonly authorityRef: string;
	  };

export interface ResultAuthorityV1 {
	readonly outputSchemaRef: string | null;
	readonly maxOutputBytes: number;
	readonly requiredCriterionIds: readonly string[];
	readonly publicationRequired: boolean;
	readonly mutation: MutationContractV1;
	readonly publicationGrantIds: readonly string[];
	readonly acceptedRecipientPrincipalIds: readonly string[];
}

export type InitialContextGuarantee = "explicit-grants-only" | "legacy-inherited";
export type ScopedAccessGuarantee = "principal-scoped" | "ambient";
export type EvalStateGuarantee = "child-owned" | "scoped-shared" | "ambient";
export type FilesystemGuarantee = "mediated" | "contained" | "ambient";
export type ProcessGuarantee = "contained" | "ambient";
export type NetworkGuarantee = "contained" | "mediated" | "ambient";
export type CredentialGuarantee = "brokered" | "ambient";

/**
 * What the runtime actually provides, per dimension.
 *
 * Compared per dimension, never as a total ranking: `contained` satisfies a
 * `mediated` requirement, `ambient` satisfies neither, `scoped-shared` is not
 * `child-owned`, and `explicit-grants-only` satisfies a `legacy-inherited`
 * requirement but not the reverse.
 */
export interface RuntimeGuaranteesV1 {
	readonly initialContext: InitialContextGuarantee;
	readonly transcriptAccess: ScopedAccessGuarantee;
	readonly serviceAccess: ScopedAccessGuarantee;
	readonly artifactAccess: ScopedAccessGuarantee;
	readonly memoryAccess: ScopedAccessGuarantee;
	readonly evalState: EvalStateGuarantee;
	readonly filesystemRead: FilesystemGuarantee;
	readonly filesystemWrite: FilesystemGuarantee;
	readonly process: ProcessGuarantee;
	readonly network: NetworkGuarantee;
	readonly credentials: CredentialGuarantee;
}

/** Values that satisfy each required value, per dimension. */
const GUARANTEE_SATISFACTION: Record<string, Record<string, readonly string[]>> = {
	initialContext: {
		"explicit-grants-only": ["explicit-grants-only"],
		"legacy-inherited": ["explicit-grants-only", "legacy-inherited"],
	},
	transcriptAccess: { "principal-scoped": ["principal-scoped"], ambient: ["principal-scoped", "ambient"] },
	serviceAccess: { "principal-scoped": ["principal-scoped"], ambient: ["principal-scoped", "ambient"] },
	artifactAccess: { "principal-scoped": ["principal-scoped"], ambient: ["principal-scoped", "ambient"] },
	memoryAccess: { "principal-scoped": ["principal-scoped"], ambient: ["principal-scoped", "ambient"] },
	evalState: {
		"child-owned": ["child-owned"],
		"scoped-shared": ["child-owned", "scoped-shared"],
		ambient: ["child-owned", "scoped-shared", "ambient"],
	},
	filesystemRead: {
		contained: ["contained"],
		mediated: ["contained", "mediated"],
		ambient: ["contained", "mediated", "ambient"],
	},
	filesystemWrite: {
		contained: ["contained"],
		mediated: ["contained", "mediated"],
		ambient: ["contained", "mediated", "ambient"],
	},
	process: { contained: ["contained"], ambient: ["contained", "ambient"] },
	network: {
		contained: ["contained"],
		mediated: ["contained", "mediated"],
		ambient: ["contained", "mediated", "ambient"],
	},
	credentials: { brokered: ["brokered"], ambient: ["brokered", "ambient"] },
};

export interface GuaranteeShortfall {
	readonly dimension: keyof RuntimeGuaranteesV1;
	readonly required: string;
	readonly actual: string;
}

/**
 * Per-dimension comparison of actual runtime guarantees against required
 * ones. Returns every shortfall rather than the first, so a caller reports
 * the complete gap instead of fixing one dimension at a time.
 */
export function compareRuntimeGuarantees(
	required: RuntimeGuaranteesV1,
	actual: RuntimeGuaranteesV1,
): readonly GuaranteeShortfall[] {
	const shortfalls: GuaranteeShortfall[] = [];
	for (const dimension of Object.keys(GUARANTEE_SATISFACTION) as (keyof RuntimeGuaranteesV1)[]) {
		const requiredValue = required[dimension];
		const actualValue = actual[dimension];
		const accepted = GUARANTEE_SATISFACTION[dimension]?.[requiredValue];
		if (!accepted?.includes(actualValue)) {
			shortfalls.push({ dimension, required: requiredValue, actual: actualValue });
		}
	}
	return Object.freeze(shortfalls);
}

export interface LaunchAuthorityV1 {
	readonly schemaVersion: 1;
	readonly launchClass: LaunchClass;
	readonly contextMode: ContextMode;
	readonly baseContextManifest: BaseContextManifestV1;
	readonly workspaceInstructionRefs: readonly ArtifactRefV1[];
	readonly agentTemplateRef: ArtifactRefV1;
	readonly initialDisclosures: readonly DisclosureIntentV1[];
	readonly deliveryChannels: readonly DeliveryChannelV1[];
	readonly usableCapabilities: readonly ToolCapability[];
	readonly delegableCapabilities: readonly ToolCapability[];
	readonly resources: readonly ResourceAuthorityV1[];
	readonly collaboration: CommunicationAuthorityV1;
	readonly observation: ObservationAuthorityV1;
	readonly spawn: SpawnAuthorityV1;
	readonly budget: LaunchBudgetV1;
	readonly result: ResultAuthorityV1;
	readonly requiredRuntimeGuarantees: RuntimeGuaranteesV1;
	readonly compatibility: readonly CompatibilityExceptionV1[];
}

/**
 * Pinned reference to an authenticated binding. `principalId` ALWAYS means
 * the child principal in child, native and receipt refs.
 */
export interface LaunchAuthorityRefV1 {
	readonly bindingId: string;
	readonly principalId: string;
	readonly attemptId: string;
	readonly contractId: string;
	readonly contractRevision: number;
	readonly contractDigest: string;
	readonly policyEpoch: number;
}

/**
 * The authority a principal may exercise and hand onward, without any
 * delegated-launch framing. The root has an envelope but no launch class or
 * context mode, so root authority is never described as if it were a
 * delegated child's.
 */
export interface AuthorityEnvelopeV1 {
	readonly schemaVersion: 1;
	readonly usableCapabilities: readonly ToolCapability[];
	readonly delegableCapabilities: readonly ToolCapability[];
	readonly resources: readonly ResourceAuthorityV1[];
	readonly collaboration: CommunicationAuthorityV1;
	readonly spawn: SpawnAuthorityV1;
	readonly budget: LaunchBudgetV1;
	readonly result: ResultAuthorityV1;
}

/**
 * Everything the compiler needs to decide a launch, assembled by the runtime
 * preflight.
 *
 * This is created by the host, never accepted from model, extension or
 * remote JSON. The compiler validates structure and subset relationships and
 * stays pure; authenticating the issuer and checking currentness belong to
 * the authorizer and the commit transaction.
 */
export interface LaunchAuthorizationSnapshotV1 {
	readonly schemaVersion: 1;
	readonly authorizationRef: string;
	readonly issuerPrincipalId: string;
	readonly rootPrincipalId: string;
	readonly parentPrincipalId: string;
	readonly childPrincipalId: string;
	readonly contractId: string;
	readonly contractRevision: number;
	readonly priorContractDigest: string | null;
	readonly issuerPolicyEpoch: number;
	/** Host-registered route key (§14.6). An unknown entry point denies. */
	readonly entryPoint: string;
	readonly reason: string;
	readonly requestedAuthority: LaunchAuthorityV1;
	readonly sourceGrants: readonly GrantRecordV1[];
	readonly parentDelegable: AuthorityEnvelopeV1;
	readonly hostMaximum: AuthorityEnvelopeV1;
	readonly agentMaximum: AuthorityEnvelopeV1;
	readonly workflowMaximum: AuthorityEnvelopeV1;
	readonly toolCatalogDigest: string;
}

export type LaunchBindingState =
	| "authorized"
	| "bound"
	| "active"
	| "suspended"
	| "revoked"
	| "superseded"
	| "failed"
	| "terminal";
export const KNOWN_LAUNCH_BINDING_STATES: readonly LaunchBindingState[] = [
	"authorized",
	"bound",
	"active",
	"suspended",
	"revoked",
	"superseded",
	"failed",
	"terminal",
] as const;

/**
 * The persisted link between a compiled contract and one running child.
 *
 * `actualRuntimeGuarantees` may be null while `authorized`, or if the binding
 * reached a terminal state BEFORE its probes ran; `bound`, `active` and
 * `suspended` always require measured guarantees with evidence. That keeps a
 * pre-probe cancellation an honest audit row instead of a record carrying
 * guarantees nobody measured.
 *
 * Graph and lease data is mandatory only for hierarchical jobs, so a
 * legacy-compatible child can hold a binding without a scheduler job.
 *
 * JSON is inert: executable handles live only in a host-private registry.
 */
export interface LaunchBinding {
	readonly schemaVersion: 1;
	readonly bindingId: string;
	readonly contractId: string;
	readonly contractRevision: number;
	readonly contractDigest: string;
	readonly rootPrincipalId: string;
	readonly parentPrincipalId: string;
	readonly childPrincipalId: string;
	readonly attemptId: string;
	readonly sessionId: string | null;
	readonly processRef: string | null;
	readonly policyEpoch: number;
	readonly contextGeneration: number;
	readonly state: LaunchBindingState;
	/** Maps each policy-level disclosure intent to its issued runtime grant. */
	readonly grantBindings: readonly {
		readonly intentId: string;
		readonly grantId: string;
		readonly recordDigest: string;
	}[];
	readonly serviceBindings: readonly {
		readonly kind: ResourceKind;
		readonly adapterId: string;
		readonly namespace: string;
		readonly guarantee: string;
	}[];
	readonly actualRuntimeGuarantees: RuntimeGuaranteesV1 | null;
	readonly guaranteeEvidenceRefs: readonly ArtifactRefV1[];
	readonly reservationId: string | null;
	readonly lifecycle: {
		readonly runId: string;
		readonly nodeId: string;
		readonly ownerNodeId: string | null;
		readonly jobId: string;
		readonly leaseEpoch: number;
		readonly cancellationGeneration: number;
	} | null;
	readonly expiresAt: number | null;
	readonly restoresBindingId: string | null;
}

/**
 * An issued, immutable authority record.
 *
 * `remainingDelegationDepth` decrements at every derivation; zero forbids
 * onward issuance. Content is immutable — revocation and supersession are
 * recorded as separate events rather than by editing the grant.
 */
export interface GrantRecordV1 {
	readonly schemaVersion: 1;
	readonly grantId: string;
	readonly recordDigest: string;
	readonly issuerPrincipalId: string;
	readonly recipientPrincipalId: string;
	readonly recipientBindingId: string;
	readonly attemptId: string;
	readonly contractRevision: number;
	readonly policyEpoch: number;
	readonly resource: ResourceSelectorV1;
	readonly operations: readonly ResourceOperation[];
	readonly delegableOperations: readonly ResourceOperation[];
	readonly recipientConstraints: readonly string[];
	readonly remainingDelegationDepth: number;
	readonly domains: readonly DisclosureDomain[];
	readonly sourceGrantIds: readonly string[];
	readonly expiresAt: number | null;
	readonly purpose: string;
}

export interface GrantEventV1 {
	readonly eventId: string;
	readonly grantId: string;
	readonly kind: "issued" | "revoked" | "superseded";
	readonly actorPrincipalId: string;
	readonly policyEpoch: number;
	readonly reason: string;
	readonly recordDigest: string;
	readonly occurredAt: number;
}

// --- Strict parsers for the authority records ------------------------------

const RESOURCE_SELECTOR_KEYS = ["kind", "resourceId", "versionDigest", "scope"] as const;
const RESOURCE_SCOPE_KEYS = ["roots", "exactIds", "maxBytes", "range"] as const;
const GRANT_RECORD_KEYS = [
	"schemaVersion",
	"grantId",
	"recordDigest",
	"issuerPrincipalId",
	"recipientPrincipalId",
	"recipientBindingId",
	"attemptId",
	"contractRevision",
	"policyEpoch",
	"resource",
	"operations",
	"delegableOperations",
	"recipientConstraints",
	"remainingDelegationDepth",
	"domains",
	"sourceGrantIds",
	"expiresAt",
	"purpose",
] as const;

function authorityRecord(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
	if (!isPlainObject(value)) throw new Error(`invalid_${label}: expected object`);
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`unknown_field: ${label}.${key}`);
	}
	return value;
}

function authorityStrings(value: unknown, label: string, field: string): readonly string[] {
	if (!Array.isArray(value)) throw new Error(`invalid_${label}: ${field} must be an array`);
	return Object.freeze(
		value.map((entry, index) => {
			if (!isNonEmptyString(entry)) {
				throw new Error(`invalid_${label}: ${field}[${index}] must be a non-empty string`);
			}
			return entry;
		}),
	);
}

function authorityOperations(value: unknown, label: string, field: string): readonly ResourceOperation[] {
	if (!Array.isArray(value)) throw new Error(`invalid_${label}: ${field} must be an array`);
	return Object.freeze(
		value.map((entry, index) => {
			if (typeof entry !== "string" || !KNOWN_RESOURCE_OPERATIONS.includes(entry as ResourceOperation)) {
				throw new Error(`invalid_${label}: ${field}[${index}] is not a known resource operation`);
			}
			return entry as ResourceOperation;
		}),
	);
}

export function authorityDomains(value: unknown, label: string, field: string): readonly DisclosureDomain[] {
	if (!Array.isArray(value)) throw new Error(`invalid_${label}: ${field} must be an array`);
	return Object.freeze(
		value.map((entry, index) => {
			if (typeof entry === "string") {
				if (!KNOWN_DISCLOSURE_DOMAIN_LITERALS.includes(entry)) {
					throw new Error(`invalid_${label}: ${field}[${index}] is not a known disclosure domain`);
				}
				return entry as DisclosureDomain;
			}
			const scoped = authorityRecord(entry, `${label}.${field}[${index}]`, ["kind", "artifactId"]);
			if (scoped.kind !== "artifact-scope" || !isNonEmptyString(scoped.artifactId)) {
				throw new Error(`invalid_${label}: ${field}[${index}] must be an artifact-scope domain`);
			}
			return Object.freeze({ kind: "artifact-scope" as const, artifactId: scoped.artifactId });
		}),
	);
}

/**
 * Strict parse of a resource selector.
 *
 * An empty selector is rejected: a grant naming no root and no exact id
 * would read as "authorized" while identifying nothing, which is exactly the
 * shape that silently widens at the use seam.
 */
export function parseResourceSelectorV1(value: unknown, label = "ResourceSelectorV1"): ResourceSelectorV1 {
	const selector = authorityRecord(value, label, RESOURCE_SELECTOR_KEYS);
	if (typeof selector.kind !== "string" || !KNOWN_RESOURCE_KINDS.includes(selector.kind as ResourceKind)) {
		throw new Error(`invalid_${label}: kind is not a known resource kind`);
	}
	if (!isNonEmptyString(selector.resourceId)) {
		throw new Error(`invalid_${label}: resourceId must be a non-empty string`);
	}
	if (selector.versionDigest !== null && !isHex64(selector.versionDigest)) {
		throw new Error(`invalid_${label}: versionDigest must be a 64-hex digest or null`);
	}
	const scope = authorityRecord(selector.scope, `${label}.scope`, RESOURCE_SCOPE_KEYS);
	const roots = authorityStrings(scope.roots, label, "scope.roots");
	const exactIds = authorityStrings(scope.exactIds, label, "scope.exactIds");
	if (roots.length === 0 && exactIds.length === 0) {
		throw new Error(`invalid_${label}: scope must name at least one root or exact id`);
	}
	if (scope.maxBytes !== null && !isSafeNonNegativeInt(scope.maxBytes)) {
		throw new Error(`invalid_${label}: scope.maxBytes must be a safe non-negative integer or null`);
	}
	let range: { readonly start: number; readonly end: number } | null = null;
	if (scope.range !== null) {
		const rawRange = authorityRecord(scope.range, `${label}.scope.range`, ["start", "end"]);
		if (!isSafeNonNegativeInt(rawRange.start) || !isSafeNonNegativeInt(rawRange.end)) {
			throw new Error(`invalid_${label}: scope.range bounds must be safe non-negative integers`);
		}
		if (rawRange.end < rawRange.start) {
			throw new Error(`invalid_${label}: scope.range.end must not precede start`);
		}
		range = Object.freeze({ start: rawRange.start, end: rawRange.end });
	}
	return Object.freeze({
		kind: selector.kind as ResourceKind,
		resourceId: selector.resourceId,
		versionDigest: (selector.versionDigest ?? null) as string | null,
		scope: Object.freeze({ roots, exactIds, maxBytes: (scope.maxBytes ?? null) as number | null, range }),
	});
}

/**
 * Strict parse of an issued grant.
 *
 * Enforces the two invariants a lenient parser would lose: delegable
 * operations must be a subset of the operations actually held (you cannot
 * hand onward what you cannot use), and a grant at delegation depth zero
 * must not claim any delegable operations.
 */
export function parseGrantRecordV1(value: unknown): GrantRecordV1 {
	const grant = authorityRecord(value, "GrantRecordV1", GRANT_RECORD_KEYS);
	if (grant.schemaVersion !== 1) throw new Error("invalid_GrantRecordV1: schemaVersion must be 1");
	for (const field of [
		"grantId",
		"issuerPrincipalId",
		"recipientPrincipalId",
		"recipientBindingId",
		"attemptId",
		"purpose",
	] as const) {
		if (!isNonEmptyString(grant[field])) {
			throw new Error(`invalid_GrantRecordV1: ${field} must be a non-empty string`);
		}
	}
	if (!isHex64(grant.recordDigest)) {
		throw new Error("invalid_GrantRecordV1: recordDigest must be a 64-hex digest");
	}
	for (const field of ["contractRevision", "policyEpoch", "remainingDelegationDepth"] as const) {
		if (!isSafeNonNegativeInt(grant[field])) {
			throw new Error(`invalid_GrantRecordV1: ${field} must be a safe non-negative integer`);
		}
	}
	if (grant.expiresAt !== null && !isSafeNonNegativeInt(grant.expiresAt)) {
		throw new Error("invalid_GrantRecordV1: expiresAt must be a safe non-negative integer or null");
	}
	const operations = authorityOperations(grant.operations, "GrantRecordV1", "operations");
	const delegableOperations = authorityOperations(grant.delegableOperations, "GrantRecordV1", "delegableOperations");
	for (const operation of delegableOperations) {
		if (!operations.includes(operation)) {
			throw new Error(`invalid_GrantRecordV1: delegable operation '${operation}' is not held`);
		}
	}
	const remainingDelegationDepth = grant.remainingDelegationDepth as number;
	if (remainingDelegationDepth === 0 && delegableOperations.length > 0) {
		throw new Error("invalid_GrantRecordV1: delegation depth 0 forbids delegable operations");
	}
	return Object.freeze({
		schemaVersion: 1 as const,
		grantId: grant.grantId as string,
		recordDigest: grant.recordDigest as string,
		issuerPrincipalId: grant.issuerPrincipalId as string,
		recipientPrincipalId: grant.recipientPrincipalId as string,
		recipientBindingId: grant.recipientBindingId as string,
		attemptId: grant.attemptId as string,
		contractRevision: grant.contractRevision as number,
		policyEpoch: grant.policyEpoch as number,
		resource: parseResourceSelectorV1(grant.resource, "GrantRecordV1.resource"),
		operations,
		delegableOperations,
		recipientConstraints: authorityStrings(grant.recipientConstraints, "GrantRecordV1", "recipientConstraints"),
		remainingDelegationDepth,
		domains: authorityDomains(grant.domains, "GrantRecordV1", "domains"),
		sourceGrantIds: authorityStrings(grant.sourceGrantIds, "GrantRecordV1", "sourceGrantIds"),
		expiresAt: (grant.expiresAt ?? null) as number | null,
		purpose: grant.purpose as string,
	});
}

/** States whose bindings must carry measured runtime guarantees. */
const STATES_REQUIRING_MEASURED_GUARANTEES: readonly LaunchBindingState[] = ["bound", "active", "suspended"];

/**
 * Validates the binding state to guarantee-evidence invariant.
 *
 * A `bound`, `active` or `suspended` binding without measured guarantees
 * would advertise protections nobody probed for. `authorized` legitimately
 * has none yet, and a terminal state may have been reached before probing.
 */
export function validateLaunchBindingGuarantees(binding: LaunchBinding): void {
	const requiresMeasurement = STATES_REQUIRING_MEASURED_GUARANTEES.includes(binding.state);
	if (requiresMeasurement && binding.actualRuntimeGuarantees === null) {
		throw new Error(`invalid_LaunchBinding: state '${binding.state}' requires measured runtime guarantees`);
	}
	if (requiresMeasurement && binding.guaranteeEvidenceRefs.length === 0) {
		throw new Error(`invalid_LaunchBinding: state '${binding.state}' requires guarantee evidence`);
	}
}

/**
 * Canonical digest over every contract field except the digest itself.
 * Recomputing must be cheap so callers verify rather than trust.
 */
export function computeLaunchContractDigest(contract: Record<string, unknown>): string {
	const { contractDigest: _omitted, ...rest } = contract;
	return sha256Hex(canonicalJson(rest));
}

// --- Strict parsers for the launch-authority dictionary (§14.2/§14.3) -----
//
// These gate the authority records embedded in a compiled contract and in
// its durable binding at every storage boundary. They reject rather than
// coerce: `String(undefined)` would mint the literal "undefined" as an
// identity, `Number(undefined)` would mint NaN as a counter, and an
// unchecked `as` cast would let an unrecognised enum through as if the host
// had authorized it. Each parser reconstructs a frozen canonical record, so
// a caller cannot mutate a validated record after the check.

function authorityArray(value: unknown, label: string, field: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new Error(`invalid_${label}: ${field} must be an array`);
	return value;
}

function authorityString(record: Record<string, unknown>, label: string, field: string): string {
	const value = record[field];
	if (!isNonEmptyString(value)) throw new Error(`invalid_${label}: ${field} must be a non-empty string`);
	return value;
}

function authorityNullableString(record: Record<string, unknown>, label: string, field: string): string | null {
	const value = record[field];
	if (value === null) return null;
	if (!isNonEmptyString(value)) throw new Error(`invalid_${label}: ${field} must be a non-empty string or null`);
	return value;
}

function authorityBoolean(record: Record<string, unknown>, label: string, field: string): boolean {
	const value = record[field];
	if (typeof value !== "boolean") throw new Error(`invalid_${label}: ${field} must be an explicit boolean`);
	return value;
}

function authorityCount(record: Record<string, unknown>, label: string, field: string): number {
	const value = record[field];
	if (!isSafeNonNegativeInt(value)) {
		throw new Error(`invalid_${label}: ${field} must be a safe non-negative integer`);
	}
	return value;
}

function authorityNullableCount(record: Record<string, unknown>, label: string, field: string): number | null {
	const value = record[field];
	if (value === null) return null;
	if (!isSafeNonNegativeInt(value)) {
		throw new Error(`invalid_${label}: ${field} must be a safe non-negative integer or null`);
	}
	return value;
}

function authorityHash(record: Record<string, unknown>, label: string, field: string): string {
	const value = record[field];
	if (!isHex64(value)) throw new Error(`invalid_${label}: ${field} must be a lowercase 64-hex sha256`);
	return value;
}

function authorityEnum<T extends string>(
	record: Record<string, unknown>,
	label: string,
	field: string,
	known: readonly T[],
): T {
	const value = record[field];
	if (typeof value !== "string" || !known.includes(value as T)) {
		throw new Error(`invalid_${label}: ${field} '${String(value)}' is not a known value`);
	}
	return value as T;
}

function authorityEnums<T extends string>(
	value: unknown,
	label: string,
	field: string,
	known: readonly T[],
): readonly T[] {
	return Object.freeze(
		authorityArray(value, label, field).map((entry, index) => {
			if (typeof entry !== "string" || !known.includes(entry as T)) {
				throw new Error(`invalid_${label}: ${field}[${index}] '${String(entry)}' is not a known value`);
			}
			return entry as T;
		}),
	);
}

const TOOL_CAPABILITY_KEYS = ["source", "name"] as const;

/** Source-qualified tool identity; a bare `name` is never a capability. */
export function parseToolCapability(value: unknown, label = "ToolCapability"): ToolCapability {
	const record = authorityRecord(value, label, TOOL_CAPABILITY_KEYS);
	return Object.freeze({
		source: authorityEnum(record, label, "source", TOOL_CAPABILITY_SOURCES),
		name: authorityString(record, label, "name"),
	});
}

function authorityCapabilities(value: unknown, label: string, field: string): readonly ToolCapability[] {
	return Object.freeze(
		authorityArray(value, label, field).map((entry, index) =>
			parseToolCapability(entry, `${label}.${field}[${index}]`),
		),
	);
}

const CONTEXT_MODE_FRESH_KEYS = ["kind", "strategy", "independence"] as const;
const CONTEXT_MODE_FORK_KEYS = [
	"kind",
	"parentSnapshotRef",
	"parentSnapshotGrantIntentId",
	"snapshotVersion",
	"reason",
] as const;

/**
 * Strict parse of a context mode.
 *
 * The two kinds carry disjoint fields, so they are parsed as a discriminated
 * union rather than as one permissive record: a `fresh` mode must not be
 * able to smuggle a parent snapshot reference through an ignored field.
 */
export function parseContextMode(value: unknown, label = "ContextMode"): ContextMode {
	if (!isPlainObject(value)) throw new Error(`invalid_${label}: expected object`);
	if (value.kind === "fresh") {
		const record = authorityRecord(value, label, CONTEXT_MODE_FRESH_KEYS);
		return Object.freeze({
			kind: "fresh" as const,
			strategy: authorityEnum(record, label, "strategy", KNOWN_CONTEXT_STRATEGIES),
			independence: authorityEnum(record, label, "independence", KNOWN_CONTEXT_INDEPENDENCE),
		});
	}
	if (value.kind === "privileged-fork") {
		const record = authorityRecord(value, label, CONTEXT_MODE_FORK_KEYS);
		if (record.snapshotVersion !== 1) throw new Error(`invalid_${label}: snapshotVersion must be 1`);
		return Object.freeze({
			kind: "privileged-fork" as const,
			parentSnapshotRef: parseArtifactRefV1(record.parentSnapshotRef, `${label}.parentSnapshotRef`),
			parentSnapshotGrantIntentId: authorityString(record, label, "parentSnapshotGrantIntentId"),
			snapshotVersion: 1 as const,
			reason: authorityString(record, label, "reason"),
		});
	}
	throw new Error(`invalid_${label}: kind '${String(value.kind)}' is not a known context mode`);
}

const BASE_CONTEXT_MANIFEST_KEYS = ["schemaVersion", "manifestHash", "segments"] as const;
const BASE_CONTEXT_SEGMENT_KEYS = ["segmentId", "kind", "contentRef"] as const;

export function parseBaseContextManifestV1(value: unknown, label = "BaseContextManifestV1"): BaseContextManifestV1 {
	const record = authorityRecord(value, label, BASE_CONTEXT_MANIFEST_KEYS);
	if (record.schemaVersion !== 1) throw new Error(`invalid_${label}: schemaVersion must be 1`);
	return Object.freeze({
		schemaVersion: 1 as const,
		manifestHash: authorityHash(record, label, "manifestHash"),
		segments: Object.freeze(
			authorityArray(record.segments, label, "segments").map((entry, index) => {
				const segmentLabel = `${label}.segments[${index}]`;
				const segment = authorityRecord(entry, segmentLabel, BASE_CONTEXT_SEGMENT_KEYS);
				return Object.freeze({
					segmentId: authorityString(segment, segmentLabel, "segmentId"),
					kind: authorityEnum(segment, segmentLabel, "kind", KNOWN_BASE_SEGMENT_KINDS),
					contentRef: parseArtifactRefV1(segment.contentRef, `${segmentLabel}.contentRef`),
				});
			}),
		),
	});
}

const RESOURCE_AUTHORITY_KEYS = [
	"resource",
	"mayUse",
	"mayIssue",
	"recipientPrincipalIds",
	"maxDelegationDepth",
	"disclosureDomains",
	"sourceGrantIds",
] as const;

/**
 * Strict parse of a resource authority entry.
 *
 * `mayIssue` is deliberately NOT required to be a subset of `mayUse`: a
 * planner may legitimately hand a resource onward without holding the right
 * to touch it itself, so deriving one set from the other would either strip
 * that planner or grant it access nobody issued.
 */
export function parseResourceAuthorityV1(value: unknown, label = "ResourceAuthorityV1"): ResourceAuthorityV1 {
	const record = authorityRecord(value, label, RESOURCE_AUTHORITY_KEYS);
	return Object.freeze({
		resource: parseResourceSelectorV1(record.resource, `${label}.resource`),
		mayUse: authorityOperations(record.mayUse, label, "mayUse"),
		mayIssue: authorityOperations(record.mayIssue, label, "mayIssue"),
		recipientPrincipalIds: authorityStrings(record.recipientPrincipalIds, label, "recipientPrincipalIds"),
		maxDelegationDepth: authorityCount(record, label, "maxDelegationDepth"),
		disclosureDomains: authorityDomains(record.disclosureDomains, label, "disclosureDomains"),
		sourceGrantIds: authorityStrings(record.sourceGrantIds, label, "sourceGrantIds"),
	});
}

const DISCLOSURE_INTENT_KEYS = [
	"intentId",
	"issuerPrincipalId",
	"recipientPrincipalId",
	"resource",
	"contentRef",
	"kind",
	"domains",
	"purpose",
	"sourceGrantIds",
	"required",
] as const;

export function parseDisclosureIntentV1(value: unknown, label = "DisclosureIntentV1"): DisclosureIntentV1 {
	const record = authorityRecord(value, label, DISCLOSURE_INTENT_KEYS);
	return Object.freeze({
		intentId: authorityString(record, label, "intentId"),
		issuerPrincipalId: authorityString(record, label, "issuerPrincipalId"),
		recipientPrincipalId: authorityString(record, label, "recipientPrincipalId"),
		resource: parseResourceSelectorV1(record.resource, `${label}.resource`),
		contentRef: parseArtifactRefV1(record.contentRef, `${label}.contentRef`),
		kind: authorityEnum(record, label, "kind", KNOWN_DISCLOSURE_KINDS),
		domains: authorityDomains(record.domains, label, "domains"),
		purpose: authorityString(record, label, "purpose"),
		sourceGrantIds: authorityStrings(record.sourceGrantIds, label, "sourceGrantIds"),
		required: authorityBoolean(record, label, "required"),
	});
}

const DELIVERY_CHANNEL_KEYS = [
	"channelId",
	"senderPrincipalIds",
	"recipientPrincipalId",
	"resourceSelectors",
	"domains",
	"messageKinds",
	"revealCondition",
	"maxMessageBytes",
	"maxTotalBytes",
	"maxMessages",
	"expiresAt",
	"onwardRecipientPrincipalIds",
] as const;
const KNOWN_REVEAL_CONDITIONS = ["open", "authorized-synthesis"] as const;

export function parseDeliveryChannelV1(value: unknown, label = "DeliveryChannelV1"): DeliveryChannelV1 {
	const record = authorityRecord(value, label, DELIVERY_CHANNEL_KEYS);
	return Object.freeze({
		channelId: authorityString(record, label, "channelId"),
		senderPrincipalIds: authorityStrings(record.senderPrincipalIds, label, "senderPrincipalIds"),
		recipientPrincipalId: authorityString(record, label, "recipientPrincipalId"),
		resourceSelectors: Object.freeze(
			authorityArray(record.resourceSelectors, label, "resourceSelectors").map((entry, index) =>
				parseResourceSelectorV1(entry, `${label}.resourceSelectors[${index}]`),
			),
		),
		domains: authorityDomains(record.domains, label, "domains"),
		messageKinds: authorityEnums(record.messageKinds, label, "messageKinds", KNOWN_DISCLOSURE_KINDS),
		revealCondition: authorityEnum(record, label, "revealCondition", KNOWN_REVEAL_CONDITIONS),
		maxMessageBytes: authorityCount(record, label, "maxMessageBytes"),
		maxTotalBytes: authorityCount(record, label, "maxTotalBytes"),
		maxMessages: authorityCount(record, label, "maxMessages"),
		expiresAt: authorityNullableCount(record, label, "expiresAt"),
		onwardRecipientPrincipalIds: authorityStrings(
			record.onwardRecipientPrincipalIds,
			label,
			"onwardRecipientPrincipalIds",
		),
	});
}

const COMMUNICATION_AUTHORITY_KEYS = [
	"policy",
	"visiblePrincipalIds",
	"sendPrincipalIds",
	"receivePrincipalIds",
	"wakePrincipalIds",
	"broadcastPrincipalIds",
	"busyReplyPrincipalIds",
	"controlPrincipalIds",
	"delegablePrincipalIds",
	"channelIds",
] as const;

export function parseCommunicationAuthorityV1(
	value: unknown,
	label = "CommunicationAuthorityV1",
): CommunicationAuthorityV1 {
	const record = authorityRecord(value, label, COMMUNICATION_AUTHORITY_KEYS);
	return Object.freeze({
		policy: parseWithValidator(record.policy, `${label}.policy`, validateCollaborationPolicy),
		visiblePrincipalIds: authorityStrings(record.visiblePrincipalIds, label, "visiblePrincipalIds"),
		sendPrincipalIds: authorityStrings(record.sendPrincipalIds, label, "sendPrincipalIds"),
		receivePrincipalIds: authorityStrings(record.receivePrincipalIds, label, "receivePrincipalIds"),
		wakePrincipalIds: authorityStrings(record.wakePrincipalIds, label, "wakePrincipalIds"),
		broadcastPrincipalIds: authorityStrings(record.broadcastPrincipalIds, label, "broadcastPrincipalIds"),
		busyReplyPrincipalIds: authorityStrings(record.busyReplyPrincipalIds, label, "busyReplyPrincipalIds"),
		controlPrincipalIds: authorityStrings(record.controlPrincipalIds, label, "controlPrincipalIds"),
		delegablePrincipalIds: authorityStrings(record.delegablePrincipalIds, label, "delegablePrincipalIds"),
		channelIds: authorityStrings(record.channelIds, label, "channelIds"),
	});
}

const OBSERVATION_AUTHORITY_KEYS = ["observers"] as const;
const OBSERVER_KEYS = ["principalId", "rights"] as const;

export function parseObservationAuthorityV1(value: unknown, label = "ObservationAuthorityV1"): ObservationAuthorityV1 {
	const record = authorityRecord(value, label, OBSERVATION_AUTHORITY_KEYS);
	return Object.freeze({
		observers: Object.freeze(
			authorityArray(record.observers, label, "observers").map((entry, index) => {
				const observerLabel = `${label}.observers[${index}]`;
				const observer = authorityRecord(entry, observerLabel, OBSERVER_KEYS);
				return Object.freeze({
					principalId: authorityString(observer, observerLabel, "principalId"),
					rights: authorityEnums(observer.rights, observerLabel, "rights", KNOWN_OBSERVATION_RIGHTS),
				});
			}),
		),
	});
}

const SPAWN_AUTHORITY_KEYS = [
	"maySpawn",
	"mayDelegateSpawn",
	"allowedAgentTypes",
	"allowedLaunchClasses",
	"maxDepth",
	"maxChildren",
	"delegableResourceGrantIds",
] as const;

export function parseSpawnAuthorityV1(value: unknown, label = "SpawnAuthorityV1"): SpawnAuthorityV1 {
	const record = authorityRecord(value, label, SPAWN_AUTHORITY_KEYS);
	return Object.freeze({
		maySpawn: authorityBoolean(record, label, "maySpawn"),
		mayDelegateSpawn: authorityBoolean(record, label, "mayDelegateSpawn"),
		allowedAgentTypes: authorityStrings(record.allowedAgentTypes, label, "allowedAgentTypes"),
		allowedLaunchClasses: authorityEnums(
			record.allowedLaunchClasses,
			label,
			"allowedLaunchClasses",
			KNOWN_LAUNCH_CLASSES,
		),
		maxDepth: authorityCount(record, label, "maxDepth"),
		maxChildren: authorityCount(record, label, "maxChildren"),
		delegableResourceGrantIds: authorityStrings(record.delegableResourceGrantIds, label, "delegableResourceGrantIds"),
	});
}

const BUDGET_FINITE_KEYS = ["kind", "limits", "reservation"] as const;
const BUDGET_LEGACY_KEYS = ["kind", "limits", "reservation", "zeroMeansUnlimited", "authorityRef"] as const;

/**
 * Strict parse of a launch budget.
 *
 * The `legacy` kind must carry an explicit `zeroMeansUnlimited: true` and an
 * authority reference: unbounded budgeting is an authorized exception, never
 * a default a record can fall into by omitting a field.
 */
export function parseLaunchBudgetV1(value: unknown, label = "LaunchBudgetV1"): LaunchBudgetV1 {
	if (!isPlainObject(value)) throw new Error(`invalid_${label}: expected object`);
	if (value.kind === "finite") {
		const record = authorityRecord(value, label, BUDGET_FINITE_KEYS);
		return Object.freeze({
			kind: "finite" as const,
			limits: parseRunLimitsV1(record.limits, `${label}.limits`),
			reservation: parseReservationVector(record.reservation, `${label}.reservation`),
		});
	}
	if (value.kind === "legacy") {
		const record = authorityRecord(value, label, BUDGET_LEGACY_KEYS);
		if (record.zeroMeansUnlimited !== true) {
			throw new Error(`invalid_${label}: legacy budgets must declare zeroMeansUnlimited: true`);
		}
		return Object.freeze({
			kind: "legacy" as const,
			limits: parseRunLimitsV1(record.limits, `${label}.limits`),
			reservation: parseReservationVector(record.reservation, `${label}.reservation`),
			zeroMeansUnlimited: true as const,
			authorityRef: authorityString(record, label, "authorityRef"),
		});
	}
	throw new Error(`invalid_${label}: kind '${String(value.kind)}' is not a known budget kind`);
}

const RESULT_AUTHORITY_KEYS = [
	"outputSchemaRef",
	"maxOutputBytes",
	"requiredCriterionIds",
	"publicationRequired",
	"mutation",
	"publicationGrantIds",
	"acceptedRecipientPrincipalIds",
] as const;

export function parseResultAuthorityV1(value: unknown, label = "ResultAuthorityV1"): ResultAuthorityV1 {
	const record = authorityRecord(value, label, RESULT_AUTHORITY_KEYS);
	return Object.freeze({
		outputSchemaRef: authorityNullableString(record, label, "outputSchemaRef"),
		maxOutputBytes: authorityCount(record, label, "maxOutputBytes"),
		requiredCriterionIds: authorityStrings(record.requiredCriterionIds, label, "requiredCriterionIds"),
		publicationRequired: authorityBoolean(record, label, "publicationRequired"),
		mutation: parseMutationContractV1(record.mutation, `${label}.mutation`),
		publicationGrantIds: authorityStrings(record.publicationGrantIds, label, "publicationGrantIds"),
		acceptedRecipientPrincipalIds: authorityStrings(
			record.acceptedRecipientPrincipalIds,
			label,
			"acceptedRecipientPrincipalIds",
		),
	});
}

const RUNTIME_GUARANTEE_KEYS = [
	"initialContext",
	"transcriptAccess",
	"serviceAccess",
	"artifactAccess",
	"memoryAccess",
	"evalState",
	"filesystemRead",
	"filesystemWrite",
	"process",
	"network",
	"credentials",
] as const;

/**
 * Accepted values per dimension are read from the same satisfaction table
 * `compareRuntimeGuarantees` uses, so a new guarantee value cannot be
 * parseable while being uncomparable.
 */
function guaranteeValue<K extends keyof RuntimeGuaranteesV1>(
	record: Record<string, unknown>,
	label: string,
	dimension: K,
): RuntimeGuaranteesV1[K] {
	const accepted = Object.keys(GUARANTEE_SATISFACTION[dimension] ?? {});
	const value = record[dimension];
	if (typeof value !== "string" || !accepted.includes(value)) {
		throw new Error(`invalid_${label}: ${dimension} '${String(value)}' is not a known guarantee`);
	}
	return value as RuntimeGuaranteesV1[K];
}

export function parseRuntimeGuaranteesV1(value: unknown, label = "RuntimeGuaranteesV1"): RuntimeGuaranteesV1 {
	const record = authorityRecord(value, label, RUNTIME_GUARANTEE_KEYS);
	return Object.freeze({
		initialContext: guaranteeValue(record, label, "initialContext"),
		transcriptAccess: guaranteeValue(record, label, "transcriptAccess"),
		serviceAccess: guaranteeValue(record, label, "serviceAccess"),
		artifactAccess: guaranteeValue(record, label, "artifactAccess"),
		memoryAccess: guaranteeValue(record, label, "memoryAccess"),
		evalState: guaranteeValue(record, label, "evalState"),
		filesystemRead: guaranteeValue(record, label, "filesystemRead"),
		filesystemWrite: guaranteeValue(record, label, "filesystemWrite"),
		process: guaranteeValue(record, label, "process"),
		network: guaranteeValue(record, label, "network"),
		credentials: guaranteeValue(record, label, "credentials"),
	});
}

const COMPATIBILITY_EXCEPTION_KEYS = [
	"classification",
	"code",
	"resourceKind",
	"requiredGuarantee",
	"actualGuarantee",
	"reason",
	"authorityRef",
] as const;

export function parseCompatibilityExceptionV1(
	value: unknown,
	label = "CompatibilityExceptionV1",
): CompatibilityExceptionV1 {
	const record = authorityRecord(value, label, COMPATIBILITY_EXCEPTION_KEYS);
	return Object.freeze({
		classification: authorityEnum(record, label, "classification", KNOWN_COMPATIBILITY_CLASSIFICATIONS),
		code: authorityString(record, label, "code"),
		resourceKind: authorityString(record, label, "resourceKind"),
		requiredGuarantee: authorityNullableString(record, label, "requiredGuarantee"),
		actualGuarantee: authorityString(record, label, "actualGuarantee"),
		reason: authorityString(record, label, "reason"),
		authorityRef: authorityNullableString(record, label, "authorityRef"),
	});
}

const LAUNCH_AUTHORITY_KEYS = [
	"schemaVersion",
	"launchClass",
	"contextMode",
	"baseContextManifest",
	"workspaceInstructionRefs",
	"agentTemplateRef",
	"initialDisclosures",
	"deliveryChannels",
	"usableCapabilities",
	"delegableCapabilities",
	"resources",
	"collaboration",
	"observation",
	"spawn",
	"budget",
	"result",
	"requiredRuntimeGuarantees",
	"compatibility",
] as const;

/**
 * Strict parse of the authority a child may hold.
 *
 * Structural only, exactly like `compileLaunchAuthority`: whether the issuer
 * was entitled to issue this authority is decided by the compiler and the
 * admission transaction, not by a decoder.
 */
export function parseLaunchAuthorityV1(value: unknown, label = "LaunchAuthorityV1"): LaunchAuthorityV1 {
	const record = authorityRecord(value, label, LAUNCH_AUTHORITY_KEYS);
	if (record.schemaVersion !== 1) throw new Error(`invalid_${label}: schemaVersion must be 1`);
	return Object.freeze({
		schemaVersion: 1 as const,
		launchClass: authorityEnum(record, label, "launchClass", KNOWN_LAUNCH_CLASSES),
		contextMode: parseContextMode(record.contextMode, `${label}.contextMode`),
		baseContextManifest: parseBaseContextManifestV1(record.baseContextManifest, `${label}.baseContextManifest`),
		workspaceInstructionRefs: Object.freeze(
			authorityArray(record.workspaceInstructionRefs, label, "workspaceInstructionRefs").map((entry, index) =>
				parseArtifactRefV1(entry, `${label}.workspaceInstructionRefs[${index}]`),
			),
		),
		agentTemplateRef: parseArtifactRefV1(record.agentTemplateRef, `${label}.agentTemplateRef`),
		initialDisclosures: Object.freeze(
			authorityArray(record.initialDisclosures, label, "initialDisclosures").map((entry, index) =>
				parseDisclosureIntentV1(entry, `${label}.initialDisclosures[${index}]`),
			),
		),
		deliveryChannels: Object.freeze(
			authorityArray(record.deliveryChannels, label, "deliveryChannels").map((entry, index) =>
				parseDeliveryChannelV1(entry, `${label}.deliveryChannels[${index}]`),
			),
		),
		usableCapabilities: authorityCapabilities(record.usableCapabilities, label, "usableCapabilities"),
		delegableCapabilities: authorityCapabilities(record.delegableCapabilities, label, "delegableCapabilities"),
		resources: Object.freeze(
			authorityArray(record.resources, label, "resources").map((entry, index) =>
				parseResourceAuthorityV1(entry, `${label}.resources[${index}]`),
			),
		),
		collaboration: parseCommunicationAuthorityV1(record.collaboration, `${label}.collaboration`),
		observation: parseObservationAuthorityV1(record.observation, `${label}.observation`),
		spawn: parseSpawnAuthorityV1(record.spawn, `${label}.spawn`),
		budget: parseLaunchBudgetV1(record.budget, `${label}.budget`),
		result: parseResultAuthorityV1(record.result, `${label}.result`),
		requiredRuntimeGuarantees: parseRuntimeGuaranteesV1(
			record.requiredRuntimeGuarantees,
			`${label}.requiredRuntimeGuarantees`,
		),
		compatibility: Object.freeze(
			authorityArray(record.compatibility, label, "compatibility").map((entry, index) =>
				parseCompatibilityExceptionV1(entry, `${label}.compatibility[${index}]`),
			),
		),
	});
}

export const AUTHORITY_ENVELOPE_KEYS = [
	"schemaVersion",
	"usableCapabilities",
	"delegableCapabilities",
	"resources",
	"collaboration",
	"spawn",
	"budget",
	"result",
] as const;

export function parseAuthorityEnvelopeV1(value: unknown, label = "AuthorityEnvelopeV1"): AuthorityEnvelopeV1 {
	const record = authorityRecord(value, label, AUTHORITY_ENVELOPE_KEYS);
	if (record.schemaVersion !== 1) throw new Error(`invalid_${label}: schemaVersion must be 1`);
	return Object.freeze({
		schemaVersion: 1 as const,
		usableCapabilities: authorityCapabilities(record.usableCapabilities, label, "usableCapabilities"),
		delegableCapabilities: authorityCapabilities(record.delegableCapabilities, label, "delegableCapabilities"),
		resources: Object.freeze(
			authorityArray(record.resources, label, "resources").map((entry, index) =>
				parseResourceAuthorityV1(entry, `${label}.resources[${index}]`),
			),
		),
		collaboration: parseCommunicationAuthorityV1(record.collaboration, `${label}.collaboration`),
		spawn: parseSpawnAuthorityV1(record.spawn, `${label}.spawn`),
		budget: parseLaunchBudgetV1(record.budget, `${label}.budget`),
		result: parseResultAuthorityV1(record.result, `${label}.result`),
	});
}

export const LAUNCH_AUTHORIZATION_SNAPSHOT_KEYS = [
	"schemaVersion",
	"authorizationRef",
	"issuerPrincipalId",
	"rootPrincipalId",
	"parentPrincipalId",
	"childPrincipalId",
	"contractId",
	"contractRevision",
	"priorContractDigest",
	"issuerPolicyEpoch",
	"entryPoint",
	"reason",
	"requestedAuthority",
	"sourceGrants",
	"parentDelegable",
	"hostMaximum",
	"agentMaximum",
	"workflowMaximum",
	"toolCatalogDigest",
] as const;

export function parseLaunchAuthorizationSnapshotV1(
	value: unknown,
	label = "LaunchAuthorizationSnapshotV1",
): LaunchAuthorizationSnapshotV1 {
	const record = authorityRecord(value, label, LAUNCH_AUTHORIZATION_SNAPSHOT_KEYS);
	if (record.schemaVersion !== 1) throw new Error(`invalid_${label}: schemaVersion must be 1`);
	const contractRevision = authorityCount(record, label, "contractRevision");
	if (contractRevision < 1) throw new Error(`invalid_${label}: contractRevision must be >= 1`);
	if (record.priorContractDigest !== null && typeof record.priorContractDigest !== "string") {
		throw new Error(`invalid_${label}: priorContractDigest must be a 64-hex digest or null`);
	}
	const priorContractDigest =
		record.priorContractDigest === null ? null : authorityHash(record, label, "priorContractDigest");
	return Object.freeze({
		schemaVersion: 1 as const,
		authorizationRef: authorityString(record, label, "authorizationRef"),
		issuerPrincipalId: authorityString(record, label, "issuerPrincipalId"),
		rootPrincipalId: authorityString(record, label, "rootPrincipalId"),
		parentPrincipalId: authorityString(record, label, "parentPrincipalId"),
		childPrincipalId: authorityString(record, label, "childPrincipalId"),
		contractId: authorityString(record, label, "contractId"),
		contractRevision,
		priorContractDigest,
		issuerPolicyEpoch: authorityCount(record, label, "issuerPolicyEpoch"),
		entryPoint: authorityString(record, label, "entryPoint"),
		reason: authorityString(record, label, "reason"),
		requestedAuthority: parseLaunchAuthorityV1(record.requestedAuthority, `${label}.requestedAuthority`),
		sourceGrants: Object.freeze(
			authorityArray(record.sourceGrants, label, "sourceGrants").map(entry => parseGrantRecordV1(entry)),
		),
		parentDelegable: parseAuthorityEnvelopeV1(record.parentDelegable, `${label}.parentDelegable`),
		hostMaximum: parseAuthorityEnvelopeV1(record.hostMaximum, `${label}.hostMaximum`),
		agentMaximum: parseAuthorityEnvelopeV1(record.agentMaximum, `${label}.agentMaximum`),
		workflowMaximum: parseAuthorityEnvelopeV1(record.workflowMaximum, `${label}.workflowMaximum`),
		toolCatalogDigest: authorityHash(record, label, "toolCatalogDigest"),
	});
}

export const KNOWN_GRANT_EVENT_KINDS = ["issued", "revoked", "superseded"] as const;

export const GRANT_EVENT_KEYS = [
	"eventId",
	"grantId",
	"kind",
	"actorPrincipalId",
	"policyEpoch",
	"reason",
	"recordDigest",
	"occurredAt",
] as const;

export function parseGrantEventV1(value: unknown, label = "GrantEventV1"): GrantEventV1 {
	const record = authorityRecord(value, label, GRANT_EVENT_KEYS);
	return Object.freeze({
		eventId: authorityString(record, label, "eventId"),
		grantId: authorityString(record, label, "grantId"),
		kind: authorityEnum(record, label, "kind", KNOWN_GRANT_EVENT_KINDS),
		actorPrincipalId: authorityString(record, label, "actorPrincipalId"),
		policyEpoch: authorityCount(record, label, "policyEpoch"),
		reason: authorityString(record, label, "reason"),
		recordDigest: authorityHash(record, label, "recordDigest"),
		occurredAt: authorityCount(record, label, "occurredAt"),
	});
}

const LAUNCH_AUTHORITY_REF_KEYS = [
	"bindingId",
	"principalId",
	"attemptId",
	"contractId",
	"contractRevision",
	"contractDigest",
	"policyEpoch",
] as const;

/**
 * Strict parse of a pinned authority reference.
 *
 * Every field is required: a ref missing its digest or epoch would name a
 * binding without pinning WHICH revision of it, which is precisely how a
 * stale or superseded authority survives a restart.
 */
export function parseLaunchAuthorityRefV1(value: unknown, label = "LaunchAuthorityRefV1"): LaunchAuthorityRefV1 {
	const record = authorityRecord(value, label, LAUNCH_AUTHORITY_REF_KEYS);
	const contractRevision = authorityCount(record, label, "contractRevision");
	if (contractRevision < 1) throw new Error(`invalid_${label}: contractRevision must be >= 1`);
	return Object.freeze({
		bindingId: authorityString(record, label, "bindingId"),
		principalId: authorityString(record, label, "principalId"),
		attemptId: authorityString(record, label, "attemptId"),
		contractId: authorityString(record, label, "contractId"),
		contractRevision,
		contractDigest: authorityHash(record, label, "contractDigest"),
		policyEpoch: authorityCount(record, label, "policyEpoch"),
	});
}

const COMPILED_CONTRACT_KEYS = [
	"schemaVersion",
	"policyVersion",
	"contractId",
	"contractRevision",
	"contractDigest",
	"priorContractDigest",
	"rootPrincipalId",
	"parentPrincipalId",
	"childPrincipalId",
	"capsule",
	"policy",
	"missionHash",
	"policyHash",
	"authority",
	"provenance",
] as const;
const PROVENANCE_KEYS = ["authorizationRef", "reason", "issuerPrincipalId"] as const;

/**
 * Strict parse of a compiled contract read back from storage.
 *
 * Recomputes the mission hash, the policy hash and the contract digest from
 * the reconstructed record. A stored contract whose body was edited after
 * compilation therefore fails here, instead of being handed to a binding as
 * if the compiler had approved it.
 */
export function parseCompiledLaunchContract(value: unknown, label = "CompiledLaunchContract"): CompiledLaunchContract {
	const record = authorityRecord(value, label, COMPILED_CONTRACT_KEYS);
	if (record.schemaVersion !== 2) throw new Error(`invalid_${label}: schemaVersion must be 2`);
	if (record.policyVersion !== 1) throw new Error(`invalid_${label}: policyVersion must be 1`);
	const contractRevision = authorityCount(record, label, "contractRevision");
	if (contractRevision < 1) throw new Error(`invalid_${label}: contractRevision must be >= 1`);
	const capsule = parseWithValidator(record.capsule, `${label}.capsule`, validateMissionCapsule);
	const policy = parseWithValidator(record.policy, `${label}.policy`, validateRuntimePolicy);
	const missionHash = authorityHash(record, label, "missionHash");
	const policyHash = authorityHash(record, label, "policyHash");
	if (computeMissionHash(capsule) !== missionHash) {
		throw new Error(`invalid_${label}: contract_hash_mismatch (missionHash does not match the capsule)`);
	}
	if (computePolicyHash(policy) !== policyHash) {
		throw new Error(`invalid_${label}: contract_hash_mismatch (policyHash does not match the policy)`);
	}
	const provenanceLabel = `${label}.provenance`;
	const provenance = authorityRecord(record.provenance, provenanceLabel, PROVENANCE_KEYS);
	const body = {
		schemaVersion: 2 as const,
		policyVersion: 1 as const,
		contractId: authorityString(record, label, "contractId"),
		contractRevision,
		priorContractDigest:
			record.priorContractDigest === null ? null : authorityHash(record, label, "priorContractDigest"),
		rootPrincipalId: authorityString(record, label, "rootPrincipalId"),
		parentPrincipalId: authorityString(record, label, "parentPrincipalId"),
		childPrincipalId: authorityString(record, label, "childPrincipalId"),
		capsule,
		policy,
		missionHash,
		policyHash,
		authority: parseLaunchAuthorityV1(record.authority, `${label}.authority`),
		provenance: Object.freeze({
			authorizationRef: authorityString(provenance, provenanceLabel, "authorizationRef"),
			reason: authorityString(provenance, provenanceLabel, "reason"),
			issuerPrincipalId: authorityString(provenance, provenanceLabel, "issuerPrincipalId"),
		}),
	};
	const contractDigest = authorityHash(record, label, "contractDigest");
	if (computeLaunchContractDigest(body) !== contractDigest) {
		throw new Error(`invalid_${label}: contract_digest_mismatch`);
	}
	return Object.freeze({ ...body, contractDigest });
}

const BINDING_KEYS = [
	"schemaVersion",
	"bindingId",
	"contractId",
	"contractRevision",
	"contractDigest",
	"rootPrincipalId",
	"parentPrincipalId",
	"childPrincipalId",
	"attemptId",
	"sessionId",
	"processRef",
	"policyEpoch",
	"contextGeneration",
	"state",
	"grantBindings",
	"serviceBindings",
	"actualRuntimeGuarantees",
	"guaranteeEvidenceRefs",
	"reservationId",
	"lifecycle",
	"expiresAt",
	"restoresBindingId",
] as const;
const GRANT_BINDING_KEYS = ["intentId", "grantId", "recordDigest"] as const;
const SERVICE_BINDING_KEYS = ["kind", "adapterId", "namespace", "guarantee"] as const;
const BINDING_LIFECYCLE_KEYS = [
	"runId",
	"nodeId",
	"ownerNodeId",
	"jobId",
	"leaseEpoch",
	"cancellationGeneration",
] as const;

function parseBindingLifecycle(value: unknown, label: string): LaunchBinding["lifecycle"] {
	if (value === null) return null;
	const record = authorityRecord(value, label, BINDING_LIFECYCLE_KEYS);
	return Object.freeze({
		runId: authorityString(record, label, "runId"),
		nodeId: authorityString(record, label, "nodeId"),
		ownerNodeId: authorityNullableString(record, label, "ownerNodeId"),
		jobId: authorityString(record, label, "jobId"),
		leaseEpoch: authorityCount(record, label, "leaseEpoch"),
		cancellationGeneration: authorityCount(record, label, "cancellationGeneration"),
	});
}

/**
 * Strict parse of the persisted binding record (§14.2).
 *
 * Also enforces the state-to-evidence invariant through
 * `validateLaunchBindingGuarantees`, so a decoded `bound`/`active` row can
 * never advertise protections nobody measured.
 */
export function parseLaunchBinding(value: unknown, label = "LaunchBinding"): LaunchBinding {
	const record = authorityRecord(value, label, BINDING_KEYS);
	if (record.schemaVersion !== 1) throw new Error(`invalid_${label}: schemaVersion must be 1`);
	const contractRevision = authorityCount(record, label, "contractRevision");
	if (contractRevision < 1) throw new Error(`invalid_${label}: contractRevision must be >= 1`);
	const binding: LaunchBinding = Object.freeze({
		schemaVersion: 1 as const,
		bindingId: authorityString(record, label, "bindingId"),
		contractId: authorityString(record, label, "contractId"),
		contractRevision,
		contractDigest: authorityHash(record, label, "contractDigest"),
		rootPrincipalId: authorityString(record, label, "rootPrincipalId"),
		parentPrincipalId: authorityString(record, label, "parentPrincipalId"),
		childPrincipalId: authorityString(record, label, "childPrincipalId"),
		attemptId: authorityString(record, label, "attemptId"),
		sessionId: authorityNullableString(record, label, "sessionId"),
		processRef: authorityNullableString(record, label, "processRef"),
		policyEpoch: authorityCount(record, label, "policyEpoch"),
		contextGeneration: authorityCount(record, label, "contextGeneration"),
		state: authorityEnum(record, label, "state", KNOWN_LAUNCH_BINDING_STATES),
		grantBindings: Object.freeze(
			authorityArray(record.grantBindings, label, "grantBindings").map((entry, index) => {
				const grantLabel = `${label}.grantBindings[${index}]`;
				const grant = authorityRecord(entry, grantLabel, GRANT_BINDING_KEYS);
				return Object.freeze({
					intentId: authorityString(grant, grantLabel, "intentId"),
					grantId: authorityString(grant, grantLabel, "grantId"),
					recordDigest: authorityHash(grant, grantLabel, "recordDigest"),
				});
			}),
		),
		serviceBindings: Object.freeze(
			authorityArray(record.serviceBindings, label, "serviceBindings").map((entry, index) => {
				const serviceLabel = `${label}.serviceBindings[${index}]`;
				const service = authorityRecord(entry, serviceLabel, SERVICE_BINDING_KEYS);
				return Object.freeze({
					kind: authorityEnum(service, serviceLabel, "kind", KNOWN_RESOURCE_KINDS),
					adapterId: authorityString(service, serviceLabel, "adapterId"),
					namespace: authorityString(service, serviceLabel, "namespace"),
					guarantee: authorityString(service, serviceLabel, "guarantee"),
				});
			}),
		),
		actualRuntimeGuarantees:
			record.actualRuntimeGuarantees === null
				? null
				: parseRuntimeGuaranteesV1(record.actualRuntimeGuarantees, `${label}.actualRuntimeGuarantees`),
		guaranteeEvidenceRefs: Object.freeze(
			authorityArray(record.guaranteeEvidenceRefs, label, "guaranteeEvidenceRefs").map((entry, index) =>
				parseArtifactRefV1(entry, `${label}.guaranteeEvidenceRefs[${index}]`),
			),
		),
		reservationId: authorityNullableString(record, label, "reservationId"),
		lifecycle: parseBindingLifecycle(record.lifecycle, `${label}.lifecycle`),
		expiresAt: authorityNullableCount(record, label, "expiresAt"),
		restoresBindingId: authorityNullableString(record, label, "restoresBindingId"),
	});
	validateLaunchBindingGuarantees(binding);
	return binding;
}

/**
 * Project a persisted binding onto the authority reference that pins it.
 *
 * Derived, never authored: every field is copied from the durable record, so
 * a fence or an evidence manifest names exactly the binding, revision and
 * epoch it was produced under rather than a value its writer chose.
 * `principalId` is the CHILD principal, matching `LaunchAuthorityRefV1`.
 */
export function launchAuthorityRefFor(binding: LaunchBinding): LaunchAuthorityRefV1 {
	return Object.freeze({
		bindingId: binding.bindingId,
		principalId: binding.childPrincipalId,
		attemptId: binding.attemptId,
		contractId: binding.contractId,
		contractRevision: binding.contractRevision,
		contractDigest: binding.contractDigest,
		policyEpoch: binding.policyEpoch,
	});
}

// --- Authority compilation (§14.3) -----------------------------------------

/** Canonical identity for a source-qualified capability. */
function capabilityKey(capability: ToolCapability): string {
	return `${capability.source}\u0000${capability.name}`;
}

function intersectCapabilities(
	requested: readonly ToolCapability[],
	ceilings: readonly (readonly ToolCapability[])[],
): readonly ToolCapability[] {
	const ceilingKeys = ceilings.map(ceiling => new Set(ceiling.map(capabilityKey)));
	const seen = new Set<string>();
	const kept: ToolCapability[] = [];
	for (const capability of requested) {
		const key = capabilityKey(capability);
		if (seen.has(key)) continue;
		if (!ceilingKeys.every(ceiling => ceiling.has(key))) continue;
		seen.add(key);
		kept.push(Object.freeze({ source: capability.source, name: capability.name }));
	}
	return Object.freeze(kept);
}

export type LaunchAuthorityCompileResult =
	| { readonly ok: true; readonly authority: LaunchAuthorityV1 }
	| { readonly ok: false; readonly diagnostics: readonly LaunchContractDiagnostic[] };

/**
 * Compile the authority a child may hold, from an authenticated preflight
 * snapshot.
 *
 * Pure: this validates structure and subset relationships only. Whether the
 * issuer is currently authentic, and whether its grants are still live, is
 * decided by the authorizer and the commit transaction.
 *
 * Two separate intersections, deliberately:
 *   usable    = requested n parent.delegable n agent n workflow n host
 *   delegable = requested-onward n parent.delegable n agent n workflow n host
 *
 * `delegable` is NOT derived from `usable`. A planner may legitimately hold
 * the right to hand a tool to a child without holding the right to invoke it
 * itself, so deriving one from the other would either strip that planner or
 * silently grant it execution it was never given.
 */
export function compileLaunchAuthority(snapshot: LaunchAuthorizationSnapshotV1): LaunchAuthorityCompileResult {
	const diagnostics: LaunchContractDiagnostic[] = [];
	const requested = snapshot.requestedAuthority;

	if (snapshot.schemaVersion !== 1) {
		diagnostics.push({
			code: "unsupported_authorization_version",
			message: `authorization snapshot version ${String(snapshot.schemaVersion)} is not supported`,
			path: "authorization.schemaVersion",
		});
		return { ok: false, diagnostics: Object.freeze(diagnostics) };
	}

	const ceilings = [
		snapshot.parentDelegable.delegableCapabilities,
		snapshot.agentMaximum.usableCapabilities,
		snapshot.workflowMaximum.usableCapabilities,
		snapshot.hostMaximum.usableCapabilities,
	];
	const usableCapabilities = intersectCapabilities(requested.usableCapabilities, ceilings);
	for (const capability of requested.usableCapabilities) {
		if (!usableCapabilities.some(kept => capabilityKey(kept) === capabilityKey(capability))) {
			diagnostics.push({
				code: "capability_not_delegable",
				message: `requested tool ${capability.source}:${capability.name} exceeds an ancestor ceiling`,
				path: "authority.usableCapabilities",
			});
		}
	}

	const delegableCeilings = [
		snapshot.parentDelegable.delegableCapabilities,
		snapshot.agentMaximum.delegableCapabilities,
		snapshot.workflowMaximum.delegableCapabilities,
		snapshot.hostMaximum.delegableCapabilities,
	];
	const delegableCapabilities = intersectCapabilities(requested.delegableCapabilities, delegableCeilings);
	for (const capability of requested.delegableCapabilities) {
		if (!delegableCapabilities.some(kept => capabilityKey(kept) === capabilityKey(capability))) {
			diagnostics.push({
				code: "capability_not_issuable",
				message: `requested onward tool ${capability.source}:${capability.name} exceeds the issuer's delegable ceiling`,
				path: "authority.delegableCapabilities",
			});
		}
	}

	// Spawn rights must strictly decrease inside the ancestor envelope, or a
	// chain of children could hold the parent's depth forever.
	const parentSpawn = snapshot.parentDelegable.spawn;
	const spawn = requested.spawn;
	if (spawn.maySpawn && !parentSpawn.mayDelegateSpawn) {
		diagnostics.push({
			code: "spawn_not_delegable",
			message: "issuer may not delegate the right to spawn",
			path: "authority.spawn.maySpawn",
		});
	}
	if (spawn.maySpawn && spawn.maxDepth >= parentSpawn.maxDepth) {
		diagnostics.push({
			code: "spawn_depth_not_decreasing",
			message: `child maxDepth ${spawn.maxDepth} must be below the issuer's ${parentSpawn.maxDepth}`,
			path: "authority.spawn.maxDepth",
		});
	}
	if (spawn.maxChildren > parentSpawn.maxChildren) {
		diagnostics.push({
			code: "spawn_fanout_exceeds_issuer",
			message: `child maxChildren ${spawn.maxChildren} exceeds the issuer's ${parentSpawn.maxChildren}`,
			path: "authority.spawn.maxChildren",
		});
	}
	for (const launchClass of spawn.allowedLaunchClasses) {
		if (!parentSpawn.allowedLaunchClasses.includes(launchClass)) {
			diagnostics.push({
				code: "launch_class_not_delegable",
				message: `issuer cannot delegate launch class '${launchClass}'`,
				path: "authority.spawn.allowedLaunchClasses",
			});
		}
	}

	// A strict worker must not run on legacy zero-means-unlimited budgeting:
	// that is precisely how an unattended hierarchy recurses without bound.
	if (requested.launchClass === "strict-worker" && requested.budget.kind !== "finite") {
		diagnostics.push({
			code: "budget_required",
			message: "a strict worker requires a finite budget, not legacy unlimited semantics",
			path: "authority.budget.kind",
		});
	}

	// A fork carries the parent's history, so it can never be the independent
	// reviewer the caller asked for. Reject rather than quietly downgrading
	// either the independence claim or the context mode.
	if (requested.contextMode.kind === "privileged-fork" && requested.launchClass !== "privileged-helper") {
		diagnostics.push({
			code: "fork_requires_privileged_helper",
			message: "privileged-fork context is only available to a privileged-helper launch",
			path: "authority.contextMode",
		});
	}
	if (requested.contextMode.kind === "fresh" && requested.contextMode.strategy === "blind") {
		const observers = requested.observation.observers;
		if (observers.some(observer => observer.rights.includes("transcript"))) {
			diagnostics.push({
				code: "blind_context_transcript_observer",
				message: "a blind child cannot expose its transcript to an observer",
				path: "authority.observation",
			});
		}
	}

	// Result authority must match the capsule-derived policy exactly rather
	// than silently selecting whichever copy is wider.
	if (requested.result.publicationRequired && !requested.result.mutation.apply) {
		diagnostics.push({
			code: "inconsistent_launch_policy",
			message: "publication is required but the mutation contract does not permit apply",
			path: "authority.result",
		});
	}

	if (diagnostics.length > 0) return { ok: false, diagnostics: Object.freeze(diagnostics) };
	return {
		ok: true,
		authority: Object.freeze({ ...requested, usableCapabilities, delegableCapabilities }),
	};
}
