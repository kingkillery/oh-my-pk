/**
 * `task.lifecycle.enabled` is off by default, and while it is off nothing the
 * lifecycle lane added may change how a session runs: no issuer context, no
 * capability guard or provenance record on registered tools, spawns stay on
 * the legacy path, and `lifecycle-authority.db` is never created.
 *
 * Each "absent" assertion is paired with a control that enables the same
 * path, so an assertion cannot pass merely because the code it guards never
 * existed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import {
	createHostRootExecutionContext,
	type RootExecutionContext,
	registerLifecycleExecutionContext,
} from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/lifecycle-authority";
import { getRecordedToolProvenance } from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/lifecycle-tool-guard";
import { AgentLifecycleManager } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	discoverAuthStorage,
} from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TaskTool } from "@pk-nerdsaver-ai/pi-coding-agent/task";
import * as discoveryModule from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import * as executorModule from "@pk-nerdsaver-ai/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { getAgentDir, setAgentDir, TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { createTestEnvelope, createTestPolicy, createTestSpawnAuthority } from "../helpers/lifecycle-fixtures";

const AUTHORITY_DB = "lifecycle-authority.db";

describe("lifecycle execution with task.lifecycle.enabled off", () => {
	let agentDir: TempDir;
	let originalAgentDir: string;

	beforeEach(() => {
		originalAgentDir = getAgentDir();
		agentDir = TempDir.createSync("@lifecycle-default-off-");
		setAgentDir(agentDir.path());
	});

	afterEach(() => {
		setAgentDir(originalAgentDir);
		vi.restoreAllMocks();
		// A store opened by the control case keeps its handle for the process
		// lifetime, so the directory may stay locked on Windows.
		try {
			agentDir.removeSync();
		} catch {
			// still held open — the OS temp cleaner reclaims it
		}
	});

	it("defaults the setting to off", () => {
		expect(Settings.isolated().get("task.lifecycle.enabled")).toBe(false);
	});

	describe("session tool wiring", () => {
		let modelRegistry!: ModelRegistry;
		let registryAuthDir: TempDir;

		beforeAll(async () => {
			registryAuthDir = TempDir.createSync("@lifecycle-default-off-auth-");
			modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir.path()));
		});

		afterAll(() => {
			modelRegistry.authStorage.close();
			registryAuthDir.removeSync();
		});

		const baseOptions = (): CreateAgentSessionOptions => ({
			cwd: agentDir.path(),
			agentDir: agentDir.path(),
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: {
				rootPath: agentDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});

		it("registers tools without capability guards or provenance records", async () => {
			const { session } = await createAgentSession(baseOptions());
			try {
				expect(session.getLifecycleExecutionContext()).toBeUndefined();
				expect(session.getLifecycleIssuerContext()).toBeUndefined();
				const tools = session.agent.state.tools;
				expect(tools.length).toBeGreaterThan(0);
				for (const tool of tools) {
					expect(getRecordedToolProvenance(tool)).toBeUndefined();
				}
			} finally {
				await session.dispose();
			}
			expect(fs.existsSync(path.join(agentDir.path(), AUTHORITY_DB))).toBe(false);
		});

		it("control: a bound session records each tool's registration source", async () => {
			const lifecycle = registerLifecycleExecutionContext({
				mode: "direct-v1",
				role: "worker",
				runId: "run-default-off",
				nodeId: "node-default-off",
				attemptId: "attempt-default-off",
				policyEpoch: 1,
				usableCapabilities: [{ source: "builtin", name: "read" }],
				repoRoot: agentDir.path(),
				readableRoots: ["."],
				writableRoots: [],
				allowExternalWrite: false,
			});
			const { session } = await createAgentSession({ ...baseOptions(), lifecycleExecutionContext: lifecycle });
			try {
				const tools = session.agent.state.tools;
				expect(tools.length).toBeGreaterThan(0);
				for (const tool of tools) {
					expect(getRecordedToolProvenance(tool)).toBeDefined();
					expect(getRecordedToolProvenance(tool)).toBe(session.getToolSource(tool.name));
				}
			} finally {
				await session.dispose();
			}
		});
	});

	describe("TaskTool spawn", () => {
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

		/** The accessors createAgentSession installs: both undefined unless a context exists. */
		function createSession(issuer?: RootExecutionContext): ToolSession {
			return {
				cwd: agentDir.path(),
				hasUI: false,
				settings: Settings.isolated({ "task.agentPolicies": { task: { tier: "mid" } } }),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getModelString: () => "anthropic/claude-sonnet-4-5",
				getEvalSessionId: () => "parent-eval-session",
				getLifecycleExecutionContext: () => undefined,
				getLifecycleIssuerContext: () => issuer,
			} as unknown as ToolSession;
		}

		function rootIssuer(): RootExecutionContext {
			const capabilities = [
				{ source: "builtin" as const, name: "read" },
				{ source: "builtin" as const, name: "yield" },
			];
			return createHostRootExecutionContext({
				sessionId: "default-off-root",
				policy: createTestPolicy({ role: "root-planner" }),
				authority: createTestEnvelope({
					usableCapabilities: Object.freeze(capabilities),
					delegableCapabilities: Object.freeze(capabilities),
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

		beforeEach(() => {
			AgentRegistry.resetGlobalForTests();
			AgentLifecycleManager.resetGlobalForTests();
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [taskAgent],
				projectAgentsDir: null,
			});
		});

		afterEach(() => {
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
		});

		async function spawn(session: ToolSession): Promise<executorModule.ExecutorOptions | undefined> {
			let captured: executorModule.ExecutorOptions | undefined;
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				captured = options;
				return makeResult(options.id ?? "?");
			});
			const tool = await TaskTool.create(session);
			await tool.execute("tc-default-off", {
				agent: "task",
				id: "DefaultOff",
				description: "default-off spawn",
				assignment: "Do the thing.",
			} as TaskParams);
			return captured;
		}

		it("keeps the legacy spawn path and never creates the authority store", async () => {
			const options = await spawn(createSession());
			expect(options).toBeDefined();
			expect(options?.lifecycle).toBeUndefined();
			// The child still shares the parent's eval kernel, as before.
			expect(options?.parentEvalSessionId).toBe("parent-eval-session");
			expect(fs.existsSync(path.join(agentDir.path(), AUTHORITY_DB))).toBe(false);
			expect(fs.existsSync(path.join(agentDir.path(), "launch-evidence"))).toBe(false);
		});

		it("control: a lifecycle issuer admits the child through the authority store", async () => {
			const options = await spawn(createSession(rootIssuer()));
			expect(options?.lifecycle).toBeDefined();
			expect(options?.parentEvalSessionId).toBeUndefined();
			expect(fs.existsSync(path.join(agentDir.path(), AUTHORITY_DB))).toBe(true);
		});
	});
});
