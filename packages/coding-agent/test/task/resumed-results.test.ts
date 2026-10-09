import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import { createMockModel, type MockResponse } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentProtocolHandler } from "../../src/internal-urls/agent-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { trackResumedSubagentRuns } from "../../src/task/executor";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../src/task/types";
import { YieldTool } from "../../src/tools/yield";
import { EventBus } from "../../src/utils/event-bus";

describe("IRC-reactivated task results", () => {
	const cleanups: Array<() => Promise<void>> = [];
	const resetGlobals = () => {
		AsyncJobManager.resetForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	};
	beforeEach(resetGlobals);
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		resetGlobals();
	});

	async function setup(response: MockResponse) {
		const tempDir = TempDir.createSync("ompk-resumed-results-");
		const auth = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		auth.setRuntimeApiKey("mock", "test-key");
		const model = createMockModel({ responses: [{ content: ["initial result"] }, response] });
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		const yieldTool = new YieldTool({
			cwd: tempDir.path(),
			hasUI: false,
			settings,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
		});
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model: model.model, systemPrompt: ["Test"], tools: [yieldTool], messages: [] },
				streamFn: model.stream,
			}),
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(auth),
			agentId: "Worker",
			agentKind: "sub",
		});
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "running" });
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			session,
			status: "idle",
		});
		const delivered = Promise.withResolvers<string>();
		const manager = new AsyncJobManager({ onJobComplete: (_id, text) => delivered.resolve(text) });
		AsyncJobManager.setInstance(manager);
		const eventBus = new EventBus();
		const started = Promise.withResolvers<SubagentLifecyclePayload>();
		const events: SubagentLifecyclePayload[] = [];
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
			const event = payload as SubagentLifecyclePayload;
			events.push(event);
			if (event.status === "started") started.resolve(event);
		});
		let initialRunSettled = false;
		const unsubscribe = trackResumedSubagentRuns(session, {
			id: "Worker",
			index: 0,
			agent: { name: "worker", description: "worker", systemPrompt: "Test", source: "bundled" },
			task: "initial assignment",
			parentAgentId: "Main",
			softRequestBudget: 0,
			maxRuntimeMs: 0,
			eventBus,
			artifactsDir: sessionManager.getArtifactsDir() ?? undefined,
			sessionFile: sessionManager.getSessionFile() ?? undefined,
			isInitialRunSettled: () => initialRunSettled,
		});
		cleanups.push(async () => {
			await unsubscribe();
			await session.dispose();
			await manager.dispose();
			await sessionManager.close();
			auth.close();
			tempDir.removeSync();
		});
		await session.prompt("initial assignment");
		expect(manager.getAllJobs()).toHaveLength(0);
		await Bun.write(path.join(sessionManager.getArtifactsDir()!, "Worker.md"), "initial result");
		initialRunSettled = true;
		const receipt = await IrcBus.global().send({ from: "Main", to: "Worker", body: "follow up" });
		expect(receipt.outcome).toBe("woken");
		const event = await started.promise;
		expect(event.jobId).toBeDefined();
		expect(event.runId).not.toBe("Worker");
		const job = manager.getJob(event.jobId!);
		if (!job) throw new Error("Resumed job was not registered");
		expect(job.ownerId).toBe("Main");
		return { manager, job, event, events, delivered: delivered.promise, stop: unsubscribe };
	}

	it("publishes a fresh parent-readable output and completion after a real IRC wake", async () => {
		const { job, event, events, delivered } = await setup({ content: ["resumed result"], delayMs: 20 });
		expect(job.status).toBe("running");
		await job.promise;
		expect(job.status).toBe("completed");
		expect(await delivered).toContain(`agent://${event.runId}`);
		const handler = new AgentProtocolHandler();
		expect((await handler.resolve(parseInternalUrl(`agent://${event.runId}`))).content).toContain("resumed result");
		expect((await handler.resolve(parseInternalUrl("agent://Worker"))).content).toBe("initial result");
		expect(events.map(item => item.status)).toEqual(["started", "completed"]);
		expect(events[1]?.runId).toBe(event.runId);
		expect(events[1]?.jobId).toBe(event.jobId);
	});

	it("accepts a structured yield despite its internal termination signal", async () => {
		const { job, event, events, delivered } = await setup({
			content: [{ type: "toolCall", name: "yield", arguments: { result: { data: { answer: "yielded result" } } } }],
		});
		await job.promise;
		expect(job.status).toBe("completed");
		expect(await delivered).toContain("yielded result");
		expect(events.at(-1)?.status).toBe("completed");
		const resource = await new AgentProtocolHandler().resolve(parseInternalUrl(`agent://${event.runId}`));
		expect(JSON.parse(resource.content)).toEqual({ answer: "yielded result" });
	});

	it("delivers failure output through the fresh job and handle", async () => {
		const { job, event, events, delivered } = await setup({ stopReason: "error", errorMessage: "follow-up failed" });
		await job.promise;
		expect(job.status).toBe("failed");
		const text = await delivered;
		expect(text).toContain(`agent://${event.runId}`);
		expect(text).toContain("follow-up failed");
		expect(events.at(-1)?.status).toBe("failed");
		expect(
			(await new AgentProtocolHandler().resolve(parseInternalUrl(`agent://${event.runId}`))).content,
		).toBeTruthy();
	});

	it("settles and persists a cancelled result when tracking stops during an active run", async () => {
		const { job, event, events, stop } = await setup({ content: ["late result"], delayMs: 500 });
		await stop();
		await job.promise;
		expect(job.status).toBe("failed");
		expect(events.at(-1)?.status).toBe("aborted");
		expect(job.errorText).toContain(`agent://${event.runId}`);
		const resource = await new AgentProtocolHandler().resolve(parseInternalUrl(`agent://${event.runId}`));
		expect(resource.content).toBeTruthy();
		expect(resource.content).not.toContain("initial result");
	});

	it("cancels the resumed run while retaining a readable recovery handle", async () => {
		const { manager, job, event, events } = await setup({ content: ["late result"], delayMs: 500 });
		expect(manager.cancel(job.id, { ownerId: "Main" })).toBe(true);
		await job.promise;
		expect(job.status).toBe("cancelled");
		expect(job.errorText ?? job.resultText).toContain(`agent://${event.runId}`);
		expect(events.at(-1)?.status).toBe("aborted");
		expect(
			(await new AgentProtocolHandler().resolve(parseInternalUrl(`agent://${event.runId}`))).content,
		).toBeTruthy();
	});
});
