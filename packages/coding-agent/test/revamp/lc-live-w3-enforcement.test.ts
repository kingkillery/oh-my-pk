/**
 * LC live suite (W3): durable bound-context enforcement end to end.
 *
 * Every test here exercises the REAL enforcement seams against bindings that
 * were actually admitted into an operational store — no source-text
 * assertions, no mocks of the authority/projection logic itself:
 *
 *   1. Dispatch semantics — a durably bound child context authorizes tool
 *      invocations through the production wrappers (LifecycleToolWrapper /
 *      ExtensionToolWrapper with a real ExtensionRunner): granted capability
 *      runs, undeclared semantics fail `undeclared_tool_semantics`, ungranted
 *      capabilities fail `capability_not_granted`, and a denial is thrown
 *      outside the tool_result hook path so no hook can override it.
 *   2. Spawn binding — the real TaskTool spawn path under a root issuer
 *      produces a bound child (registration.authority → launch_bindings row);
 *      a legacy parent produces a legacy child; a bound worker child cannot
 *      spawn (leaf_delegation_denied before any allocation).
 *   3. Projection — a bound session's provider request projects through
 *      projectLifecycleSideRequest (real Context + manifest sidecar + tool
 *      ceiling); revoked/unbound sessions fail closed; an onPayload mutator
 *      is rejected `unprojectable_provider_hook` through the real
 *      createAgentSession stream path (mock provider, no network).
 *   4. Eval kernel scoping — a bound child omits parentEvalSessionId so the
 *      executor scopes its kernel to its own session file; a legacy child
 *      still inherits the parent's.
 *   5. Revive/replay — activateBoundSessionAuthority re-binds the SAME
 *      persisted binding (no second launch_bindings row) and the revived
 *      context projects; a forged pin fails lifecycle_authority_mismatch.
 *
 * Live provider-wire acceptance (real LLM calls) is intentionally NOT
 * claimed: the provider seam is covered with the registered mock API.
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Context, Model, Tool } from "@pk-nerdsaver-ai/pi-ai";
import { createMockModel, registerMockApi } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { getAgentDir, removeWithRetries, setAgentDir, TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import type { ExtensionFactory } from "../../src/extensibility/extensions/types";
import { ExtensionToolWrapper, LifecycleToolWrapper } from "../../src/extensibility/extensions/wrapper";
import { OperationalStore } from "../../src/operational/store";
import {
	activateBoundSessionAuthority,
	getLifecycleProjectionBinding,
	getProjectionManifest,
	LifecycleProjectionError,
	projectLifecycleSideRequest,
	unbindLifecycleProjection,
} from "../../src/orchestration/context-projector";
import {
	createHostRootExecutionContext,
	getLifecycleRegistration,
	type LifecycleExecutionContext,
	type RootExecutionContext,
	revokeLifecycleExecutionContext,
} from "../../src/orchestration/lifecycle-authority";
import { createLifecycleToolGuard, LifecycleAuthorizationError } from "../../src/orchestration/lifecycle-tool-guard";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { TaskTool } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import { type CompiledLaunchContract, type LaunchBinding, sha256Hex } from "../../src/task/launch-contract";
import {
	admissionStore,
	admitBoundChildLaunch,
	captureLaunchBaseline,
	LAUNCH_ENTRY_POINTS,
} from "../../src/task/spawn-admission";
import { createSpawnPlan } from "../../src/task/spawn-plan";
import type { AgentDefinition, SingleResult, TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import type { ResolvedToolProfile } from "../../src/tools/tool-profiles";
import { EventBus } from "../../src/utils/event-bus";
import {
	createTestCollaborationPolicy,
	createTestEnvelope,
	createTestExecutionProfile,
	createTestPolicy,
	createTestSpawnAuthority,
	createTestToolProfile,
} from "../helpers/lifecycle-fixtures";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Capabilities the test root issuer delegates; bound children narrow into it. */
const ISSUER_CAPABILITIES = Object.freeze([
	{ source: "builtin" as const, name: "read" },
	{ source: "builtin" as const, name: "probe" },
	{ source: "builtin" as const, name: "yield" },
]);

/** The bound child's usable ceiling: read + probe (bash is deliberately absent). */
const CHILD_CAPABILITIES = Object.freeze([
	{ source: "builtin" as const, name: "read" },
	{ source: "builtin" as const, name: "probe" },
]);

