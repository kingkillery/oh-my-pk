/**
 * Lifecycle context projector (A04/W3) — projects an authorized provider
 * `Context` for one bound child request.
 *
 * Given a registered `LifecycleExecutionContext`, the persisted launch
 * binding + contract, ordered fragment descriptors and candidate tool
 * schemas, the projector:
 *
 * 1. Resolves every fragment through the authorized record loader
 *    (`context-record-loader.ts`) — admitted inbox deliveries, contract-
 *    pinned refs, live grants, or same-lifecycle local trajectory. Missing,
 *    unadmitted, revoked or out-of-scope records FAIL CLOSED.
 * 2. Applies class/provenance rules: `held-out` never enters context;
 *    `institutional` requires a non-strict launch class; `local-trajectory`
 *    must be same-lifecycle or delivery/grant-backed; `owner-handoff` must
 *    come from the owner scope or an authenticated delivery; a fragment
 *    whose provenance parent was rejected is rejected in turn.
 * 3. Intersects candidate tool schemas with the contract's
 *    `usableCapabilities` ∩ harness `maxTools`, keeping each tool's real
 *    `parameters` schema. Omitted tools are recorded in the manifest.
 * 4. Emits a `ProjectionManifest` with real hashes, per-fragment provenance
 *    and explicit rejection codes — never excluded content.
 *
 * With no binding/context supplied the projector returns an explicit
 * `legacy-passthrough` result carrying the caller's context unchanged; it
 * never fabricates authority.
 */

import type { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Context, Message, Tool } from "@pk-nerdsaver-ai/pi-ai";
import { toolWireSchema } from "@pk-nerdsaver-ai/pi-ai/utils/schema";
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import type { OperationalStore } from "../operational/store";
import {
	type CompiledLaunchContract,
	canonicalJson,
	isHex64,
	isNonEmptyString,
	isPlainObject,
	isSafeNonNegativeInt,
	type LaunchBinding,
	sha256Hex,
	TOOL_CAPABILITY_SOURCES,
	type ToolCapabilitySource,
} from "../task/launch-contract";
import {
	createSessionRecordResolver,
	createStoreRecordSource,
	type LaunchRecordSource,
	loadAuthorizedRecord,
	type RecordContentResolver,
	type SessionArtifactReader,
} from "./context-record-loader";
import type { HarnessManifestV1 } from "./harness-manifest";
import {
	getLifecycleRegistration,
	type LifecycleExecutionContext,
	registerLiveBindingValidator,
	resolveCanonicalToolName,
	resolvePersistedLifecycleContext,
} from "./lifecycle-authority";

export type ContextClass =
	| "mission"
	| "project-invariant"
	| "granted-evidence"
	| "local-trajectory"
	| "owner-handoff"
	| "operational"
	| "institutional"
	| "held-out";

export type ProjectionPhase =
	| "launch"
	| "continue"
	| "tool-result"
	| "compact"
	| "recall"
	| "retry"
	| "resume"
	| "fork"
	| "queued"
	| "fallback"
	| "side-request";

/**
 * Immutable descriptor for one candidate context fragment. Content is NEVER
 * carried inline: `contentRef` names the authorized record the loader must
 * resolve, and `sourceHash` pins the expected content digest.
 */
export interface ContextFragment {
	readonly id: string;
	readonly contextClass: ContextClass;
	readonly sourceRef: string;
	readonly sourceHash: string;
	readonly ownerScope: string;
	readonly contentRef: string;
	readonly required: boolean;
	readonly parentProvenanceIds: readonly string[];
}

export interface ProjectedToolRef {
	readonly source: ToolCapabilitySource;
	readonly name: string;
	readonly schemaHash: string;
}

export interface ProjectionManifest {
	readonly schemaVersion: 1;
	readonly manifestHash: string;
	readonly launchHash: string;
	readonly policyHash: string;
	readonly harnessHash: string;
	readonly grantGeneration: number;
	readonly phase: ProjectionPhase;
	readonly admitted: readonly { readonly fragmentId: string; readonly sourceHash: string }[];
	readonly rejected: readonly { readonly fragmentId: string; readonly code: string }[];
	readonly tools: readonly ProjectedToolRef[];
}

