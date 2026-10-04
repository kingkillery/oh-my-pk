import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { runEvalAgent } from "@pk-nerdsaver-ai/pi-coding-agent/eval/agent-bridge";
import type { LocalProtocolOptions } from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls";
import type { MCPManager } from "@pk-nerdsaver-ai/pi-coding-agent/mcp";
import {
	createHostRootExecutionContext,
	registerLifecycleExecutionContext,
} from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/lifecycle-authority";
import * as taskDiscovery from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import * as taskExecutor from "@pk-nerdsaver-ai/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { getAgentDir, setAgentDir, TempDir } from "@pk-nerdsaver-ai/pi-utils";
import * as isolationRunner from "../../src/task/isolation-runner";
import { createTestEnvelope, createTestPolicy, createTestSpawnAuthority } from "../helpers/lifecycle-fixtures";

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
	// The durable admission builder opens the process-lifetime operational
	// store lazily; redirect the agent dir before the first bound spawn so
	// test admissions write to a temp DB, not the operator's store.
	let agentDir: TempDir;
	let originalAgentDir: string;
	beforeAll(() => {
		originalAgentDir = getAgentDir();
		agentDir = TempDir.createSync("@pi-agent-bridge-");
		setAgentDir(agentDir.path());
	});
	afterAll(() => {
		setAgentDir(originalAgentDir);
		// The process-lifetime admission store keeps its SQLite WAL open by
		// design, so the temp dir may still be locked on Windows; removal is
		// best-effort (the OS temp cleaner reclaims it).
		try {
			agentDir.removeSync();
		} catch {
			// store handle still open — leave the dir
		}
	});
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
	it("permits agent() for a durable root issuer and preserves legacy without a context", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
			tools: ["read"],
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult());

		// A bound child issues under its own bound context; a root session
		// issues under the root-branded context installed at bootstrap. The
		// envelope delegates exactly the agent's declared tool ceiling.
		const capabilities = [
			{ source: "builtin" as const, name: "read" },
			{ source: "builtin" as const, name: "yield" },
		];
		const issuer = createHostRootExecutionContext({
			sessionId: "root-session",
			policy: createTestPolicy(),
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

		// Authorized issuer: admission mints a bound child, the spawn runs.
		const authorizedSession = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			getLifecycleIssuerContext: () => issuer,
		} as unknown as ToolSession;
		await runEvalAgent({ prompt: "do work", agent: "task" }, { session: authorizedSession });
		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		expect(runSubprocessSpy.mock.calls[0]?.[0]?.lifecycle).toBeDefined();

		// Legacy session with no accessor: unchanged behavior.
		const legacySession = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		} as unknown as ToolSession;
		await runEvalAgent({ prompt: "do work", agent: "task" }, { session: legacySession });
		expect(runSubprocessSpy).toHaveBeenCalledTimes(2);
		expect(runSubprocessSpy.mock.calls[1]?.[0]?.lifecycle).toBeUndefined();
	});

	it("retains a bound isolated child manifest when temporary eval artifacts would otherwise be swept", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
			tools: ["read"],
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({
			repoRoot: "/tmp",
			baseline: {},
		} as never);
		const isolated = vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async options => {
			await fs.writeFile(`${options.artifactsDir}/bound.manifest-ref.json`, "ack", "utf8");
			return createResult();
		});
		vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "",
			changesApplied: true,
			hadAnyChanges: true,
			mergedBranchForNestedPatches: false,
		});
		const capabilities = [
			{ source: "builtin" as const, name: "read" },
			{ source: "builtin" as const, name: "yield" },
		];
		const issuer = createHostRootExecutionContext({
			sessionId: "root-retained-artifacts",
			policy: createTestPolicy(),
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
		const session = {
			cwd: "/tmp",
			settings: Settings.isolated({ "task.isolation.mode": "rcopy" }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			getLifecycleIssuerContext: () => issuer,
		} as unknown as ToolSession;
		try {
			await runEvalAgent({ prompt: "do work", agent: "task", isolated: true }, { session });
			const artifactsDir = isolated.mock.calls[0]?.[0]?.artifactsDir;
			expect(artifactsDir).toBeString();
			expect(await Bun.file(`${artifactsDir}/bound.manifest-ref.json`).exists()).toBe(true);
		} finally {
			const artifactsDir = isolated.mock.calls[0]?.[0]?.artifactsDir;
			if (artifactsDir) await fs.rm(artifactsDir, { recursive: true, force: true });
		}
	});
});