function createRootIssuer(sessionId: string): RootExecutionContext {
	return createHostRootExecutionContext({
		sessionId,
		policy: createTestPolicy({ role: "root-planner" }),
		authority: createTestEnvelope({
			usableCapabilities: ISSUER_CAPABILITIES,
			delegableCapabilities: ISSUER_CAPABILITIES,
			spawn: createTestSpawnAuthority({
				maySpawn: true,
				mayDelegateSpawn: true,
				allowedAgentTypes: ["*"],
				allowedLaunchClasses: ["strict-worker", "privileged-helper", "legacy-compatible-worker"],
				maxDepth: 4,
				maxChildren: 16,
			}),
		}),
	});
}

function childToolProfile(): ResolvedToolProfile {
	return Object.freeze({ ...createTestToolProfile(), maximum: CHILD_CAPABILITIES });
}

const childAgent: AgentDefinition = {
	name: "task",
	description: "Bound child worker",
	systemPrompt: "You are a bound worker.",
	tools: ["read"],
	source: "bundled",
};

interface BoundChild {
	readonly context: LifecycleExecutionContext;
	readonly binding: LaunchBinding;
	readonly contract: CompiledLaunchContract;
}

/**
 * Admit a real bound child through the production spawn-admission path
 * (compile → admitLaunchAuthority → activateLaunchBinding →
 * activateBoundSessionAuthority) against a caller-supplied store.
 */
async function admitBoundChild(
	store: OperationalStore,
	issuer: LifecycleExecutionContext | RootExecutionContext,
	repoRoot: string,
	idem: string,
): Promise<BoundChild> {
	const planned = createSpawnPlan({
		correlationId: `lc-${idem}`,
		agentName: "task",
		assignment: "Bound child assignment.",
		profile: createTestExecutionProfile(),
	});
	if (!planned.ok) {
		throw new Error(`spawn plan rejected: ${planned.diagnostics.map(d => d.message).join("; ")}`);
	}
	const admission = admitBoundChildLaunch({
		issuer,
		store,
		spawnPlan: planned.plan,
		entryPoint: LAUNCH_ENTRY_POINTS.taskSpawn,
		reason: "lc live suite bound child",
		agentName: "task",
		assignment: "Bound child assignment.",
		agentDefinition: childAgent,
		executionProfile: planned.plan.profile,
		toolProfile: childToolProfile(),
		collaborationPolicy: createTestCollaborationPolicy(),
		repoRoot,
		baseline: await captureLaunchBaseline(repoRoot),
		idempotencyKey: `lc-${idem}`,
		sessionId: `session-lc-${idem}`,
		artifactManager: { getPath: () => Promise.resolve(null) },
		// Source-qualify the child's tools; anything else is provably foreign.
		toolSourceOf: name => (name === "read" || name === "probe" ? "builtin" : "custom"),
	});
	if (!admission.ok) {
		throw new Error(`admission failed (${admission.code}): ${admission.diagnostics.map(d => d.message).join("; ")}`);
	}
	return { context: admission.context, binding: admission.binding, contract: admission.contract };
}

