/**
 * Foreground Task admission from a host-registered issuer and its actual authority ceiling.
 * Admission and evidence persistence are asynchronous; SDK activation binds the real session later.
 * Resource grants, channels, and other launch routes are unsupported in this bounded slice.
 * Stable parent/key identities support durable idempotency without allocating runtime resources.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils";
import type { Settings } from "../config/settings";
import { LifecycleStore } from "../operational/lifecycle-store";
import { type AgentExecutionProfile, resolveAgentExecutionProfile } from "../orchestration/agent-execution-profile";
import { type CollaborationPolicy, resolveCollaborationPolicy } from "../orchestration/collaboration-policy";
import {
	getLifecycleRegistration,
	type LifecycleExecutionContext,
	type RootExecutionContext,
} from "../orchestration/lifecycle-authority";
import {
	CONTROL_BUILTIN_NAMES,
	isToolCapabilityAllowed,
	type ResolvedToolProfile,
	resolveToolProfile,
	type ToolCapability,
} from "../tools/tool-profiles";
import * as git from "../utils/git";
import { type LifecycleLaunchResult, type PendingLifecycleLaunch, prepareLifecycleLaunch } from "./launch-admission";
import {
	type ArtifactRefV1,
	type AuthorityEnvelopeV1,
	type CompiledLaunchContract,
	type ContextStrategy,
	canonicalJson,
	type GrantRecordV1,
	type LaunchBinding,
	type LaunchContractDiagnostic,
	type MissionCapsule,
	type RuntimeGuaranteesV1,
	type RuntimePolicySnapshotV1,
	type SnapshotRefV1,
	sha256Hex,
} from "./launch-contract";
import { createSpawnPlan, type SpawnPlan } from "./spawn-plan";
import type { AgentDefinition } from "./types";
import { captureBaseline } from "./worktree";

/** The supported foreground launch route. */
export const LAUNCH_ENTRY_POINTS = Object.freeze({
	taskSpawn: "task.spawn",
} as const);

export interface BoundChildLaunchRequest {
	/** Issuer context from `session.getLifecycleIssuerContext?.()` ΓÇö never undefined here. */
	readonly issuer: LifecycleExecutionContext | RootExecutionContext;
	/** Open operational store (lazy `OperationalStore.open()` at the caller). */
	readonly store: LifecycleStore;
	/** Allocation-free route/profile proposal from `createSpawnPlan`. */
	readonly spawnPlan: SpawnPlan;
	/** Host-registered route key (see {@link LAUNCH_ENTRY_POINTS}). */
	readonly entryPoint: string;
	/** Human-readable admission reason recorded in contract provenance. */
	readonly reason: string;
	readonly agentName: string;
	readonly assignment: string;
	/** Resolved agent definition ΓÇö pinned as the contract's agentTemplateRef. */
	readonly agentDefinition: AgentDefinition;
	readonly executionProfile: AgentExecutionProfile;
	readonly toolProfile: ResolvedToolProfile;
	readonly collaborationPolicy: CollaborationPolicy;
	/** Eval/task context strategy; maps to the authority's contextMode. */
	readonly contextStrategy?: ContextStrategy;
	/** Absolute repository root for scope containment and context registration. */
	readonly repoRoot: string;
	/** Content-addressed baseline snapshot (see {@link captureLaunchBaseline}). */
	readonly baseline: SnapshotRefV1;
	/** Trusted host-owned evidence directory, scoped to the session's agent directory. */
	readonly evidenceDir?: string;
	/** Stable per-spawn admission key; replay returns the recorded allocation. */
	readonly idempotencyKey: string;
	/** Optional output-schema ref pinned into result authority. */
	readonly outputSchemaRef?: string | null;
	/** Abort checked before and after admission by the coordinator. */
	readonly signal?: AbortSignal;
}

export type BoundChildLaunchResult = LifecycleLaunchResult;

function fail(
	code: string,
	message: string,
	path?: string,
): { readonly ok: false; readonly code: string; readonly diagnostics: readonly LaunchContractDiagnostic[] } {
	return {
		ok: false,
		code,
		diagnostics: Object.freeze([path === undefined ? { code, message } : { code, message, path }]),
	};
}

