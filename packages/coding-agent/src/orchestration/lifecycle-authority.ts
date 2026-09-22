import * as path from "node:path";
import type {
	AgentRole,
	AuthorityEnvelopeV1,
	CompiledLaunchContract,
	LaunchAuthorityRefV1,
	LaunchBinding,
	RuntimePolicySnapshotV1,
	TopologyKind,
} from "../task/launch-contract";
import type { ToolCapability } from "../tools/tool-profiles";
import { type AuthorizedCapabilityAction, checkRoleAuthority } from "./topology-policy";

export type ToolCapabilitySource = "builtin" | "mcp" | "extension" | "custom" | "hidden";

export interface CapabilityRequest {
	readonly tool: { readonly source: ToolCapabilitySource; readonly name: string } | null;
	readonly action: AuthorizedCapabilityAction;
	readonly targets: readonly string[];
	readonly effect: "read" | "local-write" | "external-write" | "control";
	readonly invocationId: string;
}

export type CapabilityDecision =
	| { readonly allowed: true }
	| { readonly allowed: false; readonly code: string; readonly reason: string };

/**
 * Opaque handle to a runtime-registered execution context.
 *
 * The fields that decide authority are NOT on this object: they live in a
 * host-private registry keyed by the handle. A serialized context, a
 * structurally identical literal, or anything a model or extension can
 * construct is therefore unregistered and fails closed. The previous
 * structural shape let any caller assert `mode: "legacy-v0"` and be granted
 * everything.
 */
declare const LIFECYCLE_CONTEXT_BRAND: unique symbol;
export type LifecycleExecutionContext = { readonly [LIFECYCLE_CONTEXT_BRAND]: true };

/**
 * Opaque handle to a registered ROOT execution context (§14.6).
 *
 * A root context is an ISSUER: it authenticates delegated-child admissions
 * and carries the host's own authority envelope, but it is NOT a bound child
 * and must never be installed as a session's `lifecycleExecutionContext` —
 * its brand is deliberately distinct so that assignment fails to typecheck,
 * and `authorizeLifecycleAction` fails closed on it at runtime. Hosts obtain
 * one from `createHostRootExecutionContext` at bootstrap.
 */
declare const ROOT_EXECUTION_CONTEXT_BRAND: unique symbol;
export type RootExecutionContext = { readonly [ROOT_EXECUTION_CONTEXT_BRAND]: true };

export type LifecycleAuthorityMode = "legacy-v0" | "direct-v1" | "hierarchical-v1";

/** What the host knows about a registered context. Never model-supplied. */
export interface LifecycleAuthorityRegistration {
	readonly mode: LifecycleAuthorityMode;
	readonly role: AgentRole;
	readonly runId: string;
	readonly nodeId: string;
	readonly attemptId: string;
	readonly policyEpoch: number;
	/**
	 * Durable identity of the binding this context was admitted under
	 * (§14.2 `LaunchAuthorityRefV1`). Non-null exactly when the context was
	 * materialized from a persisted `launch_bindings` row — a bound context
	 * IS its durable identity. In-memory derivations and root contexts carry
	 * `null`. Lives only in this host-private record; the branded handle
	 * stays inert, so §4.4 opacity is preserved.
	 */
	readonly authority: LaunchAuthorityRefV1 | null;
	/**
	 * Present only on a root-branded registration: the host's issuer
	 * identity. `rootPrincipalId` is stable per root session and is what
	 * child bindings reference as their `rootPrincipalId`; `authorityEnvelope`
	 * is the delegable ceiling child admissions narrow against;
	 * `issuerPolicyEpoch` mirrors `policyEpoch` for the issuer role.
	 */
	readonly root: {
		readonly rootPrincipalId: string;
		readonly issuerPolicyEpoch: number;
		readonly authorityEnvelope: AuthorityEnvelopeV1;
	} | null;
	readonly usableCapabilities: readonly ToolCapability[];
	readonly repoRoot: string;
	readonly readableRoots: readonly string[];
	readonly writableRoots: readonly string[];
	readonly allowExternalWrite: boolean;
}

/**
 * Registration input: `authority` and `root` default to `null` so existing
 * host call sites (tests, in-memory derivation) stay valid; the durable
 * resolvers populate them explicitly.
 */