/** Records every invocation so "ran before the guard" is observable. */
function createProbeTool(name: string, executions: string[], approval: unknown = "exec"): AgentTool {
	return {
		name,
		label: name,
		description: `${name} probe`,
		parameters: type({ value: "string" }),
		strict: true,
		approval,
		async execute(toolCallId: string) {
			executions.push(`${name}:${toolCallId}`);
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as unknown as AgentTool;
}

function textOf(result: AgentToolResult): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function countBindings(dbPath: string): number {
	const raw = new Database(dbPath, { readonly: true });
	try {
		const row = raw.prepare("SELECT COUNT(*) AS n FROM launch_bindings").get() as { n: number };
		return row.n;
	} finally {
		raw.close();
	}
}

// ---------------------------------------------------------------------------
// 1. Dispatch semantics under a durable bound context
// ---------------------------------------------------------------------------

describe("LC live: dispatch semantics under a durable bound context", () => {
	let dir: TempDir;
	let store: OperationalStore;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		const authDir = TempDir.createSync("@lc-dispatch-auth-");
		authStorage = await AuthStorage.create(path.join(authDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(authDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
	});

	beforeEach(() => {
		dir = TempDir.createSync("@lc-dispatch-");
		store = OperationalStore.open({ dbPath: path.join(dir.path(), "op.db") });
	});

	afterEach(async () => {
		store.close();
		await removeWithRetries(dir.path()).catch(() => {});
	});

	it("authorizes a granted capability and fails undeclared/ungranted invocations closed", async () => {
		const issuer = createRootIssuer("lc-dispatch-root-1");
		const { context, binding, contract } = await admitBoundChild(store, issuer, dir.path(), "dispatch-1");

		// The context under test is durably bound — not an in-memory registration.
		const registration = getLifecycleRegistration(context);
		expect(registration?.authority?.bindingId).toBe(binding.bindingId);
		expect(binding.state).toBe("bound");

		// Contract refs name persisted bytes rather than symbolic hashes. The
		// template and runtime probe also pin those bytes directly.
		for (const ref of [contract.policy.harnessRef, contract.policy.environmentRef]) {
			expect(ref).toStartWith("file://");
			expect(await Bun.file(ref.slice("file://".length)).exists()).toBe(true);
		}
		const templateRef = contract.authority.agentTemplateRef;
		const templateBytes = await Bun.file(templateRef.uri.slice("file://".length)).text();
		expect(sha256Hex(templateBytes)).toBe(templateRef.sha256);
		expect(Buffer.byteLength(templateBytes, "utf8")).toBe(templateRef.bytes);
		const harness = await Bun.file(contract.policy.harnessRef.slice("file://".length)).json();
		expect(harness).toMatchObject({ schemaVersion: 1, agentTemplateDigest: templateRef.sha256 });
		const environment = await Bun.file(contract.policy.environmentRef.slice("file://".length)).json();
		expect(environment).toMatchObject({
			schemaVersion: 1,
			workspace: { baselineManifestHash: contract.policy.baseline.manifestHash },
		});
		const probeRef = binding.guaranteeEvidenceRefs[0]!;
		const probeBytes = await Bun.file(probeRef.uri.slice("file://".length)).text();
		expect(sha256Hex(probeBytes)).toBe(probeRef.sha256);
		expect(JSON.parse(probeBytes)).toMatchObject({
			schemaVersion: 1,
			observations: {
				workspaceExists: true,
				filesystemApiAvailable: true,
				processApiAvailable: true,
				networkApiAvailable: true,
				environmentApiAvailable: true,
				isolationBoundary: "cooperative-worktree",
			},
			guarantees: binding.actualRuntimeGuarantees,
		});

		const executions: string[] = [];

		// Granted exec-tier capability: authorized against the contract's
		// usable set and the tool actually runs.
		const probe = createProbeTool("probe", executions);
		const granted = new LifecycleToolWrapper(
			probe,
			createLifecycleToolGuard(() => context, "builtin", probe),
		);
		const result = await granted.execute("call-ok", { value: "x" }, undefined, undefined, {} as AgentToolContext);
		expect(textOf(result)).toContain("probe executed");

		// Declared exec-tier tool outside the capability set.
		const bash = createProbeTool("bash", executions);
		const denied = new LifecycleToolWrapper(
			bash,
			createLifecycleToolGuard(() => context, "builtin", bash),
		);
		await expect(
			denied.execute("call-denied", { value: "x" }, undefined, undefined, {} as AgentToolContext),
		).rejects.toThrow(/capability_not_granted/);

		// No declared semantics and no adapter entry: fail closed.
		const undeclared = createProbeTool("probe", executions);
		delete undeclared.approval;
		const undeclaredWrapped = new LifecycleToolWrapper(
			undeclared,
			createLifecycleToolGuard(() => context, "builtin", undeclared),
		);
		await expect(
			undeclaredWrapped.execute("call-undeclared", { value: "x" }, undefined, undefined, {} as AgentToolContext),
		).rejects.toThrow(/undeclared_tool_semantics/);

		// Declared read semantics on a granted tool: the contract admits no
		// readable scope, so containment denies the path target.
		const read = createProbeTool("read", executions, "read");
		const readWrapped = new LifecycleToolWrapper(
			read,
			createLifecycleToolGuard(() => context, "builtin", read),
		);
		await expect(
			readWrapped.execute(
				"call-read",
				{ value: "x", path: "src/a.ts" },
				undefined,
				undefined,
				{} as AgentToolContext,
			),
		).rejects.toThrow(/target_outside_scope/);

		expect(executions).toEqual(["probe:call-ok"]);
	});

	it("denial is not overridable by tool_result hooks on the real extension path", async () => {
		const issuer = createRootIssuer("lc-dispatch-root-2");
		const { context } = await admitBoundChild(store, issuer, dir.path(), "dispatch-2");

		// Real ExtensionRunner with a real registered extension whose
		// tool_result hook would clear ANY error it ever saw.
		const runtime = new ExtensionRuntime();
		const observed: string[] = [];
		const factory: ExtensionFactory = api => {
			api.on("tool_call", () => {
				observed.push("tool_call");
				return undefined;
			});
			api.on("tool_result", () => {
				observed.push("tool_result");
				return { isError: false, content: [{ type: "text", text: "cleared" }] };
			});
		};
		const extension = await loadExtensionFromFactory(factory, dir.path(), new EventBus(), runtime, "<lc-ext>");
		const runner = new ExtensionRunner([extension], runtime, dir.path(), SessionManager.inMemory(), modelRegistry);

		const executions: string[] = [];
		const bash = createProbeTool("bash", executions);
		const wrapped = new ExtensionToolWrapper(
			bash,
			runner,
			createLifecycleToolGuard(() => context, "builtin", bash),
		);

		const denial = wrapped.execute("call-hook", { value: "x" }, undefined, undefined, {} as AgentToolContext);
		await expect(denial).rejects.toBeInstanceOf(LifecycleAuthorizationError);
		await denial.catch((error: unknown) => {
			if (error instanceof LifecycleAuthorizationError) expect(error.code).toBe("capability_not_granted");
		});
		// The denial threw before tool_call and tool_result ever observed the
		// call — there is no result path a hook could rewrite into success.
		expect(observed).toEqual([]);
		expect(executions).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 2 + 4. Spawn binding and eval kernel scoping through the real TaskTool seam
// ---------------------------------------------------------------------------

describe("LC live: TaskTool spawn binding and eval kernel scoping", () => {
	const managers: AsyncJobManager[] = [];
	let agentDir: TempDir;
	let originalAgentDir: string;

	function createSession(options: {
		context?: () => LifecycleExecutionContext | undefined;
		issuer?: () => RootExecutionContext | undefined;
		evalSessionId?: string;
	}): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({
				// Constrained tool ceiling so the spawn requests exactly the
				// [read, yield] ceiling the issuer envelope delegates.
				"task.agentPolicies": { task: { tier: "mid" } },
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getModelString: () => "anthropic/claude-sonnet-4-5",
			getLifecycleExecutionContext: options.context,
			getLifecycleIssuerContext: options.issuer,
			getEvalSessionId: options.evalSessionId ? () => options.evalSessionId! : undefined,
		} as unknown as ToolSession;
	}

	function spawnParams(id: string): TaskParams {
		return {
			agent: "task",
			id,
			description: `${id} spawn`,
			assignment: "Do the thing.",
		} as TaskParams;
	}

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

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [childAgent],
			projectAgentsDir: null,
		});
		// admissionStore() is a process-lifetime handle opened lazily under the
		// agent dir; redirect before the first bound spawn.
		originalAgentDir = getAgentDir();
		agentDir = TempDir.createSync("@lc-spawn-");
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
		try {
			agentDir.removeSync();
		} catch {
			// store handle still open — leave the dir for the OS cleaner
		}
	});

	it("a root-issued spawn produces a durably bound child with a scoped eval kernel", async () => {
		let captured: { lifecycle?: LifecycleExecutionContext; parentEvalSessionId?: string } = {};
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured = { lifecycle: options.lifecycle, parentEvalSessionId: options.parentEvalSessionId };
			return makeResult(options.id ?? "?");
		});

		const issuer = createRootIssuer("lc-spawn-root");
		const tool = await TaskTool.create(createSession({ issuer: () => issuer, evalSessionId: "parent-eval-session" }));
		const result = await tool.execute("tc-lc-bound", spawnParams("BoundChild"));
		const text = (result.content.find(part => part.type === "text") as { text?: string } | undefined)?.text ?? "";
		expect(text).toContain("All done.");
		expect(runSpy).toHaveBeenCalled();

		// The child context the executor received is durably bound: its
		// registration carries a real authority ref that resolves to a live
		// launch_bindings row in the admission store.
		const child = captured.lifecycle;
		expect(child).toBeDefined();
		const registration = getLifecycleRegistration(child as LifecycleExecutionContext);
		if (!registration?.authority) throw new Error("expected a durably bound child registration");
		const bindingId = registration.authority.bindingId;
		const binding = admissionStore().getLaunchBinding(bindingId);
		expect(binding.state).toBe("bound");
		expect(binding.attemptId).toBe(registration.attemptId);
		expect(binding.sessionId).toBe("session-BoundChild");
		// The same row is reachable by attempt — the revive seam resolves it.
		expect(admissionStore().getLaunchBindingByAttempt(binding.attemptId).bindingId).toBe(binding.bindingId);
		// The projection binding is attached so provider requests project.
		expect(getLifecycleProjectionBinding(child as LifecycleExecutionContext)?.bindingId).toBe(binding.bindingId);
		// Eval kernel scoping: the bound child does NOT inherit the parent's
		// shared eval session — the executor scopes it to its own session file.
		expect(captured.parentEvalSessionId).toBeUndefined();
	});

	it("a legacy parent produces a legacy child that inherits the parent eval session", async () => {
		let captured: { lifecycle?: LifecycleExecutionContext; parentEvalSessionId?: string } = {};
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured = { lifecycle: options.lifecycle, parentEvalSessionId: options.parentEvalSessionId };
			return makeResult(options.id ?? "?");
		});

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		// No lifecycle accessors at all: the pre-W3 legacy path.
		const tool = await TaskTool.create(createSession({ evalSessionId: "parent-eval-session" }));
		const result = await tool.execute("tc-lc-legacy", spawnParams("LegacyChild"));
		const text = (result.content.find(part => part.type === "text") as { text?: string } | undefined)?.text ?? "";
		expect(text).toContain("All done.");
		expect(runSpy).toHaveBeenCalled();
		expect(captured.lifecycle).toBeUndefined();
		expect(captured.parentEvalSessionId).toBe("parent-eval-session");
	});

	it("a bound worker child cannot spawn (leaf_delegation_denied before allocation)", async () => {
		const dir = TempDir.createSync("@lc-leaf-");
		const store = OperationalStore.open({ dbPath: path.join(dir.path(), "op.db") });
		try {
			const issuer = createRootIssuer("lc-leaf-root");
			const { context: workerContext } = await admitBoundChild(store, issuer, dir.path(), "leaf-1");
			expect(getLifecycleRegistration(workerContext)?.role).toBe("worker");

			const runSpy = vi
				.spyOn(executorModule, "runSubprocess")
				.mockImplementation(async options => makeResult(options.id ?? "?"));
			const tool = await TaskTool.create(createSession({ context: () => workerContext }));
			const denied = await tool.execute("tc-lc-leaf", spawnParams("Grandchild"));
			const text = (denied.content.find(part => part.type === "text") as { text?: string } | undefined)?.text ?? "";
			expect(text).toContain("leaf_delegation_denied");
			expect(runSpy).not.toHaveBeenCalled();
		} finally {
			store.close();
			await removeWithRetries(dir.path()).catch(() => {});
		}
	});
});

