/**
 * Capability authorization for tool dispatch (W3, action/target/effect slice).
 *
 * Scope: this guard authorizes a tool invocation against the lifecycle
 * capability dictionary — capability membership (whether the principal bound
 * to the session may invoke the executable that is about to run, identified
 * by the provenance captured when that executable was registered) plus the
 * semantic action, effect class and normalized target refs of the request.
 *
 * Semantics are derived ONLY from:
 *   1. the tool's own declared metadata — `approval` (the same ToolApproval
 *      declaration the approval gate enforces) for the effect class, and
 *      `matcherPaths` for declared path targets; or
 *   2. the bounded host adapter table below, which maps canonical builtin
 *      tool names to the argument fields that carry path targets.
 *
 * Nothing here reads an effect, action or target from caller-supplied
 * strings, and nothing infers semantics from tool-name substrings. A tool
 * with no declared semantics and no adapter entry fails closed under a bound
 * context (`undeclared_tool_semantics` / `undeclared_tool_targets`); a tool
 * whose declaration is malformed fails closed as `invalid_tool_semantics`.
 *
 * Absence of a host-minted context preserves legacy behaviour. A context that
 * is present but unknown or revoked fails closed, because the authority
 * registry — not the caller — decides what a context may do.
 */
import * as path from "node:path";
import type { ToolTier } from "@pk-nerdsaver-ai/pi-agent-core";
import { ToolError } from "../tools/tool-errors";
import {
	authorizeLifecycleAction,
	getLifecycleRegistration,
	type LifecycleExecutionContext,
	resolveCanonicalToolName,
	type ToolCapabilitySource,
} from "./lifecycle-authority";
import type { AuthorizedCapabilityAction } from "./topology-policy";

/** Raised when the lifecycle authority refuses a tool invocation. */
export class LifecycleAuthorizationError extends ToolError {
	constructor(
		readonly code: string,
		readonly toolName: string,
		readonly denialReason: string,
	) {
		super(`Tool '${toolName}' denied by lifecycle authority (${code}): ${denialReason}`);
		this.name = "LifecycleAuthorizationError";
	}
}

/**
 * The dispatch-relevant surface of a tool. Structural, so both `AgentTool`
 * executables and the narrower `Tool` registry type satisfy it; fields the
 * underlying object does not declare simply read as `undefined`.
 */
export interface ToolDispatchSubject {
	readonly name: string;
	/** Declared approval tier (static, object, or args-evaluated function). */
	readonly approval?: unknown;
	/** Declared path-target extractor, when the tool provides one. */
	readonly matcherPaths?: unknown;
}

/** Effect/action pair a declared tool tier maps to in the authority dictionary. */
interface DispatchSemantics {
	readonly action: AuthorizedCapabilityAction;
	readonly effect: "read" | "local-write" | "external-write" | "control";
}

/**
 * Host-defined mapping from the declared approval tier to the authority
 * dictionary. `exec` maps to `control`: an exec-tier call is uncontainable
 * by path roots by definition, so the capability-membership check is the
 * whole gate and no target containment is claimed. `external-write` is never
 * produced here — it is reserved for explicit publish/mutate actions that
 * carry their own authorization, not for tool dispatch.
 */
const TIER_SEMANTICS: Readonly<Record<ToolTier, DispatchSemantics>> = {
	read: { action: "read_resource", effect: "read" },
	write: { action: "write_resource", effect: "local-write" },
	exec: { action: "invoke_tool", effect: "control" },
};

const TOOL_TIERS: ReadonlySet<string> = new Set(["read", "write", "exec"]);

/**
 * Bounded trusted adapter: canonical builtin tool name → how its invocation
 * arguments map to authority targets. `"none"` declares the tool has no
 * repository path targets (session state, memory, network resources); the
 * target list is then empty and no containment is claimed. `"fields"` lists
 * the argument fields that carry path targets; when a fields-adapted call
 * extracts no path, the target defaults to `"."` — the tool's default scope
 * is the working tree, so the check is honest rather than vacuous.
 *
 * Only canonical builtin names appear here; aliases are resolved before the
 * lookup. Non-builtin tools must declare `matcherPaths` to dispatch
 * read/write effects under a bound context.
 */
type BuiltinDispatchEntry = { readonly kind: "none" } | { readonly kind: "fields"; readonly fields: readonly string[] };

