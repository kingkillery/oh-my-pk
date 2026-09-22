import { describe, expect, it } from "bun:test";
import {
	authorizeLifecycleAction,
	type CapabilityRequest,
	deriveChildLifecycleContext,
	getLifecycleRegistration,
	type LifecycleAuthorityRegistration,
	type LifecycleExecutionContext,
	registerLifecycleExecutionContext,
	resolveCanonicalToolName,
	resolveLifecyclePath,
	revokeLifecycleExecutionContext,
} from "../../src/orchestration/lifecycle-authority";

function registerWorker(overrides: Partial<LifecycleAuthorityRegistration> = {}): LifecycleExecutionContext {
	return registerLifecycleExecutionContext({
		mode: "hierarchical-v1",
		role: "worker",
		runId: "run-1",
		nodeId: "node-2",
		attemptId: "att-1",
		policyEpoch: 1,
		usableCapabilities: [
			{ source: "builtin", name: "task" },
			{ source: "builtin", name: "edit" },
			{ source: "builtin", name: "read" },
		],
		repoRoot: "/repo",
		readableRoots: ["src"],
		writableRoots: ["src/worker"],
		allowExternalWrite: false,
		...overrides,
	});
}

const worker = registerWorker();

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

	it("fails closed for an unregistered context, including a forged literal", () => {
		// The old structural context let any caller assert its own authority.
		// A literal is now simply absent from the registry.
		const forged = { runId: "run-1", nodeId: "node-2", attemptId: "att-1" } as unknown as LifecycleExecutionContext;
		const decision = authorizeLifecycleAction(forged, request("escalate_owner"));
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.code).toBe("missing_lifecycle_binding");
	});

	it("does not grant legacy mode a blanket allow", () => {
		// Previously `mode: "legacy-v0"` short-circuited to allowed: true
		// before any role or capability check ran.
		const legacy = registerWorker({ mode: "legacy-v0" });
		const decision = authorizeLifecycleAction(legacy, request("spawn_agent"));
		expect(decision.allowed).toBe(false);
	});

	it("fails closed when the registered binding lacks lifecycle identity", () => {
		const unbound = registerWorker({ attemptId: "" });
		const decision = authorizeLifecycleAction(unbound, request("escalate_owner"));
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.code).toBe("missing_lifecycle_binding");
	});

	it("fails closed after the context is revoked", () => {
		const revocable = registerWorker();
		expect(authorizeLifecycleAction(revocable, request("escalate_owner")).allowed).toBe(true);
		revokeLifecycleExecutionContext(revocable);
		const decision = authorizeLifecycleAction(revocable, request("escalate_owner"));
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.code).toBe("missing_lifecycle_binding");
	});

	it("does not turn revoked or forged parent authority into an unscoped child", () => {
		const parent = registerWorker({ role: "root-planner" });
		const child = { role: "worker" as const, nodeId: "child", attemptId: "child-attempt" };
		const registeredChild = deriveChildLifecycleContext(parent, child);
		expect(getLifecycleRegistration(registeredChild)?.role).toBe("worker");
		revokeLifecycleExecutionContext(parent);
		for (const invalidParent of [parent, {} as LifecycleExecutionContext]) {
			expect(() => deriveChildLifecycleContext(invalidParent, child)).toThrow("missing_lifecycle_binding");
		}
	});

	it("snapshots caller-owned capability and root arrays at registration", () => {
		const capability = { source: "builtin" as const, name: "read" };
		const usableCapabilities = [capability];
		const readableRoots = ["src"];
		const writableRoots = ["src"];
		const context = registerWorker({ usableCapabilities, readableRoots, writableRoots });
		capability.name = "bash";
		usableCapabilities.push({ source: "builtin", name: "write" });
		readableRoots.push("private");
		writableRoots.push("private");
		expect(authorizeLifecycleAction(context, request("invoke_tool", "read")).allowed).toBe(true);
		expect(authorizeLifecycleAction(context, request("invoke_tool", "bash")).allowed).toBe(false);
		expect(authorizeLifecycleAction(context, request("invoke_tool", "write")).allowed).toBe(false);
		for (const effect of ["read", "local-write"] as const) {
			expect(
				authorizeLifecycleAction(context, {
					...request("invoke_tool", "read"),
					effect,
					targets: ["private/secret"],
				}).allowed,
			).toBe(false);
		}
	});

	it("does not expose mutable authority through registration readback", () => {
		const context = registerWorker();
		const registration = getLifecycleRegistration(context)!;
		expect(Reflect.set(registration.usableCapabilities[0]!, "name", "bash")).toBe(false);
		expect(Reflect.set(registration.usableCapabilities, "0", { source: "builtin", name: "bash" })).toBe(false);
		expect(Reflect.set(registration.readableRoots, "0", ".")).toBe(false);
		expect(Reflect.set(registration.writableRoots, "0", ".")).toBe(false);
		expect(authorizeLifecycleAction(context, request("invoke_tool", "bash")).allowed).toBe(false);
		expect(
			authorizeLifecycleAction(context, {
				...request("invoke_tool", "read"),
				effect: "read",
				targets: ["private/secret"],
			}).allowed,
		).toBe(false);
	});

	it("denies a tool outside the registered capabilities, by source as well as name", () => {
		const denied = authorizeLifecycleAction(worker, request("invoke_tool", "bash"));
		expect(denied.allowed).toBe(false);
		if (!denied.allowed) expect(denied.code).toBe("capability_not_granted");

		// Same NAME, different source: not the tool that was granted.
		const wrongSource = authorizeLifecycleAction(worker, {
			tool: { source: "mcp", name: "edit" },
			action: "invoke_tool",
			targets: [],
			effect: "control",
			invocationId: "inv-source",
		});
		expect(wrongSource.allowed).toBe(false);
		if (!wrongSource.allowed) expect(wrongSource.code).toBe("capability_not_granted");
	});

	it("enforces read and write roots separately on real targets", () => {
		const readOk = authorizeLifecycleAction(worker, {
			tool: { source: "builtin", name: "read" },
			action: "read_resource",
			targets: ["src/other/thing.ts"],
			effect: "read",
			invocationId: "inv-read",
		});
		expect(readOk.allowed).toBe(true);

		// Readable but NOT writable: broad read plus narrow write must stay
		// distinct rather than collapsing into one scope.
		const writeDenied = authorizeLifecycleAction(worker, {
			tool: { source: "builtin", name: "edit" },
			action: "write_resource",
			targets: ["src/other/thing.ts"],
			effect: "local-write",
			invocationId: "inv-write",
		});
		expect(writeDenied.allowed).toBe(false);
		if (!writeDenied.allowed) expect(writeDenied.code).toBe("target_outside_scope");

		const writeOk = authorizeLifecycleAction(worker, {
			tool: { source: "builtin", name: "edit" },
			action: "write_resource",
			targets: ["src/worker/thing.ts"],
			effect: "local-write",
			invocationId: "inv-write-ok",
		});
		expect(writeOk.allowed).toBe(true);
	});

	it("denies a traversal target even when its lexical prefix looks in-scope", () => {
		const decision = authorizeLifecycleAction(worker, {
			tool: { source: "builtin", name: "edit" },
			action: "write_resource",
			targets: ["src/worker/../../etc/passwd"],
			effect: "local-write",
			invocationId: "inv-traverse",
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.code).toBe("target_outside_scope");
	});

	it("denies external writes unless explicitly granted", () => {
		const denied = authorizeLifecycleAction(worker, {
			tool: { source: "builtin", name: "edit" },
			action: "publish",
			targets: ["src/worker/thing.ts"],
			effect: "external-write",
			invocationId: "inv-publish",
		});
		expect(denied.allowed).toBe(false);

		// Even with the flag, the ACTION must be an external-write action.
		const publisher = registerWorker({ role: "root-planner", allowExternalWrite: true });
		const wrongAction = authorizeLifecycleAction(publisher, {
			tool: { source: "builtin", name: "edit" },
			action: "read_resource",
			targets: ["src/worker/thing.ts"],
			effect: "external-write",
			invocationId: "inv-publish-2",
		});
		expect(wrongAction.allowed).toBe(false);
		if (!wrongAction.allowed) expect(wrongAction.code).toBe("external_write_not_granted");
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