// ---------------------------------------------------------------------------
// 3. Provider projection seam
// ---------------------------------------------------------------------------

describe("LC live: provider projection seam", () => {
	let dir: TempDir;
	let store: OperationalStore;
	let authStorage: AuthStorage;

	beforeAll(() => {
		try {
			registerMockApi();
		} catch {
			// already registered by another suite in this process
		}
	});

	beforeEach(async () => {
		dir = TempDir.createSync("@lc-project-");
		store = OperationalStore.open({ dbPath: path.join(dir.path(), "op.db") });
		authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("mock", "test-key");
	});

	afterEach(async () => {
		store.close();
		authStorage.close();
		await removeWithRetries(dir.path()).catch(() => {});
	});

	function wireTool(name: string): Tool {
		return {
			name,
			description: `${name} tool`,
			parameters: { type: "object", properties: {} },
		} as unknown as Tool;
	}

	it("projects a bound session's side request with a manifest sidecar and tool ceiling", async () => {
		const issuer = createRootIssuer("lc-project-root-1");
		const { context, binding, contract } = await admitBoundChild(store, issuer, dir.path(), "project-1");

		const request: Context = {
			systemPrompt: ["bound system prompt"],
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [wireTool("read"), wireTool("bash")],
		};
		const projected = await projectLifecycleSideRequest(request, "completion", context);

		// Caller structure is preserved verbatim; only tools are rewritten to
		// the authorized subset (bash is outside the contract's usable set).
		expect(projected.systemPrompt).toEqual(["bound system prompt"]);
		expect(projected.messages).toHaveLength(1);
		expect(projected.tools?.map(tool => tool.name)).toEqual(["read"]);

		const manifest = getProjectionManifest(projected);
		expect(manifest).toBeDefined();
		expect(manifest?.phase).toBe("side-request");
		expect(manifest?.launchHash).toBe(contract.contractDigest);
		expect(manifest?.policyHash).toBe(contract.policyHash);
		expect(manifest?.grantGeneration).toBe(binding.policyEpoch);
		expect(manifest?.admitted.map(entry => entry.fragmentId)).toEqual(
			expect.arrayContaining(["sys:0", "msg:0:user"]),
		);
		expect(manifest?.rejected).toContainEqual({ fragmentId: "tool:custom:bash", code: "tool_not_authorized" });
	});

	it("fails closed for revoked, unbound and forged sessions", async () => {
		const issuer = createRootIssuer("lc-project-root-2");
		const { context } = await admitBoundChild(store, issuer, dir.path(), "project-2");
		const request: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

		// Unbound: registered context whose projection binding was dropped.
		unbindLifecycleProjection(context);
		await expect(projectLifecycleSideRequest(request, "compact", context)).rejects.toBeInstanceOf(
			LifecycleProjectionError,
		);
		await expect(projectLifecycleSideRequest(request, "compact", context)).rejects.toThrow(/untrusted_context/);

		// Revoked: the context registration itself is gone.
		revokeLifecycleExecutionContext(context);
		await expect(projectLifecycleSideRequest(request, "compact", context)).rejects.toThrow(/untrusted_context/);

		// Forged: a structurally identical object was never registered.
		const forged = {} as LifecycleExecutionContext;
		await expect(projectLifecycleSideRequest(request, "compact", forged)).rejects.toThrow(/untrusted_context/);

		// Explicit legacy path: absent lifecycle passes through unchanged.
		const passthrough = await projectLifecycleSideRequest(request, "compact", null);
		expect(passthrough).toBe(request);
	});

	it("rejects an unprojectable onPayload mutator through the real session stream path", async () => {
		const issuer = createRootIssuer("lc-project-root-3");
		const { context } = await admitBoundChild(store, issuer, dir.path(), "project-3");

		// A real extension whose before_provider_request handler MUTATES the
		// payload — under a bound lifecycle the real sdk onPayload closure must
		// reject it as unprojectable_provider_hook before any wire bytes form.
		const captured: { payloadError?: unknown; payloadResult?: unknown } = {};
		const mutatingFactory: ExtensionFactory = api => {
			api.on("before_provider_request", () => ({ injected: "late-write" }));
		};
		const mock = createMockModel({
			provider: "mock",
			handler: async (_ctx, options) => {
				try {
					captured.payloadResult = await options?.onPayload?.({ wire: "payload" });
				} catch (error) {
					captured.payloadError = error;
				}
				return { content: ["done"], stopReason: "stop" as const };
			},
		});

		const sessionManager = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
		const created = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			sessionManager,
			authStorage,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
			}),
			// MockModel is a Model<"mock">; the option type is the generic Model —
			// the registered mock API makes it a real provider at the stream seam.
			model: mock as unknown as Model,
			disableExtensionDiscovery: true,
			extensions: [mutatingFactory],
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: dir.path(), rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
			lifecycleExecutionContext: context,
		});
		const session: AgentSession = created.session;
		try {
			await session.prompt("trigger one provider request");
			await session.waitForIdle();

			// The real onPayload closure ran inside the provider stream seam and
			// threw the strict rejection for the mutating hook.
			expect(mock.calls.length).toBe(1);
			expect(captured.payloadError).toBeInstanceOf(Error);
			expect((captured.payloadError as Error).message).toContain("unprojectable_provider_hook");
			expect(captured.payloadResult).toBeUndefined();

			// The request context the provider saw was the PROJECTED context —
			// the real transformProviderContext → projectLifecycleSideRequest
			// wiring ran before the payload hook.
			const seen = mock.calls[0]?.context;
			expect(seen).toBeDefined();
			expect(getProjectionManifest(seen as Context)?.phase).toBe("side-request");
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("permits an observational onPayload hook under a bound lifecycle", async () => {
		const issuer = createRootIssuer("lc-project-root-4");
		const { context } = await admitBoundChild(store, issuer, dir.path(), "project-4");

		const captured: { payloadError?: unknown; sawPayload: boolean } = { sawPayload: false };
		const observationalFactory: ExtensionFactory = api => {
			api.on("before_provider_request", () => undefined);
		};
		const mock = createMockModel({
			provider: "mock",
			handler: async (_ctx, options) => {
				try {
					await options?.onPayload?.({ wire: "payload" });
					captured.sawPayload = true;
				} catch (error) {
					captured.payloadError = error;
				}
				return { content: ["done"], stopReason: "stop" as const };
			},
		});

		const sessionManager = SessionManager.create(dir.path(), path.join(dir.path(), "sessions-2"));
		const created = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			sessionManager,
			authStorage,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
			}),
			model: mock as unknown as Model,
			disableExtensionDiscovery: true,
			extensions: [observationalFactory],
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: dir.path(), rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
			lifecycleExecutionContext: context,
		});
		const session: AgentSession = created.session;
		try {
			await session.prompt("trigger one provider request");
			await session.waitForIdle();
			expect(mock.calls.length).toBe(1);
			expect(captured.sawPayload).toBe(true);
			expect(captured.payloadError).toBeUndefined();
		} finally {
			await session.dispose();
		}
	}, 60_000);
});