/**
 * Persist canonical JSON evidence asynchronously and return its resolvable
 * `file://` URI. Content-addressed by digest: the same bytes always land at
 * the same path, so a published ref is never a dangling identifier.
 */
async function persistLaunchEvidence(dir: string, name: string, canonical: string): Promise<string> {
	const digest = sha256Hex(canonical);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, `${name}-${digest.slice(0, 16)}.json`);
	await Bun.write(filePath, canonical);
	return pathToFileURL(filePath).href;
}

/**
 * Content-addressed baseline for the launch capsule. A Git workspace gets a
 * real `captureBaseline` digest (head + staged + unstaged + untracked, nested
 * repos included, absolute host paths excluded); a positively detected
 * non-Git workspace records an honest empty manifest ΓÇö never a symbolic
 * `HEAD` and never a fabricated snapshot. A real capture failure (missing
 * binary, permission, I/O) propagates rather than masquerading as an empty
 * workspace. The canonical manifest is persisted before the ref returns.
 */
export async function captureLaunchBaseline(cwd: string, evidenceDir?: string): Promise<SnapshotRefV1> {
	const dir = evidenceDir ?? path.join(getAgentDir(), "launch-evidence");
	const repoRoot = await git.repo.root(cwd);
	if (!repoRoot) {
		const canonical = canonicalJson({ schemaVersion: 1, entries: [] });
		return Object.freeze({
			schemaVersion: 1 as const,
			manifestHash: sha256Hex(canonical),
			manifestUri: await persistLaunchEvidence(dir, "baseline", canonical),
		});
	}
	const baseline = await captureBaseline(cwd);
	const normalized = {
		schemaVersion: 1 as const,
		root: {
			headCommit: baseline.root.headCommit,
			staged: baseline.root.staged,
			unstaged: baseline.root.unstaged,
			untracked: baseline.root.untracked,
			untrackedPatch: baseline.root.untrackedPatch,
		},
		nested: baseline.nested.map(entry => ({
			relativePath: entry.relativePath,
			headCommit: entry.baseline.headCommit,
			staged: entry.baseline.staged,
			unstaged: entry.baseline.unstaged,
			untracked: entry.baseline.untracked,
			untrackedPatch: entry.baseline.untrackedPatch,
		})),
	};
	const canonical = canonicalJson(normalized);
	return Object.freeze({
		schemaVersion: 1 as const,
		manifestHash: sha256Hex(canonical),
		manifestUri: await persistLaunchEvidence(dir, "baseline", canonical),
	});
}

/** Ambient backend declarations. Activation separately verifies the actual child-owned eval namespace. */
function ambientGuarantees(): RuntimeGuaranteesV1 {
	return Object.freeze({
		initialContext: "legacy-inherited" as const,
		transcriptAccess: "ambient" as const,
		serviceAccess: "ambient" as const,
		artifactAccess: "ambient" as const,
		memoryAccess: "ambient" as const,
		evalState: "child-owned" as const,
		filesystemRead: "ambient" as const,
		filesystemWrite: "ambient" as const,
		process: "ambient" as const,
		network: "ambient" as const,
		credentials: "ambient" as const,
	});
}

/**
 * Foreground Task admits this child shape: a legacy-compatible leaf
 * worker. Naming it once keeps the issuer's `allowedLaunchClasses` check and
 * the requested authority from drifting apart.
 */
const CHILD_LAUNCH_CLASS = "legacy-compatible-worker" as const;

/** Envelope view of a persisted contract's authority (the issuer's delegable ceiling). */
function contractAuthorityEnvelope(contract: CompiledLaunchContract): AuthorityEnvelopeV1 {
	const authority = contract.authority;
	return Object.freeze({
		schemaVersion: 1 as const,
		usableCapabilities: authority.usableCapabilities,
		delegableCapabilities: authority.delegableCapabilities,
		resources: authority.resources,
		collaboration: authority.collaboration,
		spawn: authority.spawn,
		budget: authority.budget,
		result: authority.result,
	});
}

/** Root principals whose orphaned children this process already released, per store. */
const releasedOrphanPrincipals = new WeakMap<LifecycleStore, Set<string>>();