/** A candidate tool schema the caller wants visible in this request. */
export interface ProjectedToolCandidate {
	readonly source: ToolCapabilitySource;
	readonly tool: Tool;
}

export interface ContextProjectionInput {
	/** Registered execution context; null selects the explicit legacy path. */
	readonly lifecycle: LifecycleExecutionContext | null;
	/** Persisted binding id this request runs under. */
	readonly bindingId: string | null;
	/** Store read surface; required whenever `bindingId` is set. */
	readonly recordSource?: LaunchRecordSource;
	/** Resolves admitted refs to content; required whenever `bindingId` is set. */
	readonly resolveContent?: RecordContentResolver;
	/** Pinned harness; its `maxTools` is an additional ceiling. */
	readonly harness?: HarnessManifestV1;
	readonly grantGeneration: number;
	readonly phase: ProjectionPhase;
	readonly fragments: readonly ContextFragment[];
	readonly tools: readonly ProjectedToolCandidate[];
	/** Caller context passed through verbatim on the legacy path. */
	readonly existingContext?: Context;
}
/**
 * Host-private projection binding (§5.1–5.2). The frozen side-request
 * signature carries only the opaque lifecycle handle, so the store read
 * surface, content resolver, pinned harness and tool-source resolver the
 * projection authorizes against live in a WeakMap keyed by that handle —
 * the same registration pattern `lifecycle-authority.ts` uses for the
 * authority record. A serialized or structurally identical object can
 * never carry a binding; a revoked context loses both registrations.
 */
export interface LifecycleProjectionBinding {
	/** Persisted binding id this principal's requests run under. */
	readonly bindingId: string;
	/** Store read surface the record loader authorizes against. */
	readonly recordSource: LaunchRecordSource;
	/** Resolves admitted refs (delivery/grant/contract payloads) to content. */
	readonly resolveContent: RecordContentResolver;
	/** Pinned harness; its `maxTools` is an additional tool ceiling. */
	readonly harness?: HarnessManifestV1;
	/** Grant/policy generation stamped into every emitted manifest. */
	readonly grantGeneration: number;
	/**
	 * Source-qualifies a candidate tool for the contract intersection.
	 * REQUIRED whenever the projected context may carry tools: without it a
	 * tool's source cannot be proven and the request fails closed.
	 */
	readonly toolSourceOf?: (name: string) => ToolCapabilitySource | undefined;
	/**
	 * Host-issued descriptor minting (§5.1). The projector NEVER mints
	 * provenance for caller-supplied strings itself: each system block and
	 * message must be issued as a descriptor naming a host-persisted record
	 * (session artifact or store record) the registered resolver can read.
	 * Absent issuer → the request fails closed `untrusted_context`; an issuer
	 * that cannot place the content returns null → `missing_required_input`.
	 */
	readonly issueFragment?: (fragment: {
		readonly id: string;
		readonly content: string;
	}) => { readonly contentRef: string; readonly sourceHash: string } | null;
}

const PROJECTION_BINDINGS = new WeakMap<LifecycleExecutionContext, LifecycleProjectionBinding>();

/**
 * Host-only: attach the projection authority for a registered lifecycle
 * context. Called by the same host code that minted the context — never by
 * tools, extensions or model-facing paths. Re-binding replaces the record;
 * `unbindLifecycleProjection` (or context revocation) removes it.
 */
export function bindLifecycleProjection(
	lifecycle: LifecycleExecutionContext,
	binding: LifecycleProjectionBinding,
): void {
	PROJECTION_BINDINGS.set(lifecycle, binding);
}

/** Host-only: drop a projection binding so later requests fail closed. */
export function unbindLifecycleProjection(lifecycle: LifecycleExecutionContext): void {
	PROJECTION_BINDINGS.delete(lifecycle);
}

/** Host-only read-back: the projection binding for a lifecycle, if any. */
export function getLifecycleProjectionBinding(
	lifecycle: LifecycleExecutionContext,
): LifecycleProjectionBinding | undefined {
	return PROJECTION_BINDINGS.get(lifecycle);
}

