import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { runEvalAgent } from "@pk-nerdsaver-ai/pi-coding-agent/eval/agent-bridge";
import { buildSystemPrompt } from "@pk-nerdsaver-ai/pi-coding-agent/system-prompt";
import { TaskTool } from "@pk-nerdsaver-ai/pi-coding-agent/task";
import * as taskDiscovery from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import * as taskExecutor from "@pk-nerdsaver-ai/pi-coding-agent/task/executor";
import { simpleSpawnError, withSimpleSpawnPermit } from "@pk-nerdsaver-ai/pi-coding-agent/task/simple-mode";
import { type AgentDefinition, type SingleResult, simpleTaskSchema } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";
import { createTools, type ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { type } from "arktype";

const generalAgent: AgentDefinition = {
	name: "task",
	description: "General agent",
	systemPrompt: "Work on task",
	model: ["openai/other-model"],
	source: "bundled",
};
const currentModel: Model<Api> = buildModel({
	id: "current-model",
	name: "Current Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

function createSession(settings: Settings, depth = 0): ToolSession {
	return {
		cwd: process.cwd(),
		settings,
		taskDepth: depth,
		getSessionSpawns: () => "*",
		getSessionFile: () => null,
		modelRegistry: { getAvailable: () => [currentModel] },
		getActiveModelString: () => "anthropic/current-model",
		getModelString: () => "anthropic/current-model",
	} as unknown as ToolSession;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("simple mode", () => {
	afterEach(() => vi.restoreAllMocks());

	it("renders direct-work guidance rather than proactive delegation", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: process.cwd(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["task"],
			workspaceTree: { rootPath: process.cwd(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			activeRepoContext: null,
			simpleMode: true,
			ultraMode: true,
			eagerTasks: true,
		});
		const rendered = systemPrompt.join("\n");
		expect(rendered).toContain("# Simple Mode");
		expect(rendered).toContain("Work directly by default");
		expect(rendered).not.toContain("# Proactive Delegation (Ultra Mode)");
	});

	it("offers only one general assignment schema and rejects old specialist calls", async () => {
		const settings = Settings.isolated({ "task.simpleMode": true, "task.simpleMaxAgents": 1 });
		const parsed = simpleTaskSchema({ assignment: "Do this", agent: "explore", model: "openai/other-model" });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect("agent" in parsed).toBe(false);
			expect("model" in parsed).toBe(false);
		}
		const tool = await TaskTool.create(createSession(settings));
		expect(tool.parameters({ assignment: "Do this" }) instanceof type.errors).toBe(false);
		expect(firstText(await tool.execute("call", { agent: "explore", assignment: "Do this" }))).toContain(
			"only supports the general task subagent",
		);
		expect(firstText(await tool.execute("call", { assignment: "Do this", model: "openai/other-model" }))).toContain(
			"Simple mode accepts only a general assignment",
		);
		settings.override("task.simpleMaxAgents", 0);
		expect(firstText(await tool.execute("call", { assignment: "Do this" }))).toContain("subagents turned off");
	});

	it("registers a root task for later toggles but withholds it from children", async () => {
		const settings = Settings.isolated({ "task.simpleMode": true, "task.simpleMaxAgents": 0 });
		const rootTools = await createTools(createSession(settings), ["task"]);
		const childTools = await createTools(createSession(settings, 1), ["task"]);
		expect(rootTools.some(tool => tool.name === "task")).toBe(true);
		expect(childTools.some(tool => tool.name === "task")).toBe(false);
	});

	it("blocks every eval agent bridge spawn and nested task spawns", async () => {
		const settings = Settings.isolated({ "task.simpleMode": true, "task.simpleMaxAgents": 0 });
		await expect(runEvalAgent({ prompt: "Do this" }, { session: createSession(settings) })).rejects.toThrow(
			"use the general task tool",
		);
		settings.override("task.simpleMaxAgents", 1);
		await expect(runEvalAgent({ prompt: "Do this" }, { session: createSession(settings) })).rejects.toThrow(
			"use the general task tool",
		);
		expect(simpleSpawnError(settings, 1)).toContain("nested subagents");
	});

	it("rejects direct subprocess calls outside the general task tool", async () => {
		const settings = Settings.isolated({ "task.simpleMode": true, "task.simpleMaxAgents": 1 });
		const options = {
			cwd: process.cwd(),
			agent: generalAgent,
			task: "Do this",
			index: 0,
			id: "Direct",
			settings,
			modelOverride: "anthropic/current-model",
			parentActiveModelPattern: "anthropic/current-model",
		};
		await expect(taskExecutor.runSubprocess(options)).rejects.toThrow("only permits the general task tool");
		await expect(
			taskExecutor.runSubprocess({ ...options, simpleModeAuthorized: true, modelOverride: "openai/other-model" }),
		).rejects.toThrow("parent's current model");
	});

	it("routes the general task child to the active parent model despite agent defaults", async () => {
		const settings = Settings.isolated({ "task.simpleMode": true, "task.simpleMaxAgents": 1 });
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [generalAgent], projectAgentsDir: null });
		const result: SingleResult = {
			index: 0,
			id: "General",
			agent: "task",
			agentSource: "bundled",
			task: "Do this",
			exitCode: 0,
			output: "Done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		};
		const spawn = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(result);
		const tool = await TaskTool.create(createSession(settings));
		const response = await tool.execute("call", { assignment: "Do this" });
		expect(firstText(response)).toContain("Done");
		expect(firstText(response)).not.toContain("Tailored specialists");
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn.mock.calls[0]?.[0].modelOverride).toEqual(["anthropic/current-model"]);
	});

	it("shares a live concurrency limit and releases slots after failures", async () => {
		const settings = Settings.isolated({ "task.simpleMode": true, "task.simpleMaxAgents": 1 });
		const first = Promise.withResolvers<void>();
		const started: string[] = [];
		const one = withSimpleSpawnPermit(settings, async () => {
			started.push("one");
			await first.promise;
		});
		const two = withSimpleSpawnPermit(settings, async () => {
			started.push("two");
			throw new Error("child failed");
		});
		expect(started).toEqual(["one"]);
		first.resolve();
		await one;
		await expect(two).rejects.toThrow("child failed");
		expect(started).toEqual(["one", "two"]);
		settings.override("task.simpleMaxAgents", 0);
		await expect(withSimpleSpawnPermit(settings, async () => {})).rejects.toThrow("subagents turned off");
	});

	it("rejects queued work when subagents are turned off", async () => {
		const settings = Settings.isolated({ "task.simpleMode": true, "task.simpleMaxAgents": 1 });
		const first = Promise.withResolvers<void>();
		const one = withSimpleSpawnPermit(settings, () => first.promise);
		const runQueued = vi.fn(async () => {});
		const queued = withSimpleSpawnPermit(settings, runQueued);
		settings.override("task.simpleMaxAgents", 0);
		first.resolve();
		await one;
		await expect(queued).rejects.toThrow("subagents turned off");
		expect(runQueued).not.toHaveBeenCalled();
	});
});