/** Admit authority, persist evidence, and return a pending launch for later runtime activation. */
export async function admitBoundChildLaunch(request: BoundChildLaunchRequest): Promise<BoundChildLaunchResult> {
	const registration = getLifecycleRegistration(request.issuer);
	if (!registration) {
		return fail(
			"missing_lifecycle_binding",
			"issuer lifecycle context is not registered; refusing unauthenticated admission.",
			"issuer",
		);
	}
	const evidenceDir = request.evidenceDir ?? path.join(getAgentDir(), "launch-evidence");

	// --- Issuer identity + parent ceiling, sourced from durable records ----
	let issuerPrincipalId: string;
	let rootPrincipalId: string;
	let issuerPolicyEpoch: number;
	let parentDelegable: AuthorityEnvelopeV1;
	let sourceGrants: readonly GrantRecordV1[];
	if (registration.root) {
		issuerPrincipalId = registration.root.rootPrincipalId;
		rootPrincipalId = registration.root.rootPrincipalId;
		issuerPolicyEpoch = registration.root.issuerPolicyEpoch;
		parentDelegable = registration.root.authorityEnvelope;
		sourceGrants = Object.freeze([]);
	} else if (registration.authority) {
		let issuerBinding: LaunchBinding;
		let issuerContract: CompiledLaunchContract;
		try {
			issuerBinding = request.store.getLaunchBinding(registration.authority.bindingId);
			issuerContract = request.store.getLaunchContract(issuerBinding.contractDigest);
		} catch {
			return fail(
				"missing_lifecycle_binding",
				"issuer binding is not persisted; refusing to fabricate a parent snapshot.",
				"issuer",
			);
		}
		// A revoked/superseded/terminal issuer ΓÇö or one whose durable epoch
		// moved past the registration's pin ΓÇö cannot admit children, even
		// while its in-process registration survives.
		if (issuerBinding.state !== "bound" && issuerBinding.state !== "active") {
			return fail(
				"launch_authority_revoked",
				`issuer binding '${issuerBinding.bindingId}' is '${issuerBinding.state}', not live`,
				"issuer",
			);
		}
		if (issuerBinding.policyEpoch !== registration.authority.policyEpoch) {
			return fail(
				"stale_launch_authority",
				`issuer binding is at epoch ${issuerBinding.policyEpoch}, registration pinned ${registration.authority.policyEpoch}`,
				"issuer",
			);
		}
		issuerPrincipalId = issuerBinding.childPrincipalId;
		rootPrincipalId = issuerBinding.rootPrincipalId;
		issuerPolicyEpoch = issuerBinding.policyEpoch;
		parentDelegable = contractAuthorityEnvelope(issuerContract);
		if (issuerBinding.grantBindings.length > 0) {
			return fail("unsupported_grant_projection", "This launch adapter cannot delegate persisted resource grants.");
		}
		sourceGrants = Object.freeze([]);
	} else {
		return fail(
			"missing_lifecycle_binding",
			"issuer context carries no durable identity (neither root nor bound); refusing to fabricate a parent snapshot.",
			"issuer",
		);
	}

	// --- Issuer spawn rights (unconditional, before any compilation) ------
	// The child is deliberately a leaf, so the compiler's spawn guards ΓÇö
	// gated on the CHILD's maySpawn ΓÇö can never fire. The issuer's own
	// rights are the only enforcement left and must be checked here.
	if (!parentDelegable.spawn.maySpawn) {
		return fail("spawn_not_permitted", "issuer authority does not permit spawning children.", "issuer.spawn");
	}
	if (parentDelegable.spawn.maxDepth <= 0) {
		return fail(
			"spawn_depth_exceeded",
			"issuer spawn depth is exhausted; no further delegation is permitted.",
			"issuer.spawn",
		);
	}
	// The issuer's allow-lists bound WHAT it may launch. An empty list grants
	// nothing: delegation is explicit, never implied by omission. `*` is the
	// host's explicit "any agent type" marker (see installRootIssuerContext).
	const allowedAgentTypes = parentDelegable.spawn.allowedAgentTypes;
	if (!allowedAgentTypes.includes("*") && !allowedAgentTypes.includes(request.agentName)) {
		return fail(
			"spawn_agent_type_not_permitted",
			`issuer authority does not permit launching agent type '${request.agentName}'.`,
			"issuer.spawn.allowedAgentTypes",
		);
	}
	if (!parentDelegable.spawn.allowedLaunchClasses.includes(CHILD_LAUNCH_CLASS)) {
		return fail(
			"spawn_launch_class_not_permitted",
			`issuer authority does not permit launch class '${CHILD_LAUNCH_CLASS}'.`,
			"issuer.spawn.allowedLaunchClasses",
		);
	}
	// The authenticated store transaction handles replay before checking live capacity.

	// --- Host-derived contract + principal identities (┬º14.2) --------------
	const contractId = sha256Hex(`contract:${rootPrincipalId}:${issuerPrincipalId}:${request.idempotencyKey}`);
	const contractRevision = 1;
	const childPrincipalId = sha256Hex(`principal:${contractId}:${contractRevision}`);
	const measured = ambientGuarantees();
	const agentTemplateCanonical = canonicalJson({
		schemaVersion: 1,
		name: request.agentDefinition.name,
		systemPrompt: request.agentDefinition.systemPrompt,
		tools: request.agentDefinition.tools ?? null,
		spawns: request.agentDefinition.spawns ?? null,
		model: request.agentDefinition.model ?? null,
	});
	const harnessCanonical = canonicalJson({
		schemaVersion: 1,
		agentTemplateDigest: sha256Hex(agentTemplateCanonical),
		executionProfile: request.executionProfile,
		toolProfile: request.toolProfile,
		collaborationPolicy: request.collaborationPolicy,
		outputSchemaRef: request.outputSchemaRef ?? null,
	});
	const harnessRef = await persistLaunchEvidence(evidenceDir, "harness", harnessCanonical);
	const environmentCanonical = canonicalJson({
		schemaVersion: 1,
		runtime: { platform: process.platform, architecture: process.arch, bunVersion: Bun.version },
		workspace: {
			baselineManifestHash: request.baseline.manifestHash,
			isolationLevel: "cooperative-worktree",
		},
		backendDeclarations: measured,
	});
	const environmentRef = await persistLaunchEvidence(evidenceDir, "environment", environmentCanonical);

	// --- Child policy: the resolved spawn ceilings, honestly recorded ------
	const limits = Object.freeze({
		schemaVersion: 1 as const,
		maxNodes: 1,
		maxDepth: 0,
		maxAttemptsPerNode: 4,
		maxOutstanding: 1,
		maxActiveCompute: 1,
		maxRequests: request.executionProfile.maxRequests > 0 ? request.executionProfile.maxRequests : 64,
		maxRuntimeMs: request.executionProfile.maxRuntimeMs > 0 ? request.executionProfile.maxRuntimeMs : 300_000,
		maxComputeRuntimeMs: request.executionProfile.maxRuntimeMs > 0 ? request.executionProfile.maxRuntimeMs : 300_000,
		maxTokens: null,
		maxCostMicrounits: null,
		currency: null,
		maxHandoffBytes: 1_048_576,
		maxInboxEvents: 0,
	});
	const policy: RuntimePolicySnapshotV1 = Object.freeze({
		schemaVersion: 1 as const,
		role: "worker" as const,
		topology:
			registration.mode === "hierarchical-v1"
				? ("hierarchical" as const)
				: registration.mode === "direct-v1"
					? ("direct" as const)
					: ("legacy" as const),
		executionProfile: request.executionProfile,
		toolProfile: request.toolProfile,
		collaborationPolicy: request.collaborationPolicy,
		mutation: Object.freeze({
			schemaVersion: 1 as const,
			apply: true,
			allowCommit: false,
			allowPush: false,
			allowMerge: false,
			approvalRef: null,
		}),
		limits,
		baseline: request.baseline,
		grantRefs: Object.freeze([]),
		harnessRef,
		projectionVersion: 1 as const,
		environmentRef,
		isolationLevel: "cooperative-worktree" as const,
	});

	const capsule: MissionCapsule = Object.freeze({
		schemaVersion: 1 as const,
		objective: request.assignment,
		nonGoals: Object.freeze([]),
		baselineRef: request.baseline,
		inputs: Object.freeze([]),
		// The worker's own working directory, resolved against the child's cwd at
		// activation. Path tools are contained to it; with no scope at all every
		// read/edit/grep/glob would be denied while exec-tier tools still ran.
		readableScope: Object.freeze(["."]),
		writableScope: Object.freeze(["."]),
		acceptance: Object.freeze([
			Object.freeze({
				id: "criterion-assignment-complete",
				description: `Assignment completed: ${request.assignment}`,
			}),
		]),
		capabilitySummary: Object.freeze(request.toolProfile.maximum.map(capability => capability.name)),
		localBudget: Object.freeze({
			maxRequests: limits.maxRequests,
			maxRuntimeMs: limits.maxRuntimeMs,
			maxTokens: null,
		}),
	});

	// --- Requested authority: legacy-compatible worker, ambient guarantees --
	const templateCanonical = agentTemplateCanonical;
	const templateBytes = Buffer.byteLength(templateCanonical, "utf8");
	const templateSha = sha256Hex(templateCanonical);
	const agentTemplateRef: ArtifactRefV1 = Object.freeze({
		schemaVersion: 1 as const,
		artifactId: `agent-template-${templateSha.slice(0, 16)}`,
		uri: await persistLaunchEvidence(evidenceDir, "agent-template", templateCanonical),
		sha256: templateSha,
		bytes: templateBytes,
		mediaType: "application/json",
		provenanceId: request.agentDefinition.source,
	});
	const baseContextBody = { schemaVersion: 1 as const, segments: Object.freeze([]) };
	const usable = parentDelegable.delegableCapabilities.filter(
		capability =>
			// Match current main's canonical control exception without granting same-name external implementations.
			((capability.source === "builtin" || capability.source === "hidden") &&
				CONTROL_BUILTIN_NAMES.has(capability.name)) ||
			isToolCapabilityAllowed(request.toolProfile, capability),
	);
	const requestedAuthority = Object.freeze({
		schemaVersion: 1 as const,
		launchClass: CHILD_LAUNCH_CLASS,
		contextMode: Object.freeze({
			kind: "fresh" as const,
			strategy: request.contextStrategy ?? ("shared" as const),
			independence: "none" as const,
		}),
		baseContextManifest: Object.freeze({
			...baseContextBody,
			manifestHash: sha256Hex(canonicalJson(baseContextBody)),
		}),
		workspaceInstructionRefs: Object.freeze([]),
		agentTemplateRef,
		initialDisclosures: Object.freeze([]),
		deliveryChannels: Object.freeze([]),
		usableCapabilities: usable,
		delegableCapabilities: Object.freeze([]),
		resources: Object.freeze([]),
		collaboration: Object.freeze({
			policy: request.collaborationPolicy,
			visiblePrincipalIds: Object.freeze([issuerPrincipalId]),
			sendPrincipalIds: Object.freeze([issuerPrincipalId]),
			receivePrincipalIds: Object.freeze([issuerPrincipalId]),
			wakePrincipalIds: Object.freeze([]),
			broadcastPrincipalIds: Object.freeze([]),
			busyReplyPrincipalIds: Object.freeze([]),
			controlPrincipalIds: Object.freeze([]),
			delegablePrincipalIds: Object.freeze([]),
			channelIds: Object.freeze([]),
		}),
		observation: Object.freeze({
			observers: Object.freeze([
				Object.freeze({
					principalId: issuerPrincipalId,
					rights: Object.freeze(["status", "progress", "result", "artifacts"] as const),
				}),
			]),
		}),
		// A leaf worker: no spawn rights ΓÇö recursion stays bounded by role AND
		// by authority (spawn.maxDepth 0 < issuer ceiling, maySpawn false).
		spawn: Object.freeze({
			maySpawn: false,
			mayDelegateSpawn: false,
			allowedAgentTypes: Object.freeze([]),
			allowedLaunchClasses: Object.freeze([]),
			maxDepth: 0,
			maxChildren: 0,
			delegableResourceGrantIds: Object.freeze([]),
		}),
		budget: Object.freeze({
			kind: "finite" as const,
			limits,
			reservation: Object.freeze({
				requests: 1,
				runtimeMs: limits.maxRuntimeMs,
				tokens: null,
				costMicrounits: null,
			}),
		}),
		result: Object.freeze({
			outputSchemaRef: request.outputSchemaRef ?? null,
			maxOutputBytes: 1_048_576,
			requiredCriterionIds: Object.freeze([]),
			publicationRequired: false,
			mutation: policy.mutation,
			publicationGrantIds: Object.freeze([]),
			acceptedRecipientPrincipalIds: Object.freeze([issuerPrincipalId]),
		}),
		requiredRuntimeGuarantees: measured,
		compatibility: Object.freeze([
			Object.freeze({
				classification: "legacy-compatibility" as const,
				code: "ambient-runtime-access",
				resourceKind: "workspace",
				requiredGuarantee: null,
				actualGuarantee: "ambient",
				reason:
					"Spawn adapters are not yet mediated; ambient filesystem/process/network/credential access is recorded as a legacy-compatibility exception rather than a strict grant.",
				authorityRef: null,
			}),
		]),
	});
	// Ceilings: the host can grant at most what the issuer itself may delegate;
	// agent/workflow maxima are the caller-resolved profile surfaces (the same
	// values that feed the SpawnPlan).
	const ceilingEnvelope = (capabilities: readonly ToolCapability[]): AuthorityEnvelopeV1 =>
		Object.freeze({
			schemaVersion: 1 as const,
			usableCapabilities: capabilities,
			delegableCapabilities: capabilities,
			resources: Object.freeze([]),
			collaboration: parentDelegable.collaboration,
			spawn: parentDelegable.spawn,
			budget: parentDelegable.budget,
			result: parentDelegable.result,
		});

	const authorization = Object.freeze({
		schemaVersion: 1 as const,
		authorizationRef: `authorization-${contractId}`,
		issuerPrincipalId,
		rootPrincipalId,
		parentPrincipalId: issuerPrincipalId,
		childPrincipalId,
		contractId,
		contractRevision,
		priorContractDigest: null,
		issuerPolicyEpoch,
		entryPoint: request.entryPoint,
		reason: request.reason,
		requestedAuthority,
		sourceGrants,
		parentDelegable,
		hostMaximum: parentDelegable,
		agentMaximum: ceilingEnvelope(usable),
		workflowMaximum: ceilingEnvelope(usable),
		toolCatalogDigest: sha256Hex(canonicalJson(usable)),
	});

	// Persist concrete host observations alongside the conservative guarantee
	// classification. No credential values or host paths enter the record.
	const workspace = await fs.stat(request.repoRoot);
	if (!workspace.isDirectory()) return fail("invalid_launch_workspace", "Launch workspace must be a directory.");
	const backendCanonical = canonicalJson({
		schemaVersion: 1,
		observations: {
			workspaceDirectory: true,
			runtimeVersion: Bun.version,
			platform: process.platform,
			architecture: process.arch,
			isolationBoundary: "cooperative-worktree",
		},
		backendDeclarations: measured,
	});
	const guaranteeEvidenceRefs: readonly ArtifactRefV1[] = Object.freeze([
		Object.freeze({
			schemaVersion: 1 as const,
			artifactId: `backend-${contractId.slice(0, 16)}`,
			uri: await persistLaunchEvidence(evidenceDir, "runtime-backend", backendCanonical),
			sha256: sha256Hex(backendCanonical),
			bytes: Buffer.byteLength(backendCanonical, "utf8"),
			mediaType: "application/json",
			provenanceId: "host-runtime-backend-declaration",
		}),
	]);

	// Before this process's first admission under a root principal, release
	// any children a previous process left live for it (see
	// releaseOrphanedChildBindings). Synchronous from the check to the release,
	// so concurrent admissions in this process never release each other's.
	if (registration.root) {
		const released = releasedOrphanPrincipals.get(request.store) ?? new Set<string>();
		releasedOrphanPrincipals.set(request.store, released);
		if (!released.has(registration.root.rootPrincipalId)) {
			const result = request.store.releaseOrphanedChildBindings({
				guard: {
					actor: request.issuer,
					expectedPolicyEpoch: registration.policyEpoch,
					idempotencyKey: `release-orphans-${registration.root.rootPrincipalId}`,
				},
				reason: "Released at first admission: left live by a process that exited without settling it.",
			});
			if (!result.ok) return { ok: false, code: result.code, diagnostics: result.diagnostics };
			released.add(registration.root.rootPrincipalId);
		}
	}

	return prepareLifecycleLaunch(
		request.store,
		{
			compileInput: {
				capsule,
				policy,
				authorization,
				requiredInputIds: [],
			},
			// The coordinator authenticates via getLifecycleRegistration, which
			// accepts root-branded and bound registrations alike.
			owner: request.issuer,
			idempotencyKey: request.idempotencyKey,
			reservation: Object.freeze({
				requests: 1,
				runtimeMs: limits.maxRuntimeMs,
				tokens: null,
				costMicrounits: null,
			}),
			actualRuntimeGuarantees: measured,
			guaranteeEvidenceRefs,
		},
		request.signal,
	);
}