/**
 * Manifest sidecar (§5.2): fragment ids/digests ride the control plane, not
 * the projected `Context` — excluded content never enters either. Keyed by
 * the exact `Context` object a projection returned so observational hooks
 * and audit code can recover the admission record without trusting caller
 * data. Only the manifest hash is logged; rejected content is never logged.
 */
const PROJECTION_MANIFESTS = new WeakMap<Context, ProjectionManifest>();

/** The manifest recorded for a projected context, or `undefined` for legacy/unprojected contexts. */
export function getProjectionManifest(context: Context): ProjectionManifest | undefined {
	return PROJECTION_MANIFESTS.get(context);
}

/** Purposes the frozen side-request signature admits. */
export type SideRequestPurpose = "compact" | "advisor" | "completion";

/**
 * Typed rejection for a side request that cannot be projected. `code`
 * mirrors `ContextProjectionResult`'s failure union; `fragmentIds` names
 * the offending fragments (never their content).
 */
export class LifecycleProjectionError extends Error {
	readonly code: "missing_required_input" | "untrusted_context";
	readonly fragmentIds: readonly string[];
	constructor(code: "missing_required_input" | "untrusted_context", fragmentIds: readonly string[]) {
		super(code);
		this.name = "LifecycleProjectionError";
		this.code = code;
		this.fragmentIds = fragmentIds;
	}
}

/** Canonical serialization of one provider message for digest pinning. */
function serializeMessageForProjection(message: Message): string {
	return canonicalJson(message);
}

/**
 * Project a caller-assembled provider `Context` through the bound
 * lifecycle's authority (§5.1–5.2, phase `side-request`).
 *
 * - `lifecycle === null` (or absent) is the explicit legacy path: the input
 *   context returns unchanged and no authority is fabricated.
 * - A registered lifecycle WITHOUT a projection binding fails closed
 *   (`untrusted_context`) — a bound principal never falls back to legacy.
 * - Every system block and message is verified as a required same-lifecycle
 *   `local-trajectory` fragment: the binding must be live, the registered
 *   context must name this binding's attempt at this epoch, and each
 *   fragment's content must digest-match its descriptor. Any rejection
 *   throws `missing_required_input` rather than emitting a filtered
 *   request — a required fragment can never be silently dropped.
 * - Tool-call/tool-result pairing is enforced before projection: a
 *   `toolResult` whose call is absent from the assembled history throws
 *   `missing_required_input` instead of producing malformed history.
 * - `context.tools` is intersected with the contract's usable capabilities
 *   ∩ harness ceiling; unauthorized tools are omitted (recorded in the
 *   manifest), never renamed or schema-stripped.
 *
 * The returned `Context` preserves the caller's message structure verbatim;
 * only `tools` is rewritten to the authorized subset. The admission record
 * is retrievable via {@link getProjectionManifest}.
 */
