/**
 * LC20 (R): entry points expose a registered contract + binding before the
 * first child request; a missing or unauthorized binding denies.
 *
 * First seam: the TaskTool spawn path. When the session carries a
 * host-registered lifecycle context, the spawn must be authorized BEFORE any
 * allocation work. When no context is registered, legacy behavior is
 * unchanged. These are live seam tests against the real TaskTool with a
 * stubbed discovery layer — not source-text assertions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@pk-nerdsaver-ai/pi-coding-agent/async/job-manager";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import {
	createHostRootExecutionContext,
	deriveChildLifecycleContext,
	type LifecycleExecutionContext,
	type RootExecutionContext,
	registerLifecycleExecutionContext,
	revokeLifecycleExecutionContext,
} from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/lifecycle-authority";
import { AgentLifecycleManager } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@pk-nerdsaver-ai/pi-coding-agent/task";
import * as discoveryModule from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import * as executorModule from "@pk-nerdsaver-ai/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";
import type { IsolationHandle, WorktreeBaseline } from "@pk-nerdsaver-ai/pi-coding-agent/task/worktree";
import * as worktreeModule from "@pk-nerdsaver-ai/pi-coding-agent/task/worktree";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { getAgentDir, setAgentDir, TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { createTestEnvelope, createTestPolicy, createTestSpawnAuthority } from "../helpers/lifecycle-fixtures";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	tools: ["read"],
	source: "bundled",
};

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

describe("LC20: TaskTool spawn seam under a registered lifecycle context", () => {
	const managers: AsyncJobManager[] = [];

	function createSession(
		contextAccessor?: () => LifecycleExecutionContext | undefined,
		issuerAccessor?: () => RootExecutionContext | undefined,
		settingsOverrides: Record<string, unknown> = {},
	): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({
				// An explicit type policy activates the constrained tool-ceiling
				// path, so the spawn requests exactly the [read, yield] ceiling the
				// test root envelope delegates; an unrestricted spawn would request
				// the full tier catalog, which no fixture envelope may cover.
				"task.agentPolicies": { task: { tier: "mid" } },
				...settingsOverrides,
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getModelString: () => "anthropic/claude-sonnet-4-5",
			getLifecycleExecutionContext: contextAccessor,
			getLifecycleIssuerContext: issuerAccessor,
		} as unknown as ToolSession;
	}

	/**
	 * Durable root issuer (§14.6): a host-branded RootExecutionContext whose
	 * envelope delegates exactly the test agent's declared tool ceiling — the
	 * same shape installRootIssuerContext mints for an interactive session.
	 */
	function createRootIssuer(sessionId: string): RootExecutionContext {
		const capabilities = [
			{ source: "builtin" as const, name: "read" },
			{ source: "builtin" as const, name: "yield" },
		];
		return createHostRootExecutionContext({
			sessionId,
			policy: createTestPolicy({ role: "root-planner" }),
			authority: createTestEnvelope({
				usableCapabilities: Object.freeze(capabilities),
				delegableCapabilities: Object.freeze(capabilities),
				// A root planner IS the issuer, and the issuer's own spawn
				// envelope is what admission narrows against. The shared
				// fixture defaults to a leaf (maySpawn false), so a root
				// must delegate explicitly — mirroring the envelope
				// installRootIssuerContext mints for a real session.
				spawn: createTestSpawnAuthority({
					maySpawn: true,
					mayDelegateSpawn: true,
					allowedAgentTypes: Object.freeze(["*"]),
					allowedLaunchClasses: Object.freeze(["legacy-compatible-worker"]),
					maxDepth: 4,
					maxChildren: 16,
				}),
			}),
		});
	}

	// The durable admission builder opens the process-lifetime operational
	// store lazily under the agent dir; redirect it before the first bound
	// spawn so test admissions write to a temp DB, not the operator's store.
	let agentDir: TempDir;
	let originalAgentDir: string;
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		originalAgentDir = getAgentDir();
		agentDir = TempDir.createSync("@lc20-entrypoints-");
		setAgentDir(agentDir.path());
	});

	afterEach(async () => {
		setAgentDir(originalAgentDir);
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		// The process-lifetime admission store keeps its SQLite WAL open by
		// design, so the temp dir may still be locked on Windows; removal is
		// best-effort (the OS temp cleaner reclaims it).
		try {
			agentDir.removeSync();
		} catch {
			// store handle still open — leave the dir
		}
	});

	it("denies a worker's spawn before any subprocess allocation", async () => {
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));

		// A leaf worker holding an otherwise full capability set: the role
		// alone must refuse delegation, no matter what tools it can use.
		const worker = registerLifecycleExecutionContext({
			mode: "hierarchical-v1",
			role: "worker",
			runId: "run-1",
			nodeId: "node-worker",
			attemptId: "att-1",
			policyEpoch: 1,
			usableCapabilities: [{ source: "builtin", name: "task" }],
			repoRoot: "/tmp",
			readableRoots: ["src"],
			writableRoots: ["src"],
			allowExternalWrite: false,
		});

		const tool = await TaskTool.create(createSession(() => worker));
		const result = await tool.execute("tc-worker-spawn", {
			agent: "task",
			id: "Denied",
			description: "worker tries to delegate",
			assignment: "Do the thing.",
		} as TaskParams);

		const text = (result.content.find(part => part.type === "text") as { text?: string } | undefined)?.text ?? "";
		expect(text).toContain("lifecycle authority");
		expect(text).toContain("leaf_delegation_denied");
		// Denied BEFORE allocation: no subprocess, no output reservation.
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("denies an unregistered (forged) context rather than trusting its shape", async () => {
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));

		const forged = { role: "root-planner" } as unknown as LifecycleExecutionContext;
		const tool = await TaskTool.create(createSession(() => forged));

		const result = await tool.execute("tc-forged", {
			agent: "task",
			id: "Forged",
			description: "structurally identical object",
			assignment: "Do the thing.",
		} as TaskParams);

		const text = (result.content.find(part => part.type === "text") as { text?: string } | undefined)?.text ?? "";
		expect(text).toContain("missing_lifecycle_binding");
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("permits a root-planner's spawn through the guard", async () => {
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));

		// A durable root issuer carries the admission: the plain in-memory
		// registration has no root/bound identity, so it cannot mint a
		// durable child contract. The issuer slot (never the bound-context
		// slot) is where a host installs the root handle.
		const issuer = createRootIssuer("lc20-permit-root");

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await TaskTool.create(createSession(undefined, () => issuer));

		const result = await tool.execute("tc-planner-spawn", {
			agent: "task",
			id: "Allowed",
			description: "root planner delegates",
			assignment: "Do the thing.",
		} as TaskParams);

		const text = (result.content.find(part => part.type === "text") as { text?: string } | undefined)?.text ?? "";
		// The guard passed: the spawn ran synchronously and completed, with
		// no denial from the lifecycle authority.
		expect(text).toContain("All done.");
		expect(text).not.toContain("lifecycle authority");
		expect(runSpy).toHaveBeenCalled();
	});

	it("quarantines a bound isolated workspace when subprocess startup rejects before capture", async () => {
		const baseline: WorktreeBaseline = {
			root: {
				repoRoot: "/tmp",
				headCommit: "HEAD",
				staged: "",
				unstaged: "",
				untracked: [],
				untrackedPatch: "",
			},
			nested: [],
		};
		const isolation: IsolationHandle = {
			mergedDir: "/tmp/lifecycle-rejected-workspace",
			backend: worktreeModule.parseIsolationMode("rcopy")!,
			fellBack: false,
			fallbackReason: null,
		};
		vi.spyOn(worktreeModule, "getRepoRoot").mockResolvedValue("/tmp");
		vi.spyOn(worktreeModule, "captureBaseline").mockResolvedValue(baseline);
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue(isolation);
		const cleanup = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue(undefined);
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockRejectedValue(new Error("pinned provider unavailable"));
		const issuer = createRootIssuer("lc20-rejected-isolation-root");
		const tool = await TaskTool.create(
			createSession(undefined, () => issuer, {
				"async.enabled": false,
				"task.isolation.mode": "auto",
			}),
		);

		const result = await tool.execute("tc-rejected-isolation", {
			agent: "task",
			id: "RejectedIsolation",
			description: "bound child startup fails",
			assignment: "Do the thing.",
			isolated: true,
		} as TaskParams);

		const text = (result.content.find(part => part.type === "text") as { text?: string } | undefined)?.text ?? "";
		expect(text).toContain("pinned provider unavailable");
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(cleanup).not.toHaveBeenCalled();
	});

	it("does not launch an unscoped subprocess when the parent is revoked during preparation", async () => {
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));
		const parent = registerLifecycleExecutionContext({
			mode: "hierarchical-v1",
			role: "root-planner",
			runId: "revoked-run",
			nodeId: "revoked-root",
			attemptId: "revoked-attempt",
			policyEpoch: 1,
			usableCapabilities: [{ source: "builtin", name: "task" }],
			repoRoot: "/tmp",
			readableRoots: ["src"],
			writableRoots: ["src"],
			allowExternalWrite: false,
		});
		let armed = false;
		const tool = await TaskTool.create(
			createSession(() => {
				if (armed) {
					armed = false;
					queueMicrotask(() => revokeLifecycleExecutionContext(parent));
				}
				return parent;
			}),
		);
		armed = true;
		const result = await tool.execute("tc-revoked-preparation", {
			agent: "task",
			id: "Revoked",
			description: "parent revoked after initial admission",
			assignment: "Do the thing.",
		} as TaskParams);
		const text = result.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("\n");
		expect(text).toContain("missing_lifecycle_binding");
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("leaves the legacy path unchanged when no context is registered", async () => {
		const runSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => makeResult(options.id ?? "?"));

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		// No getLifecycleExecutionContext accessor at all: the pre-W3 shape.
		const tool = await TaskTool.create(createSession());

		const result = await tool.execute("tc-legacy", {
			agent: "task",
			id: "Legacy",
			description: "legacy path",
			assignment: "Do the thing.",
		} as TaskParams);
		const text = (result.content.find(part => part.type === "text") as { text?: string } | undefined)?.text ?? "";
		// Legacy behavior is byte-identical: completes, no authority involved.
		expect(text).toContain("All done.");
		expect(runSpy).toHaveBeenCalled();
	});

	it("derives a worker context for the child, bounding recursion end to end", async () => {
		let capturedChildContext: LifecycleExecutionContext | undefined;
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			// Capture the child context the executor receives; this is what
			// the child session's ToolSession will expose.
			capturedChildContext = options.lifecycle;
			return makeResult(options.id ?? "?");
		});

		// The parent issues from a durable root: admission mints a BOUND
		// child context (contract + binding recorded in the temp operational
		// store), and that bound context is what the executor receives.
		const issuer = createRootIssuer("lc20-derive-root");
		const tool = await TaskTool.create(createSession(undefined, () => issuer));
		const result = await tool.execute("tc-derive", {
			agent: "task",
			id: "Child",
			description: "planner spawns a worker",
			assignment: "Do the thing.",
		} as TaskParams);

		const text = (result.content.find(part => part.type === "text") as { text?: string } | undefined)?.text ?? "";
		// The parent's spawn succeeded...
		expect(text).toContain("All done.");
		expect(runSpy).toHaveBeenCalled();

		// ...and the child received a REGISTERED context whose role is worker.
		expect(capturedChildContext).toBeDefined();
		const grandchildContext = deriveChildLifecycleContext(capturedChildContext as LifecycleExecutionContext, {
			role: "worker",
			nodeId: "node-grandchild",
			attemptId: "attempt-grandchild",
		});
		expect(grandchildContext).toBeDefined();

		// The child, holding that worker context, cannot spawn: recursion is
		// bounded end to end, not just at the top seam.
		const childTool = await TaskTool.create(createSession(() => capturedChildContext as LifecycleExecutionContext));
		const denied = await childTool.execute("tc-grandchild", {
			agent: "task",
			id: "Denied2",
			description: "worker tries to spawn again",
			assignment: "Do the thing.",
		} as TaskParams);
		const deniedText =
			(denied.content.find(part => part.type === "text") as { text?: string } | undefined)?.text ?? "";
		expect(deniedText).toContain("leaf_delegation_denied");
	});
});