export type LifecycleAuthorityRegistrationInput = Omit<LifecycleAuthorityRegistration, "authority" | "root"> & {
	readonly authority?: LaunchAuthorityRefV1 | null;
	readonly root?: LifecycleAuthorityRegistration["root"];
};

const REGISTRY = new WeakMap<LifecycleExecutionContext | RootExecutionContext, LifecycleAuthorityRegistration>();

/**
 * Non-destructive deep freeze: clones plain objects/arrays and freezes the
 * copies, so a caller-held envelope or ref cannot be mutated into the
 * registration afterwards and host read-back cannot rewrite it either.
 */
function deepFreezeCopy<T>(value: T): T {
	if (Array.isArray(value)) {
		return Object.freeze(value.map(item => deepFreezeCopy(item))) as T;
	}
	if (typeof value === "object" && value !== null) {
		const copy: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			copy[key] = deepFreezeCopy(entry);
		}
		return Object.freeze(copy) as T;
	}
	return value;
}

/**
 * Host-only. Mints an opaque context and records its authority.
 *
 * Not exported through tool, eval or extension bindings: possession of a
 * handle IS authority, so handles must never be reconstructable from data.
 */
export function registerLifecycleExecutionContext(
	registration: LifecycleAuthorityRegistrationInput,
): LifecycleExecutionContext {
	const handle = Object.freeze({}) as LifecycleExecutionContext;
	REGISTRY.set(
		handle,
		Object.freeze({
			...registration,
			authority: registration.authority ? deepFreezeCopy(registration.authority) : null,
			root: registration.root ? deepFreezeCopy(registration.root) : null,
			usableCapabilities: Object.freeze(
				registration.usableCapabilities.map(capability => Object.freeze({ ...capability })),
			),
			readableRoots: Object.freeze([...registration.readableRoots]),
			writableRoots: Object.freeze([...registration.writableRoots]),
		}),
	);
	return handle;
}

/** Host-only read-back, for adapters that must inspect their own binding. */
export function getLifecycleRegistration(
	context: LifecycleExecutionContext | RootExecutionContext,
): LifecycleAuthorityRegistration | undefined {
	return REGISTRY.get(context);
}

/** Host-only. Revokes a context so later use fails closed. */
export function revokeLifecycleExecutionContext(context: LifecycleExecutionContext | RootExecutionContext): void {
	REGISTRY.delete(context);
	LIVE_BINDING_PROBES.delete(context);
}

/**
 * Host-private durable liveness probe for a bound context (§14.5/R11).
 *
 * A registration pins the binding identity it was materialized under, but
 * the WeakMap alone cannot see a revocation another process committed to
 * the store. The probe reads the CURRENT durable row — state and epoch —
 * at dispatch time. `null` means the binding is no longer readable.
 */
export type LiveBindingProbe = (bindingId: string) => {
	readonly state: LaunchBinding["state"];
	readonly policyEpoch: number;
} | null;

const LIVE_BINDING_PROBES = new WeakMap<LifecycleExecutionContext | RootExecutionContext, LiveBindingProbe>();

/**
 * Host-only: attach the durable liveness probe a bound context's dispatch
 * consults. Called by the same host code that materialized the context
 * (`activateBoundSessionAuthority`); a context whose registration carries
 * `authority` but no probe fails CLOSED at dispatch — never allow-on-error.
 */
export function registerLiveBindingValidator(
	context: LifecycleExecutionContext | RootExecutionContext,
	probe: LiveBindingProbe,
): void {
	LIVE_BINDING_PROBES.set(context, probe);
}

/** Canonical tool aliases resolve to one identity before authority checks. */
const TOOL_ALIASES: Record<string, string> = {
	task: "task",
	spawn: "task",
	agent: "task",
};

const NULL_CHAR = String.fromCharCode(0);

export function resolveCanonicalToolName(name: string): string {
	const trimmed = name.trim();
	return TOOL_ALIASES[trimmed] ?? trimmed;
}

/**
 * Canonical repository-relative path resolver (A02/A05/A10 shared).
 * Rejects absolute roots, drive/UNC paths, URI-encoded traversal, and
 * lexical escapes. Callers apply realpath containment at the filesystem
 * boundary; this function guarantees the lexical form is safe first.
 */