export async function projectLifecycleSideRequest(
	context: Context,
	purpose: SideRequestPurpose,
	lifecycle: LifecycleExecutionContext | null | undefined,
): Promise<Context> {
	if (lifecycle === null || lifecycle === undefined) return context;

	const binding = PROJECTION_BINDINGS.get(lifecycle);
	if (!binding) {
		throw new LifecycleProjectionError("untrusted_context", []);
	}

	// Pairing check happens before any fragment work: an orphan toolResult
	// means the caller's history is already malformed, and filtering could
	// never repair it.
	const callIds = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") callIds.add(block.id);
			}
		}
	}
	const orphanResults: string[] = [];
	for (const message of context.messages) {
		if (message.role === "toolResult" && !callIds.has(message.toolCallId)) {
			orphanResults.push(`msg:toolResult:${message.toolCallId}`);
		}
	}
	if (orphanResults.length > 0) {
		throw new LifecycleProjectionError("missing_required_input", Object.freeze(orphanResults));
	}

	// Resolve the binding's own scope up front so fragments can be marked
	// same-lifecycle; an unreadable binding/contract fails closed here.
	let ownScope: string;
	try {
		const persisted = binding.recordSource.getLaunchBinding(binding.bindingId);
		ownScope = scopeOf(persisted);
	} catch {
		throw new LifecycleProjectionError("untrusted_context", []);
	}

	// Host-issued descriptors only (§5.1): the projector never mints
	// provenance for caller strings. Every system block and message must be
	// issued by the binding's host issuer as a descriptor naming a persisted
	// host record; the issued sourceHash must pin the exact caller content.
	const issue = binding.issueFragment;
	const hasContent = (context.systemPrompt?.length ?? 0) > 0 || context.messages.length > 0;
	if (hasContent && !issue) {
		throw new LifecycleProjectionError("untrusted_context", []);
	}
	const fragments: ContextFragment[] = [];
	const issueOne = (id: string, content: string): ContextFragment => {
		const issued = issue!(Object.freeze({ id, content }));
		if (!issued) throw new LifecycleProjectionError("missing_required_input", Object.freeze([id]));
		if (issued.sourceHash !== sha256Hex(content)) {
			throw new LifecycleProjectionError("untrusted_context", Object.freeze([id]));
		}
		return Object.freeze({
			id,
			contextClass: "local-trajectory" as const,
			sourceRef: issued.contentRef,
			sourceHash: issued.sourceHash,
			ownerScope: ownScope,
			contentRef: issued.contentRef,
			required: true,
			parentProvenanceIds: Object.freeze([]),
		});
	};
	const systemBlocks = context.systemPrompt ?? [];
	for (let i = 0; i < systemBlocks.length; i++) {
		fragments.push(issueOne(`sys:${i}`, systemBlocks[i]!));
	}
	for (let i = 0; i < context.messages.length; i++) {
		const message = context.messages[i]!;
		fragments.push(issueOne(`msg:${i}:${message.role}`, serializeMessageForProjection(message)));
	}

	const tools: ProjectedToolCandidate[] = [];
	if (context.tools !== undefined) {
		if (!binding.toolSourceOf) {
			// Source cannot be proven for any candidate — fail closed rather
			// than guess a source qualifier.
			throw new LifecycleProjectionError("untrusted_context", []);
		}
		for (const tool of context.tools) {
			const source = binding.toolSourceOf(tool.name);
			if (source === undefined) {
				throw new LifecycleProjectionError("untrusted_context", Object.freeze([`tool:${tool.name}`]));
			}
			tools.push(Object.freeze({ source, tool }));
		}
	}

	const resolveContent: RecordContentResolver = ref => binding.resolveContent(ref);

	const result = await projectLifecycleContext({
		lifecycle,
		bindingId: binding.bindingId,
		recordSource: binding.recordSource,
		resolveContent,
		harness: binding.harness,
		grantGeneration: binding.grantGeneration,
		phase: "side-request",
		fragments,
		tools,
	});

	if (!result.ok) {
		throw new LifecycleProjectionError(result.code, result.fragmentIds);
	}
	if (result.kind !== "projected") {
		throw new LifecycleProjectionError("untrusted_context", []);
	}

	const projected: Context = {
		systemPrompt: context.systemPrompt,
		messages: context.messages,
		tools: context.tools === undefined ? undefined : result.context.tools,
	};
	PROJECTION_MANIFESTS.set(projected, result.manifest);
	logger.debug("lifecycle side-request projected", {
		purpose,
		manifestHash: result.manifest.manifestHash,
		admitted: result.manifest.admitted.length,
		rejected: result.manifest.rejected.length,
	});
	return projected;
}

export type ContextProjectionResult =
	| {
			readonly ok: true;
			readonly kind: "projected";
			readonly context: Context;
			readonly manifest: ProjectionManifest;
	  }
	| {
			readonly ok: true;
			readonly kind: "legacy-passthrough";
			readonly context: Context;
			readonly manifest: null;
	  }
	| {
			readonly ok: false;
			readonly code: "missing_required_input" | "untrusted_context";
			readonly fragmentIds: readonly string[];
	  };

