import { describe, expect, it } from "bun:test";
import {
	authorizeLifecycleAction,
	type CapabilityRequest,
	type LifecycleExecutionContext,
	resolveCanonicalToolName,
	resolveLifecyclePath,
} from "../../src/orchestration/lifecycle-authority";

const worker: LifecycleExecutionContext = {
	runId: "run-1",
	nodeId: "node-2",
	attemptId: "att-1",
	role: "worker",
	mode: "hierarchical-v1",
};

function request(action: CapabilityRequest["action"], tool: string | null = "task"): CapabilityRequest {
	return {
		tool: tool ? { source: "builtin", name: tool } : null,
		action,
		targets: [],
		effect: "control",
		invocationId: "inv-1",
	};
}

describe("Lifecycle dispatch authority (A05)", () => {
	it("denies leaf spawn/list/broadcast/wake/self-promote before side effects", () => {
		for (const action of [
			"spawn_agent",
			"peer_message",
			"list_peers",
			"peer_wake",
			"peer_broadcast",
			"change_role",
		] as const) {
			const decision = authorizeLifecycleAction(worker, request(action));
			expect(decision.allowed).toBe(false);
		}
	});

	it("allows owner escalation and denies the same request through aliases and bridges", () => {
		const escalation = authorizeLifecycleAction(worker, request("escalate_owner"));
		expect(escalation.allowed).toBe(true);

		expect(resolveCanonicalToolName("spawn")).toBe("task");
		expect(resolveCanonicalToolName("agent")).toBe("task");

		const aliasSpawn = authorizeLifecycleAction(worker, request("spawn_agent", "spawn"));
		expect(aliasSpawn.allowed).toBe(false);

		const bridgeSpawn = authorizeLifecycleAction(worker, {
			tool: { source: "custom", name: "agent" },
			action: "spawn_agent",
			targets: [],
			effect: "control",
			invocationId: "inv-bridge-1",
		});
		expect(bridgeSpawn.allowed).toBe(false);
	});

	it("fails closed when a hierarchical binding is missing", () => {
		const decision = authorizeLifecycleAction({ ...worker, attemptId: "" }, request("escalate_owner"));
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.code).toBe("missing_lifecycle_binding");
	});

	it("rejects traversal, absolute, drive, UNC, and encoded paths", () => {
		expect(() => resolveLifecyclePath("/repo", "../escape")).toThrow();
		expect(() => resolveLifecyclePath("/repo", "/abs/path")).toThrow();
		expect(() => resolveLifecyclePath("/repo", "C:\\win\\path")).toThrow();
		expect(() => resolveLifecyclePath("/repo", "\\\\server\\share")).toThrow();
		expect(() => resolveLifecyclePath("/repo", "%2e%2e%2fescape")).toThrow();
		expect(resolveLifecyclePath("/repo", "src/feature.ts")).toBe("src/feature.ts");
	});
});
