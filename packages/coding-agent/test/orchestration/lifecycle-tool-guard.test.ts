/**
 * W3 (source slice): capability authorization on tool dispatch.
 *
 * Covers the two checks the extension wrapper performs — before any extension
 * callback and again after them, outside the result path — plus the registry /
 * getToolByName path on a session with no extension runner, including MCP/RPC
 * replacement under the same tool name.
 *
 * Deliberately NOT covered here: action, target and effect enforcement for
 * direct dispatch. That is the remaining W3 work; this increment authorizes
 * source-qualified capability membership only.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, type AgentToolContext, type AgentToolResult } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { CustomTool } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/custom-tools/types";
import type { ExtensionRunner } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions/runner";
import type {
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions/types";
import {
	ExtensionToolWrapper,
	LifecycleToolWrapper,
} from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions/wrapper";
import {
	type LifecycleExecutionContext,
	registerLifecycleExecutionContext,
	revokeLifecycleExecutionContext,
} from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/lifecycle-authority";
import {
	createLifecycleToolGuard,
	LifecycleAuthorizationError,
} from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/lifecycle-tool-guard";
import { createAgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import type { ToolCapability } from "@pk-nerdsaver-ai/pi-coding-agent/tools/tool-profiles";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";

function registerWorker(capabilities: readonly ToolCapability[]): LifecycleExecutionContext {
	return registerLifecycleExecutionContext({
		mode: "hierarchical-v1",
		role: "worker",
		runId: "run-guard",
		nodeId: "node-guard",
		attemptId: "attempt-guard",
		policyEpoch: 1,
		usableCapabilities: capabilities,
		repoRoot: process.cwd(),
		readableRoots: ["."],
		writableRoots: ["."],
		allowExternalWrite: false,
	});
}

/** Records every invocation so "ran before the guard" is observable, not inferred. */
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

function createMcpProbeTool(name: string, executions: string[]): CustomTool {
	return {
		name,
		label: `docs/${name}`,
		description: `${name} mcp probe`,
		parameters: type({ value: "string" }),
		mcpServerName: "docs",
		mcpToolName: name,
		approval: "exec",
		async execute(toolCallId: string) {
			executions.push(`mcp:${name}:${toolCallId}`);
			return { content: [{ type: "text", text: `${name} mcp executed` }] };
		},
	} as unknown as CustomTool;
}

interface RunnerTrace {
	readonly approvalEvents: string[];
	readonly toolCalls: string[];
	readonly toolResults: string[];
}

interface StubRunnerOptions {
	onToolCall?: (event: ToolCallEvent) => ToolCallEventResult | undefined;
	onToolResult?: (event: ToolResultEvent) => ToolResultEventResult | undefined;
}

/**
 * Local stand-in for ExtensionRunner: only the surface ExtensionToolWrapper
 * consumes. `hasUI()` is false, so reaching the approval gate would throw a
 * distinctive error — that is how the tests below prove ordering rather than
 * asserting on source text.
 */
function createStubRunner(trace: RunnerTrace, options: StubRunnerOptions = {}): ExtensionRunner {
	const runner = {
		hasHandlers(eventType: string): boolean {
			if (eventType === "tool_call") return options.onToolCall !== undefined;
			if (eventType === "tool_result") return options.onToolResult !== undefined;
			return true;
		},
		async emit(event: { type: string }): Promise<void> {
			trace.approvalEvents.push(event.type);
		},
		async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
			trace.toolCalls.push(event.toolCallId);
			return options.onToolCall?.(event);
		},
		async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
			trace.toolResults.push(event.toolCallId);
			return options.onToolResult?.(event);
		},
		hasUI(): boolean {
			return false;
		},
	};
	// Test seam: the wrapper only ever touches the methods defined above.
	return runner as unknown as ExtensionRunner;
}

function emptyTrace(): RunnerTrace {
	return { approvalEvents: [], toolCalls: [], toolResults: [] };
}

function textOf(result: AgentToolResult): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

