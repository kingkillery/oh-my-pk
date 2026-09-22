/**
 * Bound-child launch admission for spawn callers (W3 §14.6, oracle Q4/Q5).
 *
 * One shared builder so TaskTool, eval `agent()`, `/subagent` and the Fusion
 * sidekick admit children through the SAME durable path:
 *
 *   issuer registration → LaunchAuthorizationSnapshotV1 (sourced from durable
 *   records, never caller JSON) → prepareLifecycleLaunch (compile → admit →
 *   activate authorized→bound) → activateBoundSessionAuthority (bound context
 *   + projection binding) → ExecutorOptions.lifecycle.
 *
 * Issuer identity rules:
 * - Root issuer (`registration.root`): parentDelegable is the root's
 *   authority envelope; there are no source grants; the root principal is
 *   lazily persisted inside admitLaunchAuthority's transaction.
 * - Bound-child issuer (`registration.authority`): parentDelegable is the
 *   envelope view of the issuer's own persisted contract authority;
 *   sourceGrants resolve through the issuer binding's grantBindings.
 * - A registered context carrying NEITHER (in-memory derivation) cannot
 *   issue a durable admission: it fails closed `missing_lifecycle_binding`
 *   rather than fabricating a parent snapshot.
 *
 * `contractId`/`childPrincipalId` follow the §14.2 host-preflight derivation:
 * `contract:`/`principal:` domain-prefixed canonical SHA-256 over
 * (rootPrincipalId, parentPrincipalId, idempotencyKey) — the same request
 * reproduces the same identities; a conflicting request under the same key
 * rejects at admission.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils";
import { OperationalStore } from "../operational/store";
import type { AgentExecutionProfile } from "../orchestration/agent-execution-profile";
import type { CollaborationPolicy } from "../orchestration/collaboration-policy";
import { activateBoundSessionAuthority } from "../orchestration/context-projector";
import type { SessionArtifactReader } from "../orchestration/context-record-loader";
import {
	getLifecycleRegistration,
	type LifecycleExecutionContext,
	type RootExecutionContext,
} from "../orchestration/lifecycle-authority";
import type { ToolSource } from "../tools";
import type { ResolvedToolProfile, ToolCapability } from "../tools/tool-profiles";
import * as git from "../utils/git";
import { prepareLifecycleLaunch } from "./launch-admission";
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
	type ToolCapabilitySource,
} from "./launch-contract";
import type { SpawnPlan } from "./spawn-plan";
import type { AgentDefinition } from "./types";
import { captureBaseline } from "./worktree";

/** Host-registered §14.6 route keys for the four spawn entry points. */
export const LAUNCH_ENTRY_POINTS = Object.freeze({
	taskSpawn: "task.spawn",
	evalAgent: "eval.agent",
	slashSubagent: "slash.subagent",
	fusionSidekick: "fusion.sidekick",
} as const);

export interface BoundChildLaunchRequest {
	/** Issuer context from `session.getLifecycleIssuerContext?.()` — never undefined here. */
	readonly issuer: LifecycleExecutionContext | RootExecutionContext;
	/** Open operational store (lazy `OperationalStore.open()` at the caller). */
	readonly store: OperationalStore;
	/** Allocation-free route/profile proposal from `createSpawnPlan`. */
	readonly spawnPlan: SpawnPlan;
	/** Host-registered route key (see {@link LAUNCH_ENTRY_POINTS}). */
	readonly entryPoint: string;
	/** Human-readable admission reason recorded in contract provenance. */
	readonly reason: string;
	readonly agentName: string;
	readonly assignment: string;
	/** Resolved agent definition — pinned as the contract's agentTemplateRef. */
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
	/** Stable per-spawn admission key; replay returns the recorded allocation. */
	readonly idempotencyKey: string;
	/** Pre-allocated durable session identity recorded on the binding. */
	readonly sessionId: string;
	/** Artifact read surface for the child's projection resolver. */
	readonly artifactManager: SessionArtifactReader;
	/** Optional tool-source resolver; defaults to the contract capability map. */
	readonly toolSourceOf?: (name: string) => ToolCapabilitySource | undefined;
	/** Optional output-schema ref pinned into result authority. */
	readonly outputSchemaRef?: string | null;
	/** Abort checked before and after admission by the coordinator. */
	readonly signal?: AbortSignal;
}

