import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { CustomTool } from "../../src/extensibility/custom-tools/types";
import type { ExtensionUIContext } from "../../src/extensibility/extensions/types";
import { initializeExtensions } from "../../src/modes/runtime-init";
import { getAvailableThemesWithPaths, getThemeByName } from "../../src/modes/theme/theme";
import { LifecycleStore } from "../../src/operational/lifecycle-store";
import { getLifecycleRegistration } from "../../src/orchestration/lifecycle-authority";
import * as sdk from "../../src/sdk";
import { type CreateAgentSessionResult, createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { type PendingLifecycleLaunch, terminateLifecycleLaunch } from "../../src/task/launch-admission";
import { createLifecycleRootIssuer } from "../../src/task/lifecycle-session";
import { AgentOutputManager } from "../../src/task/output-manager";
import { admitBoundChildLaunch, captureLaunchBaseline, LAUNCH_ENTRY_POINTS } from "../../src/task/spawn-admission";
import { createSpawnPlan } from "../../src/task/spawn-plan";
import { resolveToolProfile } from "../../src/tools/tool-profiles";
import {
	createTestCollaborationPolicy,
	createTestExecutionProfile,
} from "../operational/fixtures/launch-authority-input";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(enabled = true, maxRequests = 2) {
	const directory = await mkdtemp(path.join(tmpdir(), "ompk-launch-sdk-"));
	cleanups.push(() => removeWithRetries(directory));
	const authStorage = await AuthStorage.create(":memory:");
	cleanups.push(async () => authStorage.close());
	authStorage.setRuntimeApiKey("launch-test", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(directory, "models.yml"));
	const settings = Settings.isolated({
		"task.lifecycle.enabled": enabled,
		"task.simpleMode": false,
		"async.enabled": false,
		"retry.enabled": false,
		"compaction.enabled": false,
	});
	settings.override("task.maxConcurrency", 1);
	const requests: unknown[] = [];
	let responseMode: "text" | "probe" | "yield" | "large" | "hang" = "text";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push(await request.json());
			if (responseMode === "hang")
				return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
			const tool = responseMode === "probe" || responseMode === "yield";
			const delta = tool
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `call-${requests.length}`,
								type: "function",
								function: {
									name: responseMode,
									arguments: JSON.stringify(responseMode === "yield" ? { result: { data: "completed" } } : {}),
								},
							},
						],
					}
				: { role: "assistant", content: responseMode === "large" ? "é".repeat(524_288) : "complete" };
			const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
			const deltas =
				responseMode === "large"
					? Array.from({ length: 128 }, () => ({ role: "assistant", content: "é".repeat(4096) }))
					: [delta];
			return new Response(
				deltas
					.map(delta =>
						chunk({
							id: `completion-${requests.length}`,
							object: "chat.completion.chunk",
							model: "worker",
							choices: [{ index: 0, delta, finish_reason: null }],
						}),
					)
					.join("") +
					chunk({
						id: `completion-${requests.length}`,
						object: "chat.completion.chunk",
						model: "worker",
						choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
					}) +
					"data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	cleanups.push(async () => {
		await server.stop(true);
	});
	modelRegistry.registerProvider("launch-test", {
		api: "openai-completions",
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		apiKey: "test-key",
		models: [
			{
				id: "worker",
				name: "Worker",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 4096,
			},
		],
	});
	const model = modelRegistry.find("launch-test", "worker");
	if (!model) throw new Error("Loopback contract model was not registered");
	const store = await LifecycleStore.open({ dbPath: path.join(directory, "authority.db") });
	cleanups.push(async () => store.close());
	const capabilities = [
		{ source: "custom" as const, name: "probe" },
		{ source: "builtin" as const, name: "read" },
		{ source: "hidden" as const, name: "yield" },
	];
	const issuer = createLifecycleRootIssuer("root-sdk", settings, capabilities);
	const profile = {
		...createTestExecutionProfile(),
		tier: "frontier" as const,
		autonomy: "independent" as const,
		maxRequests,
	};
	const toolProfile = resolveToolProfile({ execution: profile, declaredCapabilities: capabilities });
	const planning = createSpawnPlan({
		correlationId: "sdk-test",
		agentName: "task",
		assignment: "Verify SDK",
		profile,
	});
	if (!planning.ok) throw new Error("Test spawn planning failed");
	const baseline = await captureLaunchBaseline(directory, path.join(directory, "evidence"));
	const admit = async (key: string, assignment = "Verify SDK"): Promise<PendingLifecycleLaunch> => {
		const result = await admitBoundChildLaunch({
			issuer,
			store,
			spawnPlan: planning.plan,
			entryPoint: LAUNCH_ENTRY_POINTS.taskSpawn,
			reason: "SDK contract test",
			agentName: "task",
			assignment,
			agentDefinition: {
				name: "task",
				description: "Worker",
				systemPrompt: "Complete assignment",
				source: "bundled",
			},
			executionProfile: profile,
			toolProfile,
			collaborationPolicy: createTestCollaborationPolicy(),
			repoRoot: directory,
			baseline,
			evidenceDir: path.join(directory, "evidence"),
			idempotencyKey: key,
		});
		if (!result.ok) throw new Error(result.code);
		return result.pending;
	};
	let bodies = 0;
	let probeOutput = "body";
	const probe: CustomTool = {
		name: "probe",
		label: "Probe",
		description: "Execute probe",
		parameters: type({}),
		approval: "exec",
		async execute() {
			bodies++;
			return { content: [{ type: "text", text: probeOutput }], details: {} };
		},
	};
	const create = async (
		pending?: PendingLifecycleLaunch,
		extra: Parameters<typeof createAgentSession>[0] = {},
	): Promise<CreateAgentSessionResult> => {
		const manager = SessionManager.create(directory, path.join(directory, "sessions"));
		cleanups.push(async () => manager.close());
		const created = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			authStorage,
			modelRegistry,
			model,
			settings,
			sessionManager: manager,
			lifecycleLaunch: pending,
			parentEvalSessionId: "parent-eval-state",
			taskDepth: pending ? 1 : 0,
			parentTaskPrefix: pending ? "sdk-child" : undefined,
			agentId: `launch-sdk-${directory}-${pending?.launch.binding.bindingId ?? "root"}`,
			customTools: [probe],
			toolNames: ["probe", "read", "yield"],
			disableExtensionDiscovery: true,
			skipPythonPreflight: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			...extra,
		});
		cleanups.push(async () => {
			await created.session.dispose();
		});
		return created;
	};
	return {
		directory,
		authStorage,
		modelRegistry,
		settings,
		model,
		requests,
		store,
		issuer,
		admit,
		create,
		bodies: () => bodies,
		setResponseMode: (mode: typeof responseMode) => {
			responseMode = mode;
		},
		setProbeOutput: (output: string) => {
			probeOutput = output;
		},
	};
}