export function computeProjectionManifestHash(manifest: Omit<ProjectionManifest, "manifestHash">): string {
	const body = {
		schemaVersion: manifest.schemaVersion,
		launchHash: manifest.launchHash,
		policyHash: manifest.policyHash,
		harnessHash: manifest.harnessHash,
		grantGeneration: manifest.grantGeneration,
		phase: manifest.phase,
		admitted: [...manifest.admitted].sort((a, b) => (a.fragmentId < b.fragmentId ? -1 : 1)),
		rejected: [...manifest.rejected].sort((a, b) => (a.fragmentId < b.fragmentId ? -1 : 1)),
		tools: [...manifest.tools].sort((a, b) =>
			a.source === b.source ? (a.name < b.name ? -1 : 1) : a.source < b.source ? -1 : 1,
		),
	};
	return sha256Hex(canonicalJson(body));
}

/** Classes that assemble into `Context.systemPrompt`. */
const SYSTEM_CLASSES: Record<string, true> = { "project-invariant": true, operational: true };

function messageRoleFor(contextClass: ContextClass): "user" | "developer" {
	switch (contextClass) {
		case "mission":
		case "granted-evidence":
		case "local-trajectory":
			return "user";
		default:
			return "developer";
	}
}

function scopeOf(binding: LaunchBinding): string {
	return binding.lifecycle ? `${binding.lifecycle.runId}/${binding.lifecycle.nodeId}` : binding.bindingId;
}

function ownerScopeOf(binding: LaunchBinding): string {
	return binding.lifecycle?.ownerNodeId ?? binding.parentPrincipalId;
}

/**
 * Project one bound request into a provider `Context`.
 *
 * Async because record resolution may touch artifact storage; the assembly
 * itself is deterministic given the resolved records.
 */