export function resolveLifecyclePath(repoRoot: string, candidate: string): string {
	const trimmed = candidate.trim();
	if (!trimmed) throw new Error("empty_path");
	try {
		const decoded = decodeURIComponent(trimmed);
		if (decoded !== trimmed && (decoded.includes("..") || decoded.includes(NULL_CHAR))) {
			throw new Error("encoded_traversal");
		}
	} catch (err) {
		if (err instanceof Error && err.message === "encoded_traversal") throw err;
	}
	if (trimmed.includes(NULL_CHAR)) throw new Error("null_byte_path");
	if (path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")) {
		throw new Error("absolute_path");
	}
	const normalized = path.posix.normalize(trimmed.split(path.sep).join(path.posix.sep));
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new Error("path_escape");
	}
	void repoRoot;
	return normalized;
}

/** Actions whose effect necessarily reaches outside the run candidate. */
const EXTERNAL_WRITE_ACTIONS: readonly AuthorizedCapabilityAction[] = ["publish", "mutate_target"];

/**
 * Single dispatch choke point (A05). Every tool invocation path — direct
 * calls, JS/Python bridges, aliases, late discovery, restored sessions —
 * resolves through this guard before side effects.
 *
 * Authority comes from the host registry, never from the request or from
 * fields on the context. The request describes what the caller WANTS; only
 * the registration says what it MAY have.
 */
export function authorizeLifecycleAction(
	context: LifecycleExecutionContext | RootExecutionContext,
	request: CapabilityRequest,
): CapabilityDecision {
	const registration = REGISTRY.get(context);
	if (!registration) {
		// Fails closed for every class, including legacy. An unregistered
		// context is indistinguishable from a forged one.
		return {
			allowed: false,
			code: "missing_lifecycle_binding",
			reason: "Execution context is not registered with the lifecycle authority.",
		};
	}
	if (registration.root) {
		// A root context is an ISSUER, never a bound child: it authenticates
		// delegated admissions but carries no run/node/attempt of its own, so
		// it must never answer a dispatch check. Deny explicitly rather than
		// relying on its empty lifecycle identity.
		return {
			allowed: false,
			code: "missing_lifecycle_binding",
			reason: "Root execution context is an issuer, not a dispatch authority.",
		};
	}
	if (!request.invocationId.trim()) {
		return {
			allowed: false,
			code: "missing_invocation_id",
			reason: "Every guarded invocation requires an idempotency key.",
		};
	}
	if (!registration.runId || !registration.nodeId || !registration.attemptId) {
		return {
			allowed: false,
			code: "missing_lifecycle_binding",
			reason: "Registered context lacks run, node or attempt identity.",
		};
	}

	// Durable liveness (§14.5/R11): a bound context dispatches only while
	// its persisted binding is live at the epoch the registration pinned.
	// The probe reads the store row NOW, so a revocation committed by
	// another process denies the next dispatch — the in-process WeakMap
	// alone cannot see it. Fail closed: no probe or an unreadable row is
	// never an allow.
	const authority = registration.authority;
	if (authority) {
		const probe = LIVE_BINDING_PROBES.get(context);
		if (!probe) {
			return {
				allowed: false,
				code: "authority_liveness_unavailable",
				reason: "No durable binding probe is registered for this context.",
			};
		}
		let live: { readonly state: LaunchBinding["state"]; readonly policyEpoch: number } | null;
		try {
			live = probe(authority.bindingId);
		} catch {
			live = null;
		}
		if (!live) {
			return {
				allowed: false,
				code: "authority_liveness_unavailable",
				reason: `Binding '${authority.bindingId}' could not be read from the store.`,
			};
		}
		if (live.state !== "bound" && live.state !== "active" && live.state !== "suspended") {
			return {
				allowed: false,
				code: "launch_authority_revoked",
				reason: `Binding '${authority.bindingId}' is '${live.state}' in the store.`,
			};
		}
		if (live.policyEpoch !== authority.policyEpoch) {
			return {
				allowed: false,
				code: "launch_authority_revoked",
				reason: `Binding '${authority.bindingId}' moved to epoch ${live.policyEpoch}; this context pinned ${authority.policyEpoch}.`,
			};
		}
	}

	const roleCheck = checkRoleAuthority(registration.role, request.action);
	if (!roleCheck.allowed) {
		return { allowed: false, code: roleCheck.violation.code, reason: roleCheck.violation.message };
	}

	// Tool identity is source-qualified and alias-resolved BEFORE the
	// membership test, so an alias or a same-named tool from another source
	// cannot slip past a ceiling that never admitted it.
	if (request.tool) {
		const canonical = resolveCanonicalToolName(request.tool.name);
		const permitted = registration.usableCapabilities.some(
			capability =>
				capability.source === request.tool?.source && resolveCanonicalToolName(capability.name) === canonical,
		);
		if (!permitted) {
			return {
				allowed: false,
				code: "capability_not_granted",
				reason: `Tool ${request.tool.source}:${canonical} is not in this principal's usable capabilities.`,
			};
		}
	}

	if (request.effect === "external-write") {
		if (!registration.allowExternalWrite || !EXTERNAL_WRITE_ACTIONS.includes(request.action)) {
			return {
				allowed: false,
				code: "external_write_not_granted",
				reason: "This principal may not perform external writes.",
			};
		}
	}

	// Path targets are canonicalised against the registered repository root
	// and checked for containment. Lexical prefix matching alone would admit
	// `src/../../etc`, so resolveLifecyclePath rejects escapes first.
	if (request.effect === "read" || request.effect === "local-write" || request.effect === "external-write") {
		const roots = request.effect === "read" ? registration.readableRoots : registration.writableRoots;
		for (const target of request.targets) {
			const containment = checkTargetContainment(registration.repoRoot, target, roots);
			if (!containment.allowed) return containment;
		}
	}

	return { allowed: true };
}