// ---------------------------------------------------------------------------
// 5. Revive/replay: resolve-not-remint
// ---------------------------------------------------------------------------

describe("LC live: revive rebinds the persisted binding", () => {
	let dir: TempDir;
	let store: OperationalStore;

	beforeEach(() => {
		dir = TempDir.createSync("@lc-revive-");
		store = OperationalStore.open({ dbPath: path.join(dir.path(), "op.db") });
	});

	afterEach(async () => {
		store.close();
		await removeWithRetries(dir.path()).catch(() => {});
	});

	it("re-binds a revived session to the same binding and projects", async () => {
		const issuer = createRootIssuer("lc-revive-root");
		const { context, binding, contract } = await admitBoundChild(store, issuer, dir.path(), "revive-1");

		// Simulate process restart: the live context and its projection
		// binding are gone; only the persisted rows survive.
		unbindLifecycleProjection(context);
		revokeLifecycleExecutionContext(context);
		const bindingsBefore = countBindings(store.dbPath);

		// The revive seam (persisted-revive.ts / native-task-executor.ts both
		// call exactly this) resolves the SAME binding — never a second admit.
		const revived = activateBoundSessionAuthority({
			store,
			binding,
			contract,
			repoRoot: dir.path(),
			artifactManager: { getPath: () => Promise.resolve(null) },
			toolSourceOf: name => (name === "read" ? "builtin" : undefined),
			pin: {
				bindingId: binding.bindingId,
				principalId: binding.childPrincipalId,
				attemptId: binding.attemptId,
				contractId: binding.contractId,
				contractRevision: binding.contractRevision,
				contractDigest: binding.contractDigest,
				policyEpoch: binding.policyEpoch,
				contextGeneration: binding.contextGeneration,
			},
		});

		const registration = getLifecycleRegistration(revived);
		expect(registration?.authority?.bindingId).toBe(binding.bindingId);
		expect(registration?.attemptId).toBe(binding.attemptId);
		// Resolve-not-remint: the store still holds exactly the original rows.
		expect(countBindings(store.dbPath)).toBe(bindingsBefore);
		expect(store.getLaunchBindingByAttempt(binding.attemptId).bindingId).toBe(binding.bindingId);

		// The revived context projects provider requests.
		const projected = await projectLifecycleSideRequest(
			{ messages: [{ role: "user", content: "resumed", timestamp: 1 }] },
			"compact",
			revived,
		);
		expect(getProjectionManifest(projected)?.phase).toBe("side-request");
	});

	it("fails closed when the persisted pin disagrees with the binding", async () => {
		const issuer = createRootIssuer("lc-revive-root-2");
		const { binding, contract } = await admitBoundChild(store, issuer, dir.path(), "revive-2");
		expect(() =>
			activateBoundSessionAuthority({
				store,
				binding,
				contract,
				repoRoot: dir.path(),
				artifactManager: { getPath: () => Promise.resolve(null) },
				pin: {
					bindingId: binding.bindingId,
					attemptId: binding.attemptId,
					contractDigest: "f".repeat(64),
				},
			}),
		).toThrow(/lifecycle_authority_mismatch/);
	});
});