export async function projectLifecycleContext(input: ContextProjectionInput): Promise<ContextProjectionResult> {
	// Explicit legacy path: no binding, no fabricated authority — the caller
	// passes its existing context through unchanged.
	if (input.lifecycle === null || input.bindingId === null) {
		return {
			ok: true,
			kind: "legacy-passthrough",
			context: input.existingContext ?? { messages: [] },
			manifest: null,
		};
	}
	if (!input.recordSource || !input.resolveContent) {
		return { ok: false, code: "untrusted_context", fragmentIds: [] };
	}

	const registration = getLifecycleRegistration(input.lifecycle);
	if (!registration) {
		return { ok: false, code: "untrusted_context", fragmentIds: [] };
	}

	let binding: LaunchBinding;
	let contract: CompiledLaunchContract;
	try {
		binding = input.recordSource.getLaunchBinding(input.bindingId);
		contract = input.recordSource.getLaunchContract(binding.contractDigest);
	} catch {
		return { ok: false, code: "untrusted_context", fragmentIds: [] };
	}

	// The registered context must name THIS binding's attempt at THIS epoch;
	// a live registration for another attempt cannot ride in. Provider
	// projection is executable only after activation (`bound`/`active`): an
	// authorized, suspended, or terminal binding cannot issue a request.
	if (registration.attemptId !== binding.attemptId || registration.policyEpoch !== binding.policyEpoch) {
		return { ok: false, code: "untrusted_context", fragmentIds: [] };
	}
	if (binding.state !== "bound" && binding.state !== "active") {
		return { ok: false, code: "untrusted_context", fragmentIds: [] };
	}

	const ownScope = scopeOf(binding);
	const parentScope = ownerScopeOf(binding);
	const strictClass = contract.authority.launchClass === "strict-worker";

	const rejected: { fragmentId: string; code: string }[] = [];
	const admittedEntries: { fragmentId: string; sourceHash: string }[] = [];
	const missingRequired: string[] = [];
	const systemBlocks: string[] = [];
	const messages: Message[] = [];
	const rejectedIds = new Set<string>();
	const fragmentIds = new Set(input.fragments.map(f => f.id));

	const reject = (fragment: ContextFragment, code: string): void => {
		rejected.push({ fragmentId: fragment.id, code });
		rejectedIds.add(fragment.id);
		if (fragment.required) missingRequired.push(fragment.id);
	};

	for (const fragment of input.fragments) {
		// Provenance cascade: a fragment whose parent was rejected (or names
		// a parent outside this projection) cannot stand alone — this is what
		// preserves tool-call/tool-result pairing under filtering.
		const deniedParent = fragment.parentProvenanceIds.find(id => rejectedIds.has(id));
		if (deniedParent !== undefined) {
			reject(fragment, "provenance_parent_denied");
			continue;
		}
		const unknownParent = fragment.parentProvenanceIds.find(id => !fragmentIds.has(id));
		if (unknownParent !== undefined) {
			reject(fragment, "unknown_provenance");
			continue;
		}

		// Class rules that deny before any store read.
		if (fragment.contextClass === "held-out") {
			reject(fragment, "held_out_excluded");
			continue;
		}
		if (fragment.contextClass === "institutional" && strictClass) {
			reject(fragment, "class_not_authorized");
			continue;
		}
		const sameLifecycle = fragment.ownerScope === ownScope;
		if (fragment.contextClass === "local-trajectory" && !sameLifecycle && !refIsAuthorized(fragment.contentRef)) {
			reject(fragment, "foreign_trajectory");
			continue;
		}
		if (
			fragment.contextClass === "owner-handoff" &&
			fragment.ownerScope !== parentScope &&
			!refIsAuthorized(fragment.contentRef)
		) {
			reject(fragment, "foreign_handoff");
			continue;
		}

		const loaded = await loadAuthorizedRecord({
			fragment,
			binding,
			contract,
			source: input.recordSource,
			resolveContent: input.resolveContent,
			sameLifecycle,
		});
		if (!loaded.ok) {
			reject(fragment, loaded.code);
			continue;
		}

		admittedEntries.push({ fragmentId: fragment.id, sourceHash: fragment.sourceHash });
		if (SYSTEM_CLASSES[fragment.contextClass] === true) {
			systemBlocks.push(loaded.record.content);
		} else if (messageRoleFor(fragment.contextClass) === "user") {
			messages.push({ role: "user", content: loaded.record.content, timestamp: 0 });
		} else {
			messages.push({ role: "developer", content: loaded.record.content, timestamp: 0 });
		}
	}

	if (missingRequired.length > 0) {
		return { ok: false, code: "missing_required_input", fragmentIds: missingRequired };
	}

	// Tool projection: requested schemas ∩ contract usableCapabilities ∩
	// harness maxTools. Alias-resolved canonical names decide membership;
	// the projected Tool keeps its real parameters schema untouched.
	const usable = contract.authority.usableCapabilities;
	const harnessCeiling = input.harness?.maxTools;
	const projectedTools: Tool[] = [];
	const toolRefs: ProjectedToolRef[] = [];
	for (const candidate of input.tools) {
		const canonical = resolveCanonicalToolName(candidate.tool.name);
		const inContract = usable.some(
			cap => cap.source === candidate.source && resolveCanonicalToolName(cap.name) === canonical,
		);
		if (!inContract) {
			rejected.push({ fragmentId: `tool:${candidate.source}:${candidate.tool.name}`, code: "tool_not_authorized" });
			continue;
		}
		const inHarness =
			harnessCeiling === undefined ||
			harnessCeiling.some(
				cap => cap.source === candidate.source && resolveCanonicalToolName(cap.name) === canonical,
			);
		if (!inHarness) {
			rejected.push({ fragmentId: `tool:${candidate.source}:${candidate.tool.name}`, code: "tool_outside_harness" });
			continue;
		}
		projectedTools.push(candidate.tool);
		toolRefs.push({
			source: candidate.source,
			name: candidate.tool.name,
			schemaHash: sha256Hex(canonicalJson(toolWireSchema(candidate.tool))),
		});
	}

	const baseManifest = {
		schemaVersion: 1 as const,
		launchHash: contract.contractDigest,
		policyHash: contract.policyHash,
		harnessHash: input.harness?.manifestHash ?? sha256Hex("none"),
		grantGeneration: input.grantGeneration,
		phase: input.phase,
		admitted: Object.freeze(admittedEntries),
		rejected: Object.freeze(rejected),
		tools: Object.freeze(toolRefs),
	};
	const manifest: ProjectionManifest = Object.freeze({
		...baseManifest,
		manifestHash: computeProjectionManifestHash(baseManifest),
	});

	const context: Context = { messages };
	if (systemBlocks.length > 0) context.systemPrompt = systemBlocks;
	if (projectedTools.length > 0) context.tools = projectedTools;

	return { ok: true, kind: "projected", context, manifest };
}