const BUILTIN_DISPATCH_ADAPTER: Readonly<Record<string, BuiltinDispatchEntry>> = {
	// Path-targeted tools.
	read: { kind: "fields", fields: ["path"] },
	write: { kind: "fields", fields: ["path"] },
	edit: { kind: "fields", fields: ["path", "paths"] },
	ast_edit: { kind: "fields", fields: ["paths"] },
	grep: { kind: "fields", fields: ["path", "paths"] },
	glob: { kind: "fields", fields: ["path"] },
	ast_grep: { kind: "fields", fields: ["path", "paths"] },
	inspect_image: { kind: "fields", fields: ["path"] },
	// Tools whose read/write effects have no repository path target.
	activity: { kind: "none" },
	ask: { kind: "none" },
	checkpoint: { kind: "none" },
	rewind: { kind: "none" },
	context_oracle: { kind: "none" },
	debug: { kind: "none" },
	github: { kind: "none" },
	irc: { kind: "none" },
	job: { kind: "none" },
	learn: { kind: "none" },
	manage_skill: { kind: "none" },
	memory_edit: { kind: "none" },
	retain: { kind: "none" },
	recall: { kind: "none" },
	reflect: { kind: "none" },
	resolve: { kind: "none" },
	search_tool_bm25: { kind: "none" },
	todo: { kind: "none" },
	yield: { kind: "none" },
};

/**
 * Provenance of the *executable*, not of the registry slot it currently
 * occupies. A handle obtained before an MCP/RPC refresh keeps the source it
 * was registered with, so a same-named replacement from another source can
 * neither launder the old executable nor be mistaken for it.
 */
const EXECUTABLE_SOURCES = new WeakMap<object, ToolCapabilitySource>();

/** Pair a captured registration source with the executable that will run. */
export function recordToolProvenance<T extends object>(tool: T, source: ToolCapabilitySource | undefined): T {
	if (source) EXECUTABLE_SOURCES.set(tool, source);
	return tool;
}

/** Read back the provenance captured for an executable, if any. */
export function getRecordedToolProvenance(tool: object | undefined): ToolCapabilitySource | undefined {
	return tool ? EXECUTABLE_SOURCES.get(tool) : undefined;
}

/**
 * Which binding an executable's guard was created for. Recorded provenance
 * alone proves nothing about authorization: the same executable can be handed
 * to another session, or to this one before it was bound. Re-wrapping is
 * skipped only when the existing guard was built for the very context that is
 * asking now.
 */
const GUARD_BINDINGS = new WeakMap<object, object>();

/** Sentinel identity for guards bound to an unbound (legacy) session. */
const UNBOUND_BINDING = Object.freeze({});

export function markToolGuarded<T extends object>(tool: T, context: LifecycleExecutionContext | undefined): T {
	GUARD_BINDINGS.set(tool, context ?? UNBOUND_BINDING);
	return tool;
}

export function isToolGuardedFor(tool: object, context: LifecycleExecutionContext | undefined): boolean {
	return GUARD_BINDINGS.get(tool) === (context ?? UNBOUND_BINDING);
}

/** Authorize one invocation; throws `LifecycleAuthorizationError` on denial. */
export type LifecycleToolGuard = (toolCallId: string, params?: unknown) => void;

/**
 * Evaluate the tool's declared approval into a tier. Returns `undefined`
 * when the tool declares nothing, `null` when the declaration is malformed
 * (a tier outside the ToolTier union — never silently promoted to exec).
 */
function declaredTier(tool: ToolDispatchSubject, params: unknown): ToolTier | undefined | null {
	const approval = tool.approval;
	if (approval === undefined) return undefined;
	const decision: unknown = typeof approval === "function" ? approval(params) : approval;
	if (typeof decision === "string") {
		return TOOL_TIERS.has(decision) ? (decision as ToolTier) : null;
	}
	if (decision && typeof decision === "object" && "tier" in decision) {
		const tier = decision.tier;
		if (typeof tier === "string" && TOOL_TIERS.has(tier)) return tier as ToolTier;
		return null;
	}
	return null;
}

/** Read one argument field as path targets: a string, or an array of strings. */
function extractFieldTargets(params: unknown, field: string, out: string[]): void {
	if (!params || typeof params !== "object" || !(field in params)) return;
	const value = (params as Record<string, unknown>)[field];
	if (typeof value === "string") {
		if (value.length > 0) out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			if (typeof entry === "string" && entry.length > 0) out.push(entry);
		}
	}
}

