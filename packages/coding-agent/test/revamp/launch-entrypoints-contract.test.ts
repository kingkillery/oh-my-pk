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
	type LifecycleExecutionContext,
	registerLifecycleExecutionContext,
} from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/lifecycle-authority";
import { AgentLifecycleManager } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@pk-nerdsaver-ai/pi-coding-agent/task";
import * as discoveryModule from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import * as executorModule from "@pk-nerdsaver-ai/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
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

	function createSession(contextAccessor?: () => LifecycleExecutionContext | undefined): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getModelString: () => "anthropic/claude-sonnet-4-5",
			getLifecycleExecutionContext: contextAccessor,
		} as unknown as ToolSession;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
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

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await TaskTool.create(createSession(() => planner));

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
});