/**
 * Lazily opened authority store per host agent directory. Live dispatch validators
 * retain this handle for the process lifetime; the disabled unbound path never opens it.
 */
const sharedAdmissionStores = new Map<string, Promise<LifecycleStore>>();
export async function admissionStore(agentDir = getAgentDir()): Promise<LifecycleStore> {
	let opening = sharedAdmissionStores.get(agentDir);
	if (!opening) {
		opening = LifecycleStore.open({ dbPath: path.join(agentDir, "lifecycle-authority.db") });
		sharedAdmissionStores.set(agentDir, opening);
		opening.catch(() => sharedAdmissionStores.delete(agentDir));
	}
	return opening;
}

/** Shared pre-allocation adapter. The disabled unbound path performs no store or evidence I/O. */
export async function prepareSessionChildLaunch(request: {
	readonly settings: Settings;
	readonly issuer: LifecycleExecutionContext | RootExecutionContext | undefined;
	readonly agentDir?: string;
	readonly cwd: string;
	readonly agentDefinition: AgentDefinition;
	readonly assignment: string;
	readonly idempotencyKey: string;
	readonly entryPoint: string;
	readonly spawnPlan?: SpawnPlan;
	readonly executionProfile?: AgentExecutionProfile;
	readonly toolProfile?: ResolvedToolProfile;
	readonly collaborationPolicy?: CollaborationPolicy;
	readonly contextStrategy?: ContextStrategy;
	readonly signal?: AbortSignal;
}): Promise<PendingLifecycleLaunch | undefined> {
	if (!request.settings.get("task.lifecycle.enabled") && !request.issuer) return undefined;
	if (!request.issuer) throw new Error("missing_lifecycle_binding: launch requires a registered issuer");
	const executionProfile = request.executionProfile ?? request.spawnPlan?.profile ?? resolveAgentExecutionProfile();
	const planning = request.spawnPlan
		? { ok: true as const, plan: request.spawnPlan }
		: createSpawnPlan({
				correlationId: request.idempotencyKey,
				agentName: request.agentDefinition.name,
				assignment: request.assignment,
				profile: executionProfile,
			});
	if (!planning.ok) throw new Error(planning.diagnostics.map(item => `${item.code}: ${item.message}`).join("; "));
	const agentDir = request.agentDir ?? getAgentDir();
	const evidenceDir = path.join(agentDir, "launch-evidence");
	const result = await admitBoundChildLaunch({
		issuer: request.issuer,
		store: await admissionStore(agentDir),
		spawnPlan: planning.plan,
		entryPoint: request.entryPoint,
		reason: "Host pre-allocation spawn admission",
		agentName: request.agentDefinition.name,
		assignment: request.assignment,
		agentDefinition: request.agentDefinition,
		executionProfile,
		toolProfile:
			request.toolProfile ??
			resolveToolProfile({
				execution: executionProfile,
				agentTools: request.agentDefinition.tools,
				requireYield: true,
			}),
		collaborationPolicy:
			request.collaborationPolicy ?? resolveCollaborationPolicy({ mode: executionProfile.collaboration }),
		contextStrategy: request.contextStrategy,
		repoRoot: request.cwd,
		baseline: await captureLaunchBaseline(request.cwd, evidenceDir),
		evidenceDir,
		idempotencyKey: request.idempotencyKey,
		signal: request.signal,
	});
	if (!result.ok) throw new Error(`${result.code}: ${result.diagnostics.map(item => item.message).join("; ")}`);
	return result.pending;
}
