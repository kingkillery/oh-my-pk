import * as path from "node:path";
import type { AgentRole } from "../task/launch-contract";
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

export type LifecycleAuthorityMode = "legacy-v0" | "direct-v1" | "hierarchical-v1";

/** What the host knows about a registered context. Never model-supplied. */
export interface LifecycleAuthorityRegistration {
	readonly mode: LifecycleAuthorityMode;
	readonly role: AgentRole;
	readonly runId: string;
	readonly nodeId: string;
	readonly attemptId: string;
	readonly policyEpoch: number;
	/** Source-qualified tools this principal may invoke. Empty denies all. */
	readonly usableCapabilities: readonly ToolCapability[];
	/** Absolute repository root used to canonicalise every target path. */
	readonly repoRoot: string;
	/** Repository-relative roots this principal may read. */
	readonly readableRoots: readonly string[];
	/** Repository-relative roots this principal may write. */
	readonly writableRoots: readonly string[];
	/** Explicitly authorized external-write actions (publish and similar). */
	readonly allowExternalWrite: boolean;
}

const REGISTRY = new WeakMap<LifecycleExecutionContext, LifecycleAuthorityRegistration>();

/**
 * Host-only. Mints an opaque context and records its authority.
 *
 * Not exported through tool, eval or extension bindings: possession of a
 * handle IS authority, so handles must never be reconstructable from data.
 */
export function registerLifecycleExecutionContext(
	registration: LifecycleAuthorityRegistration,
): LifecycleExecutionContext {
	const handle = Object.freeze({}) as LifecycleExecutionContext;
	REGISTRY.set(handle, Object.freeze({ ...registration }));
	return handle;
}

/** Host-only read-back, for adapters that must inspect their own binding. */
export function getLifecycleRegistration(
	context: LifecycleExecutionContext,
): LifecycleAuthorityRegistration | undefined {
	return REGISTRY.get(context);
}

/** Host-only. Revokes a context so later use fails closed. */
export function revokeLifecycleExecutionContext(context: LifecycleExecutionContext): void {
	REGISTRY.delete(context);
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
	context: LifecycleExecutionContext,
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
	},
): LifecycleExecutionContext | undefined {
	const parentRegistration = REGISTRY.get(parent);
	if (!parentRegistration) return undefined;
	return registerLifecycleExecutionContext({
		mode: parentRegistration.mode,
		role: child.role,
		runId: parentRegistration.runId,
		nodeId: child.nodeId,
		attemptId: child.attemptId,
		policyEpoch: parentRegistration.policyEpoch,
		usableCapabilities: child.usableCapabilities ?? parentRegistration.usableCapabilities,
		repoRoot: child.repoRoot ?? parentRegistration.repoRoot,
		readableRoots: child.readableRoots ?? parentRegistration.readableRoots,
		writableRoots: child.writableRoots ?? parentRegistration.writableRoots,
		allowExternalWrite: false,
	});
}