/** Refs that carry their own store-side authorization record. */
function refIsAuthorized(contentRef: string): boolean {
	return contentRef.startsWith("delivery:") || contentRef.startsWith("grant:");
}

const PROJECTION_PHASES: readonly ProjectionPhase[] = [
	"launch",
	"continue",
	"tool-result",
	"compact",
	"recall",
	"retry",
	"resume",
	"fork",
	"queued",
	"fallback",
	"side-request",
];

const PROJECTION_MANIFEST_KEYS = [
	"schemaVersion",
	"manifestHash",
	"launchHash",
	"policyHash",
	"harnessHash",
	"grantGeneration",
	"phase",
	"admitted",
	"rejected",
	"tools",
] as const;

/**
 * Strict parser: the manifest is the audit record of what was admitted into a
 * model request, so a coerced field would silently rewrite that history.
 */
export function parseProjectionManifest(value: unknown): ProjectionManifest {
	if (!isPlainObject(value)) throw new Error("Invalid ProjectionManifest: expected object");
	for (const key of Object.keys(value)) {
		if (!PROJECTION_MANIFEST_KEYS.includes(key as (typeof PROJECTION_MANIFEST_KEYS)[number])) {
			throw new Error(`Invalid ProjectionManifest: unknown field '${key}'`);
		}
	}
	if (value.schemaVersion !== 1) throw new Error("Invalid ProjectionManifest: schemaVersion must be 1");
	if (!isHex64(value.manifestHash)) {
		throw new Error("Invalid ProjectionManifest: manifestHash must be 64-hex SHA-256");
	}
	for (const field of ["launchHash", "policyHash", "harnessHash"] as const) {
		if (!isHex64(value[field])) {
			throw new Error(`Invalid ProjectionManifest: ${field} must be 64-hex SHA-256`);
		}
	}
	if (!isSafeNonNegativeInt(value.grantGeneration)) {
		throw new Error("Invalid ProjectionManifest: grantGeneration must be a safe non-negative integer");
	}
	if (typeof value.phase !== "string" || !PROJECTION_PHASES.includes(value.phase as ProjectionPhase)) {
		throw new Error(`Invalid ProjectionManifest: unknown phase '${String(value.phase)}'`);
	}
	if (!Array.isArray(value.admitted) || !Array.isArray(value.rejected) || !Array.isArray(value.tools)) {
		throw new Error("Invalid ProjectionManifest: admitted, rejected, tools must be arrays");
	}
	const base = {
		schemaVersion: 1 as const,
		launchHash: value.launchHash as string,
		policyHash: value.policyHash as string,
		harnessHash: value.harnessHash as string,
		grantGeneration: value.grantGeneration,
		phase: value.phase as ProjectionPhase,
		admitted: Object.freeze(
			value.admitted.map((entry, index) => {
				if (!isPlainObject(entry)) throw new Error(`Invalid ProjectionManifest: admitted[${index}] must be object`);
				if (!isNonEmptyString(entry.fragmentId)) {
					throw new Error(`Invalid ProjectionManifest: admitted[${index}].fragmentId must be a non-empty string`);
				}
				if (!isHex64(entry.sourceHash)) {
					throw new Error(`Invalid ProjectionManifest: admitted[${index}].sourceHash must be 64-hex SHA-256`);
				}
				return { fragmentId: entry.fragmentId, sourceHash: entry.sourceHash };
			}),
		),
		rejected: Object.freeze(
			value.rejected.map((entry, index) => {
				if (!isPlainObject(entry)) throw new Error(`Invalid ProjectionManifest: rejected[${index}] must be object`);
				if (!isNonEmptyString(entry.fragmentId)) {
					throw new Error(`Invalid ProjectionManifest: rejected[${index}].fragmentId must be a non-empty string`);
				}
				if (!isNonEmptyString(entry.code)) {
					throw new Error(`Invalid ProjectionManifest: rejected[${index}].code must be a non-empty string`);
				}
				return { fragmentId: entry.fragmentId, code: entry.code };
			}),
		),
		tools: Object.freeze(
			value.tools.map((entry, index) => {
				if (!isPlainObject(entry)) throw new Error(`Invalid ProjectionManifest: tools[${index}] must be object`);
				if (
					typeof entry.source !== "string" ||
					!TOOL_CAPABILITY_SOURCES.includes(entry.source as ToolCapabilitySource)
				) {
					throw new Error(`Invalid ProjectionManifest: tools[${index}].source is not a known tool source`);
				}
				if (!isNonEmptyString(entry.name)) {
					throw new Error(`Invalid ProjectionManifest: tools[${index}].name must be a non-empty string`);
				}
				if (!isHex64(entry.schemaHash)) {
					throw new Error(`Invalid ProjectionManifest: tools[${index}].schemaHash must be 64-hex SHA-256`);
				}
				return { source: entry.source as ToolCapabilitySource, name: entry.name, schemaHash: entry.schemaHash };
			}),
		),
	};
	if (computeProjectionManifestHash(base) !== value.manifestHash) {
		throw new Error("Invalid ProjectionManifest: manifestHash does not match content");
	}
	return Object.freeze({ ...base, manifestHash: value.manifestHash });
}