function registerTaskProvider(f: { settings: Settings; setResponseMode: (mode: "yield") => void }) {
	f.settings.override("task.isolation.mode", "none");
	f.settings.override("task.prefetch.enabled", false);
	f.setResponseMode("yield");
}

describe("real SDK launch authority wiring", () => {
	it("bounds an enabled foreground delivered result and saved final output by its UTF8 limit", async () => {
		const f = await fixture();
		registerTaskProvider(f);
		f.setResponseMode("large");
		const { session } = await f.create(undefined, { toolNames: ["task"] });
		const createSpy = spyOn(sdk, "createAgentSession");
		try {
			const result = await session.getToolByName("task")!.execute("large-result", {
				agent: "task",
				assignment: "Produce output",
				model: "launch-test/worker",
				id: "LargeResult",
			});
			const pending = createSpy.mock.calls[0]?.[0]?.lifecycleLaunch;
			if (pending) cleanups.push(async () => pending.store.close());
			expect(f.requests).toHaveLength(1);
			expect(result).toMatchObject({
				details: { results: [{ exitCode: 1, output: expect.stringContaining("lifecycle_output_limit") }] },
			});
			expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(1_048_576);
			const delivered = result.details as { results: Array<{ outputPath: string }> };
			const output = await Bun.file(delivered.results[0]!.outputPath).text();
			expect(output).toContain("lifecycle_output_limit");
			expect(Buffer.byteLength(output, "utf8")).toBeLessThan(1_048_576);
			expect(pending!.store.getLaunchBinding(pending!.launch.binding.bindingId).state).toBe("failed");
		} finally {
			createSpy.mockRestore();
		}
	});

	it("aborts a real stalled provider under the compiled runtime limit and releases child capacity", async () => {
		const f = await fixture();
		registerTaskProvider(f);
		f.setResponseMode("hang");
		f.settings.override("task.agentPolicies", { task: { maxRequests: 2, maxRuntimeMs: 2_000 } });
		const { session } = await f.create(undefined, { toolNames: ["task"] });
		const createSpy = spyOn(sdk, "createAgentSession");
		try {
			const start = Date.now();
			const result = await session.getToolByName("task")!.execute("runtime-bound", {
				agent: "task",
				assignment: "Wait for provider",
				model: "launch-test/worker",
				id: "RuntimeBound",
			});
			const pending = createSpy.mock.calls[0]?.[0]?.lifecycleLaunch;
			if (pending) cleanups.push(async () => pending.store.close());
			expect(result).toMatchObject({
				details: {
					results: [
						{ exitCode: 1, aborted: true, abortReason: expect.stringContaining("runtime limit exceeded") },
					],
				},
			});
			expect(f.requests.length).toBeGreaterThan(0);
			expect(Date.now() - start).toBeLessThan(5_000);
			const row = pending!.store.getLaunchBinding(pending!.launch.binding.bindingId);
			expect(row.state).toBe("failed");
			expect(pending!.store.countLiveChildBindings(row.parentPrincipalId)).toBe(0);
		} finally {
			createSpy.mockRestore();
		}
	});

	it("runs the real foreground Task executor with default-off behavior and enabled activation/settlement", async () => {
		for (const enabled of [false, true]) {
			const f = await fixture(enabled);
			registerTaskProvider(f);
			const { session } = await f.create(undefined, { toolNames: ["task", "yield"] });
			let admission: PendingLifecycleLaunch | undefined;
			let childSessionId: string | undefined;
			const createSpy = spyOn(sdk, "createAgentSession");
			try {
				const result = await session.getToolByName("task")!.execute(`foreground-${enabled}`, {
					agent: "task",
					assignment: "Yield completed",
					model: "launch-test/worker",
					id: `Foreground${enabled}`,
				});
				const childOptions = createSpy.mock.calls[0]?.[0];
				admission = childOptions?.lifecycleLaunch;
				if (admission) {
					const store = admission.store;
					cleanups.push(async () => store.close());
				}
				childSessionId = childOptions?.sessionManager?.getSessionId();
				expect(result.isError).not.toBe(true);
				expect(result).toMatchObject({
					details: { results: [{ exitCode: 0, output: expect.stringContaining("completed") }] },
				});
				expect(f.requests).toHaveLength(1);
				if (enabled) {
					expect(admission).toBeDefined();
					expect(admission!.launch.compiled.authority.usableCapabilities).toContainEqual({
						source: "hidden",
						name: "yield",
					});
					const row = admission!.store.getLaunchBinding(admission!.launch.binding.bindingId);
					expect(row.sessionId).toBe(childSessionId!);
					expect(row.state).toBe("revoked");
					expect(admission!.store.countLiveChildBindings(row.parentPrincipalId)).toBe(0);
				} else {
					expect(admission).toBeUndefined();
					expect(await Bun.file(path.join(f.directory, "lifecycle-authority.db")).exists()).toBe(false);
				}
			} finally {
				createSpy.mockRestore();
			}
		}
	});

	it("denies unsupported async and fork routes before Task output/job allocation even after the flag is disabled", async () => {
		const f = await fixture();
		registerTaskProvider(f);
		f.settings.override("async.enabled", true);
		const { session } = await f.create(undefined, { toolNames: ["task"] });
		f.settings.override("task.lifecycle.enabled", false);
		const allocate = spyOn(AgentOutputManager.prototype, "allocate");
		const register = spyOn(session.asyncJobManager!, "register");
		try {
			const result = await session.getToolByName("task")!.execute("async-denied", {
				agent: "task",
				assignment: "Do work",
				model: "launch-test/worker",
				id: "Denied",
			});
			expect(JSON.stringify(result)).toContain("unsupported_lifecycle_launch_route");
			expect(allocate).not.toHaveBeenCalled();
			expect(register).not.toHaveBeenCalled();
			f.settings.override("async.enabled", false);
			const fork = await session
				.getToolByName("task")!
				.execute("fork-denied", { agent: "task", assignment: "Do work", model: "launch-test/worker", fork: true });
			expect(JSON.stringify(fork)).toContain("unsupported_lifecycle_launch_route");
			expect(allocate).not.toHaveBeenCalled();
			expect(f.requests).toHaveLength(0);
		} finally {
			allocate.mockRestore();
			register.mockRestore();
		}
	});
	it("leaves default-off startup and registry execution ordinary without opening authority storage", async () => {
		const f = await fixture(false);
		const { session } = await f.create();
		expect(session.getLifecycleIssuerContext()).toBeUndefined();
		await session.getToolByName("probe")!.execute("ordinary", {});
		expect(f.bodies()).toBe(1);
		expect(await Bun.file(path.join(f.directory, "lifecycle-authority.db")).exists()).toBe(false);
		expect(await Bun.file(path.join(f.directory, "launch-evidence")).exists()).toBe(false);
		const oldId = session.sessionManager.getSessionId();
		await session.newSession();
		expect(session.sessionManager.getSessionId()).not.toBe(oldId);
	});

	it("activates an actual owned session before tool dispatch and revokes on disposal", async () => {
		const f = await fixture();
		const pending = await f.admit("actual-sdk");
		const { session } = await f.create(pending);
		const row = f.store.getLaunchBinding(pending.launch.binding.bindingId);
		expect(row.state).toBe("bound");
		expect(row.sessionId).toBe(session.sessionManager.getSessionId());
		expect(session.sessionFile?.startsWith(path.join(f.directory, "sessions"))).toBe(true);
		expect(session.getEvalSessionId()).not.toBe("parent-eval-state");
		await session.getToolByName("probe")!.execute("allowed", {});
		await expect(session.getToolByName("read")!.execute("no-scopes", { path: "file.ts" })).rejects.toThrow(
			"target_outside_scope",
		);
		expect(f.bodies()).toBe(1);
		await session.dispose();
		expect(f.store.getLaunchBinding(row.bindingId).state).toBe("revoked");
	});

	it("rechecks the durable row after an actual extension approval wait", async () => {
		const f = await fixture();
		const pending = await f.admit("approval");
		const created = await f.create(pending);
		const { session } = created;
		const entered = Promise.withResolvers<void>();
		const choice = Promise.withResolvers<string>();
		const hostTheme = await getThemeByName("dark");
		if (!hostTheme) throw new Error("Host theme unavailable");
		const receipts: Array<{ method: string; data: unknown }> = [];
		let editorText = "";
		let expanded = false;
		const ui: ExtensionUIContext = {
			async select(title, options) {
				receipts.push({ method: "select", data: { title, options } });
				entered.resolve();
				return choice.promise;
			},
			async confirm() {
				throw new Error("Host channel supports selectors only");
			},
			async input() {
				throw new Error("Host channel supports selectors only");
			},
			notify(message, level) {
				receipts.push({ method: "notify", data: { message, level } });
			},
			onTerminalInput() {
				throw new Error("Host has no terminal input surface");
			},
			setStatus(key, text) {
				receipts.push({ method: "status", data: { key, text } });
			},
			setWorkingMessage(message) {
				receipts.push({ method: "working", data: message });
			},
			setWidget(key, content) {
				receipts.push({ method: "widget", data: { key, content } });
			},
			setFooter() {
				throw new Error("Host has no terminal components");
			},
			setHeader() {
				throw new Error("Host has no terminal components");
			},
			setTitle(title) {
				receipts.push({ method: "title", data: title });
			},
			async custom() {
				throw new Error("Host has no terminal components");
			},
			setEditorText(text) {
				editorText = text;
			},
			pasteToEditor(text) {
				editorText += text;
			},
			getEditorText() {
				return editorText;
			},
			async editor() {
				throw new Error("Host channel supports selectors only");
			},
			setEditorComponent() {
				throw new Error("Host has no terminal components");
			},
			theme: hostTheme,
			getAllThemes: getAvailableThemesWithPaths,
			getTheme: getThemeByName,
			async setTheme() {
				return { success: false, error: "Host theme is fixed" };
			},
			getToolsExpanded() {
				return expanded;
			},
			setToolsExpanded(value) {
				expanded = value;
			},
		};
		await initializeExtensions(session, {
			uiContext: ui,
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw new Error(error.error);
			},
		});
		created.setToolUIContext(ui, true);
		let invocation: Promise<unknown> | undefined;
		try {
			f.settings.override("tools.approvalMode", "always-ask");
			invocation = session
				.getToolByName("probe")!
				.execute("held", {}, undefined, undefined, { settings: f.settings } as never);
			await entered.promise;
			expect(receipts.find(receipt => receipt.method === "select")).toMatchObject({
				method: "select",
				data: { options: ["Approve", "Deny"] },
			});
			terminateLifecycleLaunch(pending, "revoked", "Revoked during approval");
			choice.resolve("Approve");
			await expect(invocation).rejects.toThrow("launch_authority_revoked");
			expect(f.bodies()).toBe(0);
		} finally {
			choice.resolve("Deny");
			await invocation?.catch(() => {});
		}
	});

	it("checks actual startup, MCP refresh and RPC refresh implementations by captured source", async () => {
		const f = await fixture();
		const pending = await f.admit("refresh");
		const { session } = await f.create(pending);
		const retained = session.getToolByName("probe")!;
		let replacementBodies = 0;
		await session.refreshMCPTools(
			[
				{
					name: "probe",
					label: "MCP probe",
					description: "MCP replacement",
					parameters: type({}),
					approval: "exec",
					async execute() {
						replacementBodies++;
						throw new Error("MCP raw body reached");
					},
				},
			],
			{ activateAll: true },
		);
		await expect(session.getToolByName("probe")!.execute("mcp", {})).rejects.toThrow("capability_not_granted");
		await retained.execute("retained", {});
		expect(f.bodies()).toBe(1);
		const rpc = {
			name: "rpc_probe",
			label: "RPC",
			description: "RPC",
			parameters: type({}),
			approval: "exec",
			async execute() {
				replacementBodies++;
				throw new Error("RPC raw body reached");
			},
		} as unknown as AgentTool;
		await session.refreshRpcHostTools([rpc]);
		const oldRpc = session.getToolByName("rpc_probe")!;
		await session.refreshRpcHostTools([{ ...rpc, description: "Refreshed RPC" }]);
		await expect(session.getToolByName("rpc_probe")!.execute("rpc", {})).rejects.toThrow("capability_not_granted");
		await expect(oldRpc.execute("old-rpc", {})).rejects.toThrow("capability_not_granted");
		expect(replacementBodies).toBe(0);
	});

	it("does not grant a startup custom tool the authority of a same-name builtin", async () => {
		const f = await fixture();
		const pending = await f.admit("startup-collision");
		let bodies = 0;
		const { session } = await f.create(pending, {
			customTools: [
				{
					name: "read",
					label: "Custom read",
					description: "Custom execution",
					parameters: type({}),
					approval: "exec",
					async execute() {
						bodies++;
						return { content: [], details: {} };
					},
				},
			],
		});
		await expect(session.getToolByName("read")!.execute("custom-read", {})).rejects.toThrow("capability_not_granted");
		expect(bodies).toBe(0);
	});

	it("enforces total provider requests across run resets and rejects oversized UTF8 results before disclosure", async () => {
		const f = await fixture(true, 2);
		f.setResponseMode("probe");
		const pending = await f.admit("finite");
		const { session } = await f.create(pending);
		await session.prompt("Run probe");
		expect(f.requests).toHaveLength(2);
		await session.agent.continue();
		expect(f.requests).toHaveLength(2);
		await expect(session.runEphemeralTurn({ promptText: "Side call" })).rejects.toThrow(
			"unsupported_lifecycle_companion",
		);
		expect(() => session.setAdvisorEnabled(true)).toThrow("unsupported_lifecycle_companion");
		await expect(session.compact()).rejects.toThrow("unsupported_lifecycle_maintenance");
		await expect(session.navigateTree("absent", { summarize: true })).rejects.toThrow(
			"lifecycle_session_transition_unavailable",
		);
		await expect(session.getToolByName("yield")!.execute("huge", { message: "é".repeat(524_288) })).rejects.toThrow(
			"lifecycle_handoff_limit",
		);
		f.setProbeOutput("é".repeat(524_288));
		await expect(
			session.getToolByName("probe")!.execute("huge-result", {}, undefined, undefined, {
				settings: f.settings,
				sessionManager: session.sessionManager,
			} as never),
		).rejects.toThrow("lifecycle_output_limit");
	});

	it("pins enabled actors across flag changes and refuses inbox mutation and repeated prompt calls", async () => {
		const f = await fixture();
		const pending = await f.admit("identity");
		const { session } = await f.create(pending);
		const id = session.sessionManager.getSessionId();
		f.settings.override("task.lifecycle.enabled", false);
		await expect(session.newSession()).rejects.toThrow("lifecycle_session_transition_unavailable");
		expect(session.sessionManager.getSessionId()).toBe(id);
		const count = session.state.messages.length;
		await expect(
			session.deliverIrcMessage({ id: "incoming", from: "peer", to: "child", body: "Wake", ts: Date.now() }),
		).rejects.toThrow("unsupported_lifecycle_delivery_channel");
		expect(session.state.messages.length).toBe(count);
		await session.prompt("Complete assignment");
		await expect(session.prompt("Another assignment")).rejects.toThrow("lifecycle_prompt_limit");
		expect(f.requests).toHaveLength(1);
	});

	it("refuses companion startup before activation, preserves caller auth and releases capacity", async () => {
		const f = await fixture();
		const pending = await f.admit("startup-failure");
		f.settings.override("moa.enabled", true);
		await expect(f.create(pending)).rejects.toThrow("unsupported_lifecycle_companion");
		expect(f.modelRegistry.hasConfiguredAuth(f.model)).toBe(true);
		expect(f.store.getLaunchBinding(pending.launch.binding.bindingId).state).toBe("failed");
		const principal = getLifecycleRegistration(f.issuer)!.root!.rootPrincipalId;
		expect(f.store.countLiveChildBindings(principal)).toBe(0);
		f.settings.override("moa.enabled", false);
		await f.admit("after-failure");
	});
});
