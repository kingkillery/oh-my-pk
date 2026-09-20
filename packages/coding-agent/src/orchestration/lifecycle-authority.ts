import * as path from "node:path";
import type { AgentRole } from "../task/launch-contract";
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

export interface LifecycleExecutionContext {
	readonly runId: string;
	readonly nodeId: string;
	readonly attemptId: string;
	readonly role: AgentRole;
	readonly mode: "legacy-v0" | "direct-v1" | "hierarchical-v1";
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

/**
 * Single dispatch choke point (A05). Every tool invocation path — direct
 * calls, JS/Python bridges, aliases, late discovery, restored sessions —
 * resolves through this guard before side effects.
 */
export function authorizeLifecycleAction(
	context: LifecycleExecutionContext,
	request: CapabilityRequest,
): CapabilityDecision {
	if (context.mode === "legacy-v0") {
		return { allowed: true };
	}
	if (context.mode === "hierarchical-v1") {
		if (!context.runId || !context.nodeId || !context.attemptId) {
			return {
				allowed: false,
				code: "missing_lifecycle_binding",
				reason: "Hierarchical context lacks a lifecycle binding.",
			};
		}
	}
	if (!request.invocationId.trim()) {
		return {
			allowed: false,
			code: "missing_invocation_id",
			reason: "Every guarded invocation requires an idempotency key.",
		};
	}

	const roleCheck = checkRoleAuthority(context.role, request.action);
	if (!roleCheck.allowed) {
		return { allowed: false, code: roleCheck.violation.code, reason: roleCheck.violation.message };
	}

	return { allowed: true };
}