/**
 * One-seam activation for a bound session (§14.6): re-materialize the
 * lifecycle context from its persisted binding+contract AND attach the
 * projection binding in a single call, so fresh-spawn and revive callers
 * share exactly one path and neither can mint a bound context that still
 * fails `untrusted_context` at the provider seam.
 *
 * Returns the bound `LifecycleExecutionContext` — registered with its
 * durable `authority` ref and carrying a `LifecycleProjectionBinding`
 * ({bindingId, recordSource, resolveContent, grantGeneration, toolSourceOf})
 * so `projectLifecycleSideRequest` resolves instead of failing closed.
 *
 * `pin` is optional and forwarded to `resolvePersistedLifecycleContext`:
 * revive callers pass the persisted session_init launchAuthority pin so a
 * forged or stale pin throws `lifecycle_authority_mismatch` here.
 */
export function activateBoundSessionAuthority(input: {
	readonly store: OperationalStore;
	readonly binding: LaunchBinding;
	readonly contract: CompiledLaunchContract;
	readonly repoRoot: string;
	readonly artifactManager: SessionArtifactReader;
	readonly harness?: HarnessManifestV1;
	readonly toolSourceOf?: (name: string) => ToolCapabilitySource | undefined;
	readonly pin?: Parameters<typeof resolvePersistedLifecycleContext>[0]["pin"];
	/** Optional caller-owned SQLite handle shared by the record source and resolver. */
	readonly db?: Database;
}): LifecycleExecutionContext {
	const lifecycle = resolvePersistedLifecycleContext({
		binding: input.binding,
		contract: input.contract,
		repoRoot: input.repoRoot,
		pin: input.pin,
	});
	// Durable liveness: dispatch consults the store row at use time, so a
	// revocation committed by another process denies the next action.
	registerLiveBindingValidator(lifecycle, bindingId => {
		try {
			const row = input.store.getLaunchBinding(bindingId);
			return { state: row.state, policyEpoch: row.policyEpoch };
		} catch {
			return null;
		}
	});
	// Host-issued fragment provenance: caller content is persisted as a
	// content-addressed host record under the store's directory and the
	// descriptor names that record — never a caller-minted side-request ref.
	const fragmentDir = path.join(path.dirname(input.store.dbPath), "launch-fragments");
	bindLifecycleProjection(lifecycle, {
		bindingId: input.binding.bindingId,
		recordSource: createStoreRecordSource(input.store, input.db),
		resolveContent: createSessionRecordResolver({
			artifactManager: input.artifactManager,
			store: input.store,
			bindingId: input.binding.bindingId,
			db: input.db,
		}),
		harness: input.harness,
		grantGeneration: input.binding.policyEpoch,
		toolSourceOf: input.toolSourceOf,
		issueFragment: fragment => {
			try {
				const digest = sha256Hex(fragment.content);
				fs.mkdirSync(fragmentDir, { recursive: true });
				const filePath = path.join(fragmentDir, `${digest}.txt`);
				fs.writeFileSync(filePath, fragment.content, "utf8");
				return { contentRef: `file://${filePath}`, sourceHash: digest };
			} catch {
				return null;
			}
		},
	});
	return lifecycle;
}