export type BoundChildLaunchResult =
	| {
			readonly ok: true;
			readonly context: LifecycleExecutionContext;
			readonly binding: LaunchBinding;
			readonly contract: CompiledLaunchContract;
	  }
	| { readonly ok: false; readonly code: string; readonly diagnostics: readonly LaunchContractDiagnostic[] };

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
 * Persist canonical JSON evidence synchronously and return its resolvable
 * `file://` URI. Content-addressed by digest: the same bytes always land at
 * the same path, so a published ref is never a dangling identifier.
 */
function persistLaunchEvidence(dir: string, name: string, canonical: string): string {
	const digest = sha256Hex(canonical);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${name}-${digest.slice(0, 16)}.json`);
	fs.writeFileSync(filePath, canonical, "utf8");
	return `file://${filePath}`;
}

/**
 * Content-addressed baseline for the launch capsule. A Git workspace gets a
 * real `captureBaseline` digest (head + staged + unstaged + untracked, nested
 * repos included, absolute host paths excluded); a positively detected
 * non-Git workspace records an honest empty manifest — never a symbolic
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
			manifestUri: persistLaunchEvidence(dir, "baseline", canonical),
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
		manifestUri: persistLaunchEvidence(dir, "baseline", canonical),
	});
}

/**
 * Honest ambient measurement (§14.4 ambient-code rule): today's spawn
 * adapters are not mediated/contained, so the probe reports ambient access
 * with a child-owned eval kernel. The contract's required guarantees are
 * compiled to the same profile and the gap is recorded as a
 * `legacy-compatibility` exception — never advertised as containment nobody
 * probed for.
 */
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
 * Every spawn seam admits the same child shape: a legacy-compatible leaf
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

/**
 * Admit a delegated child under `request.issuer` and return its bound,
 * projection-ready context. Synchronous store work only; all async preflight
 * (baseline capture, harness resolution) belongs to the caller.
 */