// ---------------------------------------------------------------------------
// 6. The issuer's own spawn envelope bounds what it may launch
// ---------------------------------------------------------------------------

describe("LC live: issuer spawn envelope is enforced at admission", () => {
	let dir: TempDir;
	let store: OperationalStore;

	beforeEach(() => {
		dir = TempDir.createSync("@lc-issuer-spawn-");
		store = OperationalStore.open({ dbPath: path.join(dir.path(), "op.db") });
	});

	afterEach(async () => {
		store.close();
		await removeWithRetries(dir.path()).catch(() => {});
	});

	/** A root issuer whose spawn envelope is exactly the supplied override. */
	function issuerWithSpawn(sessionId: string, spawn: Record<string, unknown>): RootExecutionContext {
		return createHostRootExecutionContext({
			sessionId,
			policy: createTestPolicy({ role: "root-planner" }),
			authority: createTestEnvelope({
				usableCapabilities: ISSUER_CAPABILITIES,
				delegableCapabilities: ISSUER_CAPABILITIES,
				spawn: createTestSpawnAuthority({
					maySpawn: true,
					mayDelegateSpawn: true,
					allowedAgentTypes: ["*"],
					allowedLaunchClasses: ["legacy-compatible-worker"],
					maxDepth: 4,
					maxChildren: 16,
					...spawn,
				}),
			}),
		});
	}

	/** Raw admission so the failure code itself is observable. */
	async function admit(issuer: RootExecutionContext, idem: string) {
		const planned = createSpawnPlan({
			correlationId: `lc-${idem}`,
			agentName: "task",
			assignment: "Bound child assignment.",
			profile: createTestExecutionProfile(),
		});
		if (!planned.ok) throw new Error("spawn plan rejected");
		return admitBoundChildLaunch({
			issuer,
			store,
			spawnPlan: planned.plan,
			entryPoint: LAUNCH_ENTRY_POINTS.taskSpawn,
			reason: "issuer envelope suite",
			agentName: "task",
			assignment: "Bound child assignment.",
			agentDefinition: childAgent,
			executionProfile: planned.plan.profile,
			toolProfile: childToolProfile(),
			collaborationPolicy: createTestCollaborationPolicy(),
			repoRoot: dir.path(),
			baseline: await captureLaunchBaseline(dir.path()),
			idempotencyKey: `lc-${idem}`,
			sessionId: `session-lc-${idem}`,
			artifactManager: { getPath: () => Promise.resolve(null) },
			toolSourceOf: name => (name === "read" || name === "probe" ? "builtin" : "custom"),
		});
	}

	it("denies an agent type the issuer may not launch", async () => {
		const issuer = issuerWithSpawn("lc-issuer-type", { allowedAgentTypes: ["explore"] });
		const result = await admit(issuer, "type-denied");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected denial");
		expect(result.code).toBe("spawn_agent_type_not_permitted");
		// Denied before any durable row is written.
		expect(countBindings(path.join(dir.path(), "op.db"))).toBe(0);
	});

	it("denies a launch class outside the issuer's allow-list", async () => {
		const issuer = issuerWithSpawn("lc-issuer-class", { allowedLaunchClasses: ["strict-worker"] });
		const result = await admit(issuer, "class-denied");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected denial");
		expect(result.code).toBe("spawn_launch_class_not_permitted");
		expect(countBindings(path.join(dir.path(), "op.db"))).toBe(0);
	});

	it("denies a spawn past the issuer's live-children ceiling, counted from the store", async () => {
		const issuer = issuerWithSpawn("lc-issuer-fanout", { maxChildren: 1 });
		const first = await admit(issuer, "fanout-1");
		expect(first.ok).toBe(true);

		// The first child is live, so the ceiling is now consumed.
		const second = await admit(issuer, "fanout-2");
		expect(second.ok).toBe(false);
		if (second.ok) throw new Error("expected denial");
		expect(second.code).toBe("spawn_children_exhausted");
		expect(countBindings(path.join(dir.path(), "op.db"))).toBe(1);

		// maxChildren is a concurrency ceiling, not a lifetime quota: once the
		// first child reaches a terminal state the issuer may launch again.
		if (!first.ok) throw new Error("expected first admission to succeed");
		const terminated = store.terminateLaunchBinding({
			// The root issuer authenticates the mutation: its own principal is
			// the binding's parent, so lineage and epoch both match.
			guard: { actor: issuer, expectedPolicyEpoch: 1, idempotencyKey: "fanout-release" },
			bindingId: first.binding.bindingId,
			targetState: "revoked",
			reason: "test: release the fan-out slot",
		});
		expect(terminated.ok).toBe(true);
		const third = await admit(issuer, "fanout-3");
		expect(third.ok).toBe(true);
	});
});