function checkTargetContainment(repoRoot: string, target: string, roots: readonly string[]): CapabilityDecision {
	let resolved: string;
	try {
		resolved = resolveLifecyclePath(repoRoot, target);
	} catch (error) {
		return {
			allowed: false,
			code: "target_outside_scope",
			reason: error instanceof Error ? error.message : `Target '${target}' could not be resolved.`,
		};
	}
	const contained = roots.some(root => {
		const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
		if (normalizedRoot === "" || normalizedRoot === ".") return true;
		return resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}/`);
	});
	if (!contained) {
		return {
			allowed: false,
			code: "target_outside_scope",
			reason: `Target '${resolved}' is outside this principal's granted roots.`,
		};
	}
	return { allowed: true };
}

/**
 * Host-only: mint a CHILD context derived from a registered parent.
 *
 * The child inherits the parent's roots and epoch but takes the child's own
 * role and (optionally narrowed) capabilities. Spawning a worker from a
 * planner mints a `worker` context, and a worker's own spawns then fail
 * leaf_delegation_denied — which is what bounds recursion end to end. The
 * parent's registration is never mutated: each context is an independent
 * WeakMap entry, and revoking the parent does not revoke children (W5
 * replaces this derivation with store-backed binding activation, where
 * revocation propagates through recorded lineage).
 */
export function deriveChildLifecycleContext(
	parent: LifecycleExecutionContext,
	child: {
		role: AgentRole;
		nodeId: string;
		attemptId: string;
		usableCapabilities?: readonly ToolCapability[];
		repoRoot?: string;
		readableRoots?: readonly string[];
		writableRoots?: readonly string[];
		/**
		 * Durable authority ref for the derived child. In-memory derivation
		 * mints no durable attempt, so production callers leave this unset
		 * (`null`); it exists for tests that simulate a bound registration.
		 */
		authority?: LaunchAuthorityRefV1 | null;
	},
): LifecycleExecutionContext {
	const parentRegistration = REGISTRY.get(parent);
	if (!parentRegistration) {
		throw new Error("missing_lifecycle_binding: cannot derive child authority from an unregistered parent");
	}
	return registerLifecycleExecutionContext({
		mode: parentRegistration.mode,
		role: child.role,
		runId: parentRegistration.runId,
		nodeId: child.nodeId,
		attemptId: child.attemptId,
		policyEpoch: parentRegistration.policyEpoch,
		authority: child.authority ?? null,
		usableCapabilities: child.usableCapabilities ?? parentRegistration.usableCapabilities,
		repoRoot: child.repoRoot ?? parentRegistration.repoRoot,
		readableRoots: child.readableRoots ?? parentRegistration.readableRoots,
		writableRoots: child.writableRoots ?? parentRegistration.writableRoots,
		allowExternalWrite: false,
	});
}

/** Binding states that may re-materialize a live context on revive/replay. */
const LIVE_BINDING_STATES: ReadonlySet<LaunchBinding["state"]> = new Set(["bound", "active"]);