export function admitBoundChildLaunch(request: BoundChildLaunchRequest): BoundChildLaunchResult {
	const registration = getLifecycleRegistration(request.issuer);
	if (!registration) {
		return fail(
			"missing_lifecycle_binding",
			"issuer lifecycle context is not registered; refusing unauthenticated admission.",
			"issuer",
		);
	}
	const evidenceDir = path.join(getAgentDir(), "launch-evidence");

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
		// A revoked/superseded/terminal issuer — or one whose durable epoch
		// moved past the registration's pin — cannot admit children, even
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
		sourceGrants = Object.freeze(
			issuerBinding.grantBindings.map(grant => request.store.getLaunchGrant(grant.grantId)),
		);
	} else {
		return fail(
			"missing_lifecycle_binding",
			"issuer context carries no durable identity (neither root nor bound); refusing to fabricate a parent snapshot.",
			"issuer",
		);
	}

	// --- Issuer spawn rights (unconditional, before any compilation) ------
	// The child is deliberately a leaf, so the compiler's spawn guards —
	// gated on the CHILD's maySpawn — can never fire. The issuer's own
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
	// Concurrency ceiling, read from the durable record rather than trusted
	// from the caller: a crashed parent's live children still count.
	const liveChildren = request.store.countLiveChildBindings(issuerPrincipalId);
	if (liveChildren >= parentDelegable.spawn.maxChildren) {
		return fail(
			"spawn_children_exhausted",
			`issuer already holds ${liveChildren} live children at a ceiling of ${parentDelegable.spawn.maxChildren}.`,
			"issuer.spawn.maxChildren",
		);
	}

	// --- Host-derived contract + principal identities (§14.2) --------------
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
	const harnessRef = persistLaunchEvidence(evidenceDir, "harness", harnessCanonical);
	const environmentCanonical = canonicalJson({
		schemaVersion: 1,
		runtime: { platform: process.platform, architecture: process.arch, bunVersion: Bun.version },
		workspace: {
			baselineManifestHash: request.baseline.manifestHash,
			isolationLevel: "cooperative-worktree",
		},
		measuredGuarantees: measured,
	});
	const environmentRef = persistLaunchEvidence(evidenceDir, "environment", environmentCanonical);

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
		maxInboxEvents: 256,
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
		readableScope: Object.freeze([]),
		writableScope: Object.freeze([]),
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
		uri: persistLaunchEvidence(evidenceDir, "agent-template", templateCanonical),
		sha256: templateSha,
		bytes: templateBytes,
		mediaType: "application/json",
		provenanceId: request.agentDefinition.source,
	});
	const baseContextBody = { schemaVersion: 1 as const, segments: Object.freeze([]) };
	const usable = request.toolProfile.maximum;
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
		// A leaf worker: no spawn rights — recursion stays bounded by role AND
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
	const probeCanonical = canonicalJson({
		schemaVersion: 1,
		observations: {
			workspaceExists: fs.existsSync(request.repoRoot),
			filesystemApiAvailable: typeof fs.readFileSync === "function",
			processApiAvailable: typeof Bun.spawn === "function",
			networkApiAvailable: typeof globalThis.fetch === "function",
			environmentApiAvailable: typeof process.env === "object",
			isolationBoundary: "cooperative-worktree",
		},
		guarantees: measured,
	});
	const guaranteeEvidenceRefs: readonly ArtifactRefV1[] = Object.freeze([
		Object.freeze({
			schemaVersion: 1 as const,
			artifactId: `probe-${contractId.slice(0, 16)}`,
			uri: persistLaunchEvidence(evidenceDir, "runtime-probe", probeCanonical),
			sha256: sha256Hex(probeCanonical),
			bytes: Buffer.byteLength(probeCanonical, "utf8"),
			mediaType: "application/json",
			provenanceId: "host-runtime-probe",
		}),
	]);

	const prepared = prepareLifecycleLaunch(
		request.store,
		{
			spawnPlan: request.spawnPlan,
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
			prerequisiteIds: Object.freeze([]),
			services: {
				confinedBackend: null,
				measuredGuarantees: measured,
				guaranteeEvidenceRefs,
				sessionId: request.sessionId,
			},
		},
		request.signal,
	);
	if (!prepared.ok) {
		return { ok: false, code: prepared.code, diagnostics: prepared.diagnostics };
	}

	// The schema-v2 wire already carries the persisted binding that admitted
	// this child and the compiled contract it was bound to, both verified
	// against each other at bind time. Re-resolving them from an overloaded
	// id would only reintroduce the ambiguity the v2 record removes.
	const binding = prepared.launch.binding;
	const contract = prepared.launch.compiled;
	const capabilitySource = new Map<string, ToolCapabilitySource>(
		contract.authority.usableCapabilities.map(capability => [capability.name, capability.source]),
	);
	const context = activateBoundSessionAuthority({
		store: request.store,
		binding,
		contract,
		repoRoot: request.repoRoot,
		artifactManager: request.artifactManager,
		toolSourceOf:
			request.toolSourceOf ??
			(name => capabilitySource.get(name) ?? (capabilitySource.get(name.toLowerCase()) as ToolSource | undefined)),
	});
	return { ok: true, context, binding, contract };
}

/**
 * Process-lifetime operational store for bound-child admissions. The
 * projection binding attached to each admitted child context reads launch
 * rows through this handle for the child's whole life, so it is opened once
 * lazily and never closed (same lifetime as the process). Tests redirect it
 * via `setAgentDir` before the first spawn.
 */
let sharedAdmissionStore: OperationalStore | undefined;
export function admissionStore(): OperationalStore {
	sharedAdmissionStore ??= OperationalStore.open();
	return sharedAdmissionStore;
}
