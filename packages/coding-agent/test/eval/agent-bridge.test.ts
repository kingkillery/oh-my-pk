import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { runEvalAgent } from "@pk-nerdsaver-ai/pi-coding-agent/eval/agent-bridge";
import type { LocalProtocolOptions } from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls";
import type { MCPManager } from "@pk-nerdsaver-ai/pi-coding-agent/mcp";
import { registerLifecycleExecutionContext } from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/lifecycle-authority";
import * as taskDiscovery from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import * as taskExecutor from "@pk-nerdsaver-ai/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";

function createResult(): SingleResult {
	return {
		index: 0,
		id: "0-Task",
		agent: "task",
		agentSource: "bundled",
		task: "do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

describe("runEvalAgent", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards session-scoped MCP and local protocol options", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult());

		const mcpManager = { sentinel: "mcp" } as unknown as MCPManager;
		const localProtocolOptions: LocalProtocolOptions = {
			getArtifactsDir: () => "/tmp/parent-artifacts",
			getSessionId: () => "parent-session",
		};
		const session = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			mcpManager,
			localProtocolOptions,
			getAgentId: () => "BridgeParent",
		} as unknown as ToolSession;

		await runEvalAgent({ prompt: "do work", agent: "task" }, { session });

		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		const options = runSubprocessSpy.mock.calls[0]?.[0];
		expect(options?.mcpManager).toBe(mcpManager);
		expect(options?.localProtocolOptions).toBe(localProtocolOptions);
		expect(options?.parentAgentId).toBe("BridgeParent");
	});

	it("denies agent() for a registered worker before any allocation", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult());

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
		const session = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			getLifecycleExecutionContext: () => worker,
		} as unknown as ToolSession;

		// The bridge must fail closed with the typed denial BEFORE allocating
		// an artifacts dir or reserving an output id.
		await expect(runEvalAgent({ prompt: "do work", agent: "task" }, { session })).rejects.toThrow(
			/leaf_delegation_denied/,
		);
		expect(runSubprocessSpy).not.toHaveBeenCalled();
	});

	it("permits agent() for a registered root-planner and preserves legacy without a context", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult());

		const planner = registerLifecycleExecutionContext({
			mode: "hierarchical-v1",
			role: "root-planner",
			runId: "run-1",
			nodeId: "node-root",
			attemptId: "att-root",
			policyEpoch: 1,
			usableCapabilities: [{ source: "builtin", name: "task" }],
			repoRoot: "/tmp",
			readableRoots: ["src"],
			writableRoots: ["src"],
			allowExternalWrite: false,
		});

		// Authorized parent: guard passes, the spawn runs.
		const authorizedSession = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			getLifecycleExecutionContext: () => planner,
		} as unknown as ToolSession;
		await runEvalAgent({ prompt: "do work", agent: "task" }, { session: authorizedSession });
		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);

		// Legacy session with no accessor: unchanged behavior.
		const legacySession = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		} as unknown as ToolSession;
		await runEvalAgent({ prompt: "do work", agent: "task" }, { session: legacySession });
		expect(runSubprocessSpy).toHaveBeenCalledTimes(2);
	});
});