const TOPOLOGY_TO_MODE: Record<TopologyKind, LifecycleAuthorityMode> = {
	hierarchical: "hierarchical-v1",
	direct: "direct-v1",
	legacy: "legacy-v0",
};

/**
 * Host-only §4.3 resolve-existing: re-materialize a LifecycleExecutionContext
 * for a binding that ALREADY exists in the operational store. This never
 * admits a second job — the registration carries the SAME run/node/attempt
 * identity the binding was admitted with, so the re-registered context is the
 * same authority restored. `restoresBindingId` lineage stays in the store.
 *
 * Fail-closed in both directions:
 * - a binding that is not `bound`/`active` (revoked, superseded, failed,
 *   terminal, suspended, or still only `authorized`) throws
 *   `missing_lifecycle_binding` rather than minting a live context;
 * - a persisted pin or payload that disagrees with the binding's recorded
 *   contract identity throws `lifecycle_authority_mismatch` — a forged or
 *   stale pin must never silently rebind to different authority.
 *
 * `repoRoot` is host-supplied: the absolute repository root is environment
 * knowledge, never persisted authority data. Readable/writable roots come
 * from the contract's mission capsule scope; `allowExternalWrite` maps to the
 * mutation contract's `allowPush` — the only mutation flag whose effect
 * necessarily reaches outside the run candidate (publish/push).
 */
export function resolvePersistedLifecycleContext(input: {
	binding: LaunchBinding;
	contract: CompiledLaunchContract;
	repoRoot: string;
	/** Optional persisted pin (session_init launchAuthority or a v2 payload) to verify against. */
	pin?: {
		readonly bindingId?: string;
		readonly principalId?: string;
		readonly attemptId: string;
		readonly contractId?: string;
		readonly contractRevision?: number;
		readonly contractDigest?: string;
		readonly policyEpoch?: number;
		readonly contextGeneration?: number;
		readonly runId?: string;
		readonly nodeId?: string;
	};
}): LifecycleExecutionContext {
	const { binding, contract, repoRoot, pin } = input;
	if (!LIVE_BINDING_STATES.has(binding.state)) {
		throw new Error(`missing_lifecycle_binding: binding '${binding.bindingId}' is '${binding.state}', not live`);
	}
	if (pin) {
		const mismatched = (field: string, expected: unknown, actual: unknown): never => {
			throw new Error(
				`lifecycle_authority_mismatch: persisted pin ${field} '${String(expected)}' does not match binding '${String(actual)}'`,
			);
		};
		if (pin.bindingId !== undefined && pin.bindingId !== binding.bindingId)
			mismatched("bindingId", pin.bindingId, binding.bindingId);
		if (pin.principalId !== undefined && pin.principalId !== binding.childPrincipalId)
			mismatched("principalId", pin.principalId, binding.childPrincipalId);
		if (pin.attemptId !== binding.attemptId) mismatched("attemptId", pin.attemptId, binding.attemptId);
		if (pin.contractId !== undefined && pin.contractId !== binding.contractId)
			mismatched("contractId", pin.contractId, binding.contractId);
		if (pin.contractRevision !== undefined && pin.contractRevision !== binding.contractRevision)
			mismatched("contractRevision", pin.contractRevision, binding.contractRevision);
		if (pin.contractDigest !== undefined && pin.contractDigest !== binding.contractDigest)
			mismatched("contractDigest", pin.contractDigest, binding.contractDigest);
		if (pin.policyEpoch !== undefined && pin.policyEpoch !== binding.policyEpoch)
			mismatched("policyEpoch", pin.policyEpoch, binding.policyEpoch);
		if (pin.contextGeneration !== undefined && pin.contextGeneration !== binding.contextGeneration)
			mismatched("contextGeneration", pin.contextGeneration, binding.contextGeneration);
		if (pin.runId !== undefined && pin.runId !== binding.lifecycle?.runId)
			mismatched("runId", pin.runId, binding.lifecycle?.runId);
		if (pin.nodeId !== undefined && pin.nodeId !== binding.lifecycle?.nodeId)
			mismatched("nodeId", pin.nodeId, binding.lifecycle?.nodeId);
	}
	if (contract.contractDigest !== binding.contractDigest || contract.contractId !== binding.contractId) {
		throw new Error(
			`lifecycle_authority_mismatch: contract '${contract.contractId}@${contract.contractDigest}' does not match binding '${binding.bindingId}' (${binding.contractId}@${binding.contractDigest})`,
		);
	}
	return registerLifecycleExecutionContext({
		mode: TOPOLOGY_TO_MODE[contract.policy.topology],
		role: contract.policy.role,
		// Graph identity lives in the binding's lifecycle block; a direct/legacy
		// binding has none, so its durable binding/principal ids stand in —
		// persisted identities, never invented ones.
		runId: binding.lifecycle?.runId ?? binding.bindingId,
		nodeId: binding.lifecycle?.nodeId ?? binding.childPrincipalId,
		attemptId: binding.attemptId,
		policyEpoch: binding.policyEpoch,
		// The bound context IS its durable identity (§14.2): the pin write and
		// the projection bind read these fields straight from the registration.
		authority: {
			bindingId: binding.bindingId,
			principalId: binding.childPrincipalId,
			attemptId: binding.attemptId,
			contractId: binding.contractId,
			contractRevision: binding.contractRevision,
			contractDigest: binding.contractDigest,
			policyEpoch: binding.policyEpoch,
		},
		usableCapabilities: contract.authority.usableCapabilities,
		repoRoot,
		readableRoots: contract.capsule.readableScope,
		writableRoots: contract.capsule.writableScope,
		// Only `allowPush` necessarily reaches outside the run candidate;
		// commit/merge stay inside it.
		allowExternalWrite: contract.policy.mutation.allowPush,
	});
}