describe("lifecycle capability guard on tool dispatch", () => {
	it("denies before the approval gate, the extension callbacks and the tool itself", async () => {
		const executions: string[] = [];
		const trace = emptyTrace();
		const runner = createStubRunner(trace, { onToolCall: () => undefined, onToolResult: () => undefined });
		const context = registerWorker([{ source: "builtin", name: "other" }]);
		const probe = createProbeTool("probe", executions);
		const wrapper = new ExtensionToolWrapper(
			probe,
			runner,
			createLifecycleToolGuard(() => context, "builtin", probe),
		);

		// `tools.approval.probe: prompt` + no UI would throw the approval error if
		// the guard ran late; the lifecycle denial proves it runs first.
		const denial = wrapper.execute("call-1", { value: "x" }, undefined, undefined, {
			settings: Settings.isolated({ "tools.approval": { probe: "prompt" } }),
		} as AgentToolContext);

		await expect(denial).rejects.toBeInstanceOf(LifecycleAuthorizationError);
		await denial.catch((error: unknown) => {
			expect(error).toBeInstanceOf(LifecycleAuthorizationError);
			if (error instanceof LifecycleAuthorizationError) expect(error.code).toBe("capability_not_granted");
		});
		expect(executions).toEqual([]);
		expect(trace).toEqual({ approvalEvents: [], toolCalls: [], toolResults: [] });
	});

	it("re-checks after tool_call callbacks; a revoked context cannot reach the tool and tool_result cannot restore it", async () => {
		const executions: string[] = [];
		const trace = emptyTrace();
		const context = registerWorker([{ source: "builtin", name: "probe" }]);
		const runner = createStubRunner(trace, {
			onToolCall: () => {
				// Authority is withdrawn while the callback runs.
				revokeLifecycleExecutionContext(context);
				return undefined;
			},
			// Would clear any error status if the denial passed through the result path.
			onToolResult: () => ({ isError: false, content: [{ type: "text", text: "restored" }] }),
		});
		const probe = createProbeTool("probe", executions);
		const wrapper = new ExtensionToolWrapper(
			probe,
			runner,
			createLifecycleToolGuard(() => context, "builtin", probe),
		);

		const denial = wrapper.execute("call-2", { value: "x" }, undefined, undefined, {} as AgentToolContext);

		await expect(denial).rejects.toBeInstanceOf(LifecycleAuthorizationError);
		await denial.catch((error: unknown) => {
			if (error instanceof LifecycleAuthorizationError) expect(error.code).toBe("missing_lifecycle_binding");
		});
		expect(trace.toolCalls).toEqual(["call-2"]);
		// The tool never ran and the result hook never saw this call.
		expect(executions).toEqual([]);
		expect(trace.toolResults).toEqual([]);
	});

	it("denies a same-named executable registered under a different source", async () => {
		const executions: string[] = [];
		const context = registerWorker([{ source: "builtin", name: "read" }]);
		const readProbe = createProbeTool("read", executions, "read");
		const guard = createLifecycleToolGuard(() => context, "mcp", readProbe);
		const wrapper = new LifecycleToolWrapper(readProbe, guard);

		await expect(
			wrapper.execute("call-3", { value: "x" }, undefined, undefined, {} as AgentToolContext),
		).rejects.toThrow(/capability_not_granted/);
		expect(executions).toEqual([]);
	});

	it("allows a granted capability and authorizes under the tool call id", async () => {
		const executions: string[] = [];
		const trace = emptyTrace();
		const runner = createStubRunner(trace, { onToolCall: () => undefined });
		const context = registerWorker([{ source: "builtin", name: "probe" }]);
		const probe = createProbeTool("probe", executions);
		const wrapper = new ExtensionToolWrapper(
			probe,
			runner,
			createLifecycleToolGuard(() => context, "builtin", probe),
		);

		const result = await wrapper.execute("call-4", { value: "x" }, undefined, undefined, {} as AgentToolContext);
		expect(textOf(result)).toContain("probe executed");
		expect(executions).toEqual(["probe:call-4"]);

		// The invocation id is the tool call id: an empty one fails the authority's
		// idempotency-key check rather than silently passing.
		await expect(wrapper.execute("", { value: "x" }, undefined, undefined, {} as AgentToolContext)).rejects.toThrow(
			/missing_invocation_id/,
		);
		expect(executions).toEqual(["probe:call-4"]);
	});

	it("leaves unbound (legacy) dispatch untouched", async () => {
		const executions: string[] = [];
		const trace = emptyTrace();
		const probe = createProbeTool("probe", executions);
		const wrapper = new ExtensionToolWrapper(
			probe,
			createStubRunner(trace),
			createLifecycleToolGuard(() => undefined, undefined, probe),
		);

		const result = await wrapper.execute("call-5", { value: "x" }, undefined, undefined, {} as AgentToolContext);
		expect(textOf(result)).toContain("probe executed");
		expect(executions).toEqual(["probe:call-5"]);
	});

	it("guards registry dispatch on a session with no extension runner, across MCP/RPC replacement", async () => {
		const executions: string[] = [];
		const readTool = createProbeTool("read", executions);
		const context = registerWorker([{ source: "mcp", name: "mcp__docs_search" }]);
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: createModel(), tools: [readTool], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			toolSources: new Map([["read", "builtin"]]),
			lifecycleExecutionContext: context,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["test"] }),
		});

		try {
			// Builtin `read` is not in the ceiling: denied before it runs.
			const read = session.getToolByName("read");
			expect(read).toBeDefined();
			await expect(read!.execute("call-6", { value: "x" }, undefined, undefined)).rejects.toBeInstanceOf(
				LifecycleAuthorizationError,
			);
			expect(executions).toEqual([]);

			// Granted MCP capability executes through the same registry path.
			await session.refreshMCPTools([createMcpProbeTool("mcp__docs_search", executions)]);
			expect(session.getToolSource("mcp__docs_search")).toBe("mcp");
			const mcpHandle = session.getToolByName("mcp__docs_search");
			expect(mcpHandle).toBeDefined();
			expect(textOf(await mcpHandle!.execute("call-7", { value: "x" }, undefined, undefined))).toContain(
				"mcp executed",
			);
			expect(executions).toEqual(["mcp:mcp__docs_search:call-7"]);

			// Same name, replaced by an RPC-host executable: the new registration's
			// source is `custom`, which the ceiling never admitted.
			await session.refreshMCPTools([]);
			await session.refreshRpcHostTools([createProbeTool("mcp__docs_search", executions)]);
			expect(session.getToolSource("mcp__docs_search")).toBe("custom");
			const rpcHandle = session.getToolByName("mcp__docs_search");
			expect(rpcHandle).toBeDefined();
			await expect(rpcHandle!.execute("call-8", { value: "x" }, undefined, undefined)).rejects.toBeInstanceOf(
				LifecycleAuthorizationError,
			);

			// The handle taken before the replacement keeps the provenance captured
			// with its own executable — it neither loses nor borrows authority.
			expect(textOf(await mcpHandle!.execute("call-9", { value: "x" }, undefined, undefined))).toContain(
				"mcp executed",
			);
			expect(executions).toEqual(["mcp:mcp__docs_search:call-7", "mcp:mcp__docs_search:call-9"]);
		} finally {
			await session.dispose();
		}
	});

	it("guards real SDK direct tool execution from the agent tool list", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-lifecycle-guard-${Snowflake.next()}-`));
		const cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		const context = registerWorker([{ source: "builtin", name: "bash" }]);
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager: SessionManager.create(cwd, path.join(tempDir, "sessions")),
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["bash", "read"],
			lifecycleExecutionContext: context,
		});
		const session = created.session;

		try {
			// Direct execution off the agent's own tool list, not via getToolByName.
			const tools = session.agent.state.tools;
			const bash = tools.find(tool => tool.name === "bash");
			const read = tools.find(tool => tool.name === "read");
			expect(bash).toBeDefined();
			expect(read).toBeDefined();

			expect(textOf(await bash!.execute("sdk-1", { command: "echo guarded" }, undefined, undefined))).toContain(
				"guarded",
			);

			// `read` is registered but outside the ceiling: denied before it touches disk.
			const probePath = path.join(cwd, "probe.txt");
			fs.writeFileSync(probePath, "secret");
			await expect(read!.execute("sdk-2", { path: probePath }, undefined, undefined)).rejects.toBeInstanceOf(
				LifecycleAuthorizationError,
			);

			// Revoking the host binding fails every later call closed, including the
			// capability that was granted a moment ago.
			revokeLifecycleExecutionContext(context);
			await expect(bash!.execute("sdk-3", { command: "echo after-revoke" }, undefined, undefined)).rejects.toThrow(
				/missing_lifecycle_binding/,
			);
		} finally {
			await session.dispose();
			// Windows can hold the session's temp handles briefly after dispose; the
			// OS reclaims the directory either way, so cleanup stays best-effort.
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					removeSyncWithRetries(tempDir);
					break;
				} catch {
					await Bun.sleep(50 * (attempt + 1));
				}
			}
		}
	}, 60_000);

	it("keeps legacy sessions with no host-minted binding working", async () => {
		const executions: string[] = [];
		const readTool = createProbeTool("read", executions);
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: createModel(), tools: [readTool], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			modelRegistry: {} as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			toolSources: new Map([["read", "builtin"]]),
			rebuildSystemPrompt: async () => ({ systemPrompt: ["test"] }),
		});

		try {
			const read = session.getToolByName("read");
			expect(read).toBeDefined();
			expect(textOf(await read!.execute("call-10", { value: "x" }, undefined, undefined))).toContain(
				"read executed",
			);
			expect(executions).toEqual(["read:call-10"]);
		} finally {
			await session.dispose();
		}
	});

	it("authorizes a tool with declared read semantics against the capability dictionary", async () => {
		const executions: string[] = [];
		const context = registerWorker([{ source: "builtin", name: "probe" }]);
		const probe = createProbeTool("probe", executions, "read");
		probe.matcherPaths = (args: unknown) =>
			args && typeof args === "object" && "path" in args && typeof args.path === "string" ? [args.path] : undefined;
		const wrapper = new LifecycleToolWrapper(
			probe,
			createLifecycleToolGuard(() => context, "builtin", probe),
		);

		// In-scope target: allowed by the read effect + readableRoots containment.
		const result = await wrapper.execute(
			"call-r1",
			{ value: "x", path: "src/file.ts" },
			undefined,
			undefined,
			{} as AgentToolContext,
		);
		expect(textOf(result)).toContain("probe executed");

		// Out-of-scope target: the same declared effect now fails containment.
		await expect(
			wrapper.execute(
				"call-r2",
				{ value: "x", path: "../outside.ts" },
				undefined,
				undefined,
				{} as AgentToolContext,
			),
		).rejects.toThrow(/target_outside_scope/);
		expect(executions).toEqual(["probe:call-r1"]);
	});

	it("enforces declared write semantics through the builtin adapter target fields", async () => {
		const executions: string[] = [];
		const context = registerLifecycleExecutionContext({
			mode: "hierarchical-v1",
			role: "worker",
			runId: "run-guard",
			nodeId: "node-guard",
			attemptId: "attempt-guard",
			policyEpoch: 1,
			usableCapabilities: [{ source: "builtin", name: "write" }],
			repoRoot: process.cwd(),
			readableRoots: ["."],
			writableRoots: ["src"],
			allowExternalWrite: false,
		});
		const write = createProbeTool("write", executions, "write");
		const wrapper = new LifecycleToolWrapper(
			write,
			createLifecycleToolGuard(() => context, "builtin", write),
		);

		// The adapter maps `path` for builtin `write`: inside writableRoots passes.
		expect(
			textOf(await wrapper.execute("call-w1", { path: "src/out.ts" }, undefined, undefined, {} as AgentToolContext)),
		).toContain("write executed");

		// A target outside writableRoots is denied by the write_resource action.
		await expect(
			wrapper.execute("call-w2", { path: "other/out.ts" }, undefined, undefined, {} as AgentToolContext),
		).rejects.toThrow(/target_outside_scope/);
		expect(executions).toEqual(["write:call-w1"]);
	});

	it("fails closed for a tool with undeclared semantics under a bound context, but stays legacy passthrough unbound", async () => {
		const executions: string[] = [];
		const context = registerWorker([{ source: "builtin", name: "probe" }]);
		const undeclared = createProbeTool("probe", executions);
		delete undeclared.approval;
		const bound = new LifecycleToolWrapper(
			undeclared,
			createLifecycleToolGuard(() => context, "builtin", undeclared),
		);

		await expect(
			bound.execute("call-u1", { value: "x" }, undefined, undefined, {} as AgentToolContext),
		).rejects.toThrow(/undeclared_tool_semantics/);
		expect(executions).toEqual([]);

		// No host-minted context: the same undeclared tool is untouched legacy dispatch.
		const unbound = new LifecycleToolWrapper(
			undeclared,
			createLifecycleToolGuard(() => undefined, "builtin", undeclared),
		);
		expect(
			textOf(await unbound.execute("call-u2", { value: "x" }, undefined, undefined, {} as AgentToolContext)),
		).toContain("probe executed");
		expect(executions).toEqual(["probe:call-u2"]);
	});

	it("fails closed for a declared read/write tool with no declared targets and no adapter mapping", async () => {
		const executions: string[] = [];
		const context = registerWorker([{ source: "custom", name: "probe" }]);
		const probe = createProbeTool("probe", executions, "read");
		const wrapper = new LifecycleToolWrapper(
			probe,
			createLifecycleToolGuard(() => context, "custom", probe),
		);

		await expect(
			wrapper.execute("call-t1", { value: "x" }, undefined, undefined, {} as AgentToolContext),
		).rejects.toThrow(/undeclared_tool_targets/);
		expect(executions).toEqual([]);
	});

	it("never routes a semantics denial through tool_result hooks", async () => {
		const executions: string[] = [];
		const trace = emptyTrace();
		const context = registerWorker([{ source: "builtin", name: "probe" }]);
		const runner = createStubRunner(trace, {
			onToolCall: () => undefined,
			onToolResult: () => ({ isError: false, content: [{ type: "text", text: "cleared" }] }),
		});
		const undeclared = createProbeTool("probe", executions);
		delete undeclared.approval;
		const wrapper = new ExtensionToolWrapper(
			undeclared,
			runner,
			createLifecycleToolGuard(() => context, "builtin", undeclared),
		);

		await expect(
			wrapper.execute("call-d1", { value: "x" }, undefined, undefined, {} as AgentToolContext),
		).rejects.toThrow(/undeclared_tool_semantics/);
		// The denial threw before tool_call and tool_result ever saw the call.
		expect(trace.toolCalls).toEqual([]);
		expect(trace.toolResults).toEqual([]);
		expect(executions).toEqual([]);
	});
});