/**
 * Derive the authority targets for a read/write invocation. Declared
 * `matcherPaths` wins; otherwise the bounded builtin adapter supplies the
 * argument fields. No declaration and no adapter entry fails closed.
 */
function deriveInvocationTargets(tool: ToolDispatchSubject, params: unknown): string[] {
	const matcherPaths = tool.matcherPaths;
	if (typeof matcherPaths === "function") {
		const declared: unknown = matcherPaths(params);
		if (!Array.isArray(declared)) return [];
		const targets = declared.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
		return targets.length > 0 ? targets : ["."];
	}
	const entry = BUILTIN_DISPATCH_ADAPTER[resolveCanonicalToolName(tool.name)];
	if (!entry) {
		throw new LifecycleAuthorizationError(
			"undeclared_tool_targets",
			tool.name,
			"Tool declares a read/write effect but has no declared target fields and no adapter mapping.",
		);
	}
	if (entry.kind === "none") return [];
	const targets: string[] = [];
	for (const field of entry.fields) {
		extractFieldTargets(params, field, targets);
	}
	return targets.length > 0 ? targets : ["."];
}

/**
 * Normalize derived targets into the repo-relative refs the authority
 * checks. Absolute paths inside the registered repository root are
 * relativized; absolute paths outside it (and anything else unresolvable)
 * are passed through unchanged so the authority's own resolver denies them.
 */
function normalizeInvocationTargets(targets: readonly string[], repoRoot: string | undefined): string[] {
	if (!repoRoot) return [...targets];
	return targets.map(target => {
		if (path.isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target)) {
			const relative = path.relative(repoRoot, target);
			if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
				return relative.split(path.sep).join(path.posix.sep);
			}
		}
		return target;
	});
}

/**
 * Single authorization step shared by every dispatch wrapper.
 *
 * @param context Host-minted context, or `undefined` for an unbound (legacy) session.
 * @param source Provenance captured at registration for the executable being invoked.
 * @param tool The executable about to run; semantics are read from its own
 *   declared metadata (or the bounded adapter), never from the call payload.
 * @param params The invocation arguments, used only to evaluate declared
 *   metadata (approval functions, matcherPaths, adapter target fields).
 */
export function authorizeToolInvocation(
	context: LifecycleExecutionContext | undefined,
	source: ToolCapabilitySource | undefined,
	tool: ToolDispatchSubject,
	toolCallId: string,
	params?: unknown,
): void {
	if (!context) return;
	const toolName = tool.name;
	if (!source) {
		throw new LifecycleAuthorizationError(
			"unknown_tool_source",
			toolName,
			"No registration provenance is recorded for this executable.",
		);
	}
	const tier = declaredTier(tool, params);
	if (tier === null) {
		throw new LifecycleAuthorizationError(
			"invalid_tool_semantics",
			toolName,
			"Tool's declared approval metadata is not a valid capability tier.",
		);
	}
	const semantics = tier === undefined ? undefined : TIER_SEMANTICS[tier];
	if (!semantics) {
		throw new LifecycleAuthorizationError(
			"undeclared_tool_semantics",
			toolName,
			"Tool declares no capability semantics and has no adapter mapping.",
		);
	}
	const targets =
		semantics.effect === "read" || semantics.effect === "local-write"
			? normalizeInvocationTargets(
					deriveInvocationTargets(tool, params),
					getLifecycleRegistration(context)?.repoRoot,
				)
			: [];
	const decision = authorizeLifecycleAction(context, {
		tool: { source, name: toolName },
		action: semantics.action,
		targets,
		effect: semantics.effect,
		invocationId: toolCallId,
	});
	if (!decision.allowed) {
		throw new LifecycleAuthorizationError(decision.code, toolName, decision.reason);
	}
}

/**
 * Bind a guard to one executable. Both halves of the identity — the tool
 * object whose declared metadata is evaluated and the captured source — are
 * frozen here, so a callback that swaps registry entries between two checks
 * of the same call cannot change which capability is being authorized.
 * `getContext` stays a callback so a revocation between those checks is
 * observed by the second one.
 */
export function createLifecycleToolGuard(
	getContext: () => LifecycleExecutionContext | undefined,
	source: ToolCapabilitySource | undefined,
	tool: ToolDispatchSubject,
): LifecycleToolGuard {
	return (toolCallId, params) => authorizeToolInvocation(getContext(), source, tool, toolCallId, params);
}