/**
 * Host-only §14.6 root factory: mint the ISSUER context for an interactive
 * root session.
 *
 * The root is not a delegated launch class — it gets a PRINCIPAL, not a
 * binding. The returned handle is root-branded (`RootExecutionContext`), so
 * it cannot be installed as a session's `lifecycleExecutionContext`: its
 * brand does not typecheck there, and `authorizeLifecycleAction` fails
 * closed on it at runtime. It exists to AUTHENTICATE delegated-child
 * admissions — `prepareLifecycleLaunch` reads the registration for the
 * mutation guard and the preflight narrows `authorityEnvelope` into the
 * child's `parentDelegable` ceiling.
 *
 * `rootPrincipalId` is host-derived and stable per root session (default
 * `principal-root-<sessionId>`); the durable `launch_principals` row is
 * persisted lazily inside `admitLaunchAuthority`'s transaction on the first
 * delegated child, so a no-DB direct root startup stays scheduler-free.
 *
 * The registration deliberately carries NO lifecycle identity (empty
 * run/node/attempt, `authority: null`): the root never executes under a
 * binding, and any code path that treats it as a bound child fails closed.
 * `repoRoot`/`readableRoots`/`writableRoots` are likewise empty — the root's
 * ambient file access is governed by approvals and tool policy, not by a
 * delegated scope.
 */
export function createHostRootExecutionContext(input: {
	readonly sessionId: string;
	readonly policy: RuntimePolicySnapshotV1;
	readonly authority: AuthorityEnvelopeV1;
	/** Stable issuer identity; defaults to `principal-root-<sessionId>`. */
	readonly rootPrincipalId?: string;
	/** Issuer policy epoch stamped on admissions this root authenticates. */
	readonly policyEpoch?: number;
}): RootExecutionContext {
	const rootPrincipalId = input.rootPrincipalId ?? `principal-root-${input.sessionId}`;
	const policyEpoch = input.policyEpoch ?? 1;
	const handle = Object.freeze({}) as RootExecutionContext;
	REGISTRY.set(
		handle,
		Object.freeze({
			mode: TOPOLOGY_TO_MODE[input.policy.topology],
			role: input.policy.role,
			runId: "",
			nodeId: "",
			attemptId: "",
			policyEpoch,
			authority: null,
			root: deepFreezeCopy({
				rootPrincipalId,
				issuerPolicyEpoch: policyEpoch,
				authorityEnvelope: input.authority,
			}),
			usableCapabilities: Object.freeze(
				input.authority.usableCapabilities.map(capability => Object.freeze({ ...capability })),
			),
			repoRoot: "",
			readableRoots: Object.freeze([]),
			writableRoots: Object.freeze([]),
			allowExternalWrite: false,
		}),
	);
	return handle;
}
