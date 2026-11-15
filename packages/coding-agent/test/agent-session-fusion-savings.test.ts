import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import type { AgentTurnEndContext } from "@pk-nerdsaver-ai/pi-agent-core/types";
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@pk-nerdsaver-ai/pi-ai";
import { createMockModel } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { loadExtensions } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@pk-nerdsaver-ai/pi-utils";

function makeTestModel(
	provider: string,
	id: string,
	name: string,
	cost: Model<Api>["cost"] = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
): Model<Api> {
	return buildModel({
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

const defaultModel = makeTestModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet");
const taskModel = makeTestModel("anthropic", "claude-haiku", "Claude Haiku");
const slowModel = makeTestModel("anthropic", "claude-opus-4-8", "Claude Opus");

interface TestHarness {
	session: AgentSession;
	agent: Agent;
	onTurnEndFn: (messages: AgentMessage[], signal?: AbortSignal, context?: AgentTurnEndContext) => Promise<void> | void;
	cleanup: () => Promise<void>;
}

interface SavingsHarnessModels {
	defaultModel?: Model<Api>;
	taskModel?: Model<Api>;
	slowModel?: Model<Api>;
}

interface SavingsHarnessOptions {
	compactionShortCircuit?: boolean;
	seedCompactionHistory?: boolean;
}

async function createSavingsHarness(
	fusionOverrides: Record<string, unknown> = {},
	modelOverrides: SavingsHarnessModels = {},
	harnessOptions: SavingsHarnessOptions = {},
): Promise<TestHarness> {
	const activeDefaultModel = modelOverrides.defaultModel ?? defaultModel;
	const activeTaskModel = modelOverrides.taskModel ?? taskModel;
	const activeSlowModel = modelOverrides.slowModel ?? slowModel;
	const tempDir = TempDir.createSync("@savings-test-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

	for (const model of [activeDefaultModel, activeTaskModel, activeSlowModel]) {
		authStorage.setRuntimeApiKey(model.provider, "test-key");
	}
	modelRegistry.getAvailable = () => [activeDefaultModel, activeTaskModel, activeSlowModel];
	modelRegistry.hasConfiguredAuth = () => true;

	const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));

	let extensionRunner: ExtensionRunner | undefined;
	if (harnessOptions.compactionShortCircuit) {
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => ({',
				"\t\tcompaction: {",
				'\t\t\tsummary: "compacted",',
				"\t\t\tshortSummary: undefined,",
				"\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\tdetails: {},",
				"\t\t},",
				"\t}));",
				"}",
			].join("\n"),
		);
		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
	}
	if (harnessOptions.seedCompactionHistory) {
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: activeDefaultModel.id,
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({ role: "user", content: "again", timestamp: Date.now() });
	}

	let capturedOnTurnEnd:
		| ((messages: AgentMessage[], signal?: AbortSignal, context?: AgentTurnEndContext) => Promise<void> | void)
		| undefined;

	const mockModel = createMockModel({ handler: { content: ["Done"] } });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: activeDefaultModel,
			systemPrompt: ["You are a test assistant."],
			tools: [],
			messages: [],
		},
		streamFn: mockModel.stream,
	});

	const origSetOnTurnEnd = agent.setOnTurnEnd.bind(agent);
	agent.setOnTurnEnd = fn => {
		origSetOnTurnEnd(fn);
		if (fn) {
			capturedOnTurnEnd = fn;
		}
	};

	const settings = Settings.isolated({
		"fusion.enabled": true,
		"fusion.mode": "token-savings",
		"fusion.tokenSavingsDefaultCallLimit": 2,
		...(harnessOptions.compactionShortCircuit
			? { "compaction.keepRecentTokens": 1, "compaction.autoContinue": false }
			: {}),
		modelRoles: {
			default: "anthropic/claude-sonnet-4-5",
			task: "anthropic/claude-haiku",
			slow: "anthropic/claude-opus-4-8",
		},
		...fusionOverrides,
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		extensionRunner,
	});

	return {
		session,
		agent,
		onTurnEndFn: async (messages, signal, context) => {
			if (capturedOnTurnEnd) {
				await capturedOnTurnEnd(messages, signal, context);
			}
		},
		cleanup: async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		},
	};
}

const cleanups: Array<() => Promise<void>> = [];
const spies: Array<{ mockRestore: () => void }> = [];

afterEach(async () => {
	while (spies.length > 0) {
		spies.pop()?.mockRestore();
	}
	while (cleanups.length > 0) {
		const fn = cleanups.pop();
		if (fn) await fn();
	}
});

function makeContinuingContext(): AgentTurnEndContext {
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "file content" }],
		isError: false,
		timestamp: Date.now(),
	};
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "foo.txt" },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.001, total: 0.003 },
		},
		timestamp: Date.now(),
	};
	return {
		message: assistantMessage,
		toolResults: [toolResult],
		willContinue: true,
	};
}

describe("AgentSession — Fusion Token Savings Mode call limit", () => {
	it("allows call 1 on the default model without switching", async () => {
		const harness = await createSavingsHarness();
		cleanups.push(harness.cleanup);

		const context = makeContinuingContext();
		await harness.onTurnEndFn([context.message], undefined, context);

		expect(harness.session.model?.id).toBe(defaultModel.id);
	});

	it("transitions to the task model after call 2 on a continuing turn", async () => {
		const harness = await createSavingsHarness();
		cleanups.push(harness.cleanup);

		const context = makeContinuingContext();

		// Call 1
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(defaultModel.id);

		// Call 2
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(taskModel.id);

		// Steered reminder injected
		const steeringQueue = harness.agent.peekSteeringQueue();
		expect(steeringQueue.length).toBeGreaterThan(0);
		const lastSteer = steeringQueue[steeringQueue.length - 1];
		const steerText =
			lastSteer && "content" in lastSteer && typeof lastSteer.content === "string" ? lastSteer.content : "";
		expect(steerText).toContain("Fusion Token Savings: The default model call limit");
	});
	it("restores the default model when a new user prompt begins", async () => {
		const harness = await createSavingsHarness();
		cleanups.push(harness.cleanup);

		const context = makeContinuingContext();

		// Call 1 and 2 trigger switch to task model
		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(taskModel.id);

		// User submits a new prompt
		await harness.session.prompt("Next simple question", { userInitiated: true });

		// Model restored to default model
		expect(harness.session.model?.id).toBe(defaultModel.id);
	});

	it("enforces the call limit again after each next-prompt restoration", async () => {
		const harness = await createSavingsHarness();
		cleanups.push(harness.cleanup);
		const context = makeContinuingContext();

		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(taskModel.id);

		for (const prompt of ["Second question", "Third question"]) {
			// The preceding synthetic callbacks leave a reminder queued; a real
			// completed turn would already have consumed it on the task model.
			harness.agent.clearAllQueues();
			await harness.session.prompt(prompt, { userInitiated: true });
			expect(harness.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(harness.session.model?.id).toBe(defaultModel.id);

			// prompt() made the first default-model call; its next continuing
			// callback must hit the reset two-call limit, not latch a manual override.
			await harness.onTurnEndFn([context.message], undefined, context);
			expect(harness.session.model?.id).toBe(taskModel.id);
			expect(harness.agent.peekSteeringQueue()).toHaveLength(1);
		}
	});

	it.each(["before", "after"] as const)("preserves a manual model choice %s next-prompt restoration", async timing => {
		const harness = await createSavingsHarness();
		cleanups.push(harness.cleanup);
		const context = makeContinuingContext();
		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);
		harness.agent.clearAllQueues();

		if (timing === "before") await harness.session.setModelTemporary(slowModel);
		await harness.session.prompt("Next question", { userInitiated: true });
		expect(harness.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		if (timing === "after") {
			expect(harness.session.model?.id).toBe(defaultModel.id);
			await harness.session.setModelTemporary(slowModel);
		}
		expect(harness.session.model?.id).toBe(slowModel.id);
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(slowModel.id);
		expect(harness.agent.peekSteeringQueue()).toHaveLength(0);

		// A detected manual override remains latched even if the user later
		// selects the default model again on another prompt.
		await harness.session.setModelTemporary(defaultModel);
		await harness.session.prompt("Keep my selected model", { userInitiated: true });
		expect(harness.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(defaultModel.id);
		expect(harness.agent.peekSteeringQueue()).toHaveLength(0);
	});

	it("keeps the selected autonomous planning model after repeated continuing calls", async () => {
		const harness = await createSavingsHarness({ "fusion.mode": "autonomous" });
		cleanups.push(harness.cleanup);
		const context = makeContinuingContext();
		for (let call = 0; call < 4; call++) await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(defaultModel.id);
		expect(harness.agent.peekSteeringQueue()).toHaveLength(0);
	});

	it("does not enforce the limit when fusion.mode is off", async () => {
		const harness = await createSavingsHarness({
			"fusion.mode": "off",
		});
		cleanups.push(harness.cleanup);

		const context = makeContinuingContext();
		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);

		expect(harness.session.model?.id).toBe(defaultModel.id);
	});

	it("emits model_changed when Fusion Token Savings switches to the task model and restores default", async () => {
		const harness = await createSavingsHarness();
		cleanups.push(harness.cleanup);

		const changedModelIds: Array<string | undefined> = [];
		const unsubscribe = harness.session.subscribe(event => {
			if (event.type === "model_changed") {
				changedModelIds.push(event.model?.id);
			}
		});

		const context = makeContinuingContext();
		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(changedModelIds).toEqual([taskModel.id]);

		harness.agent.clearAllQueues();
		await harness.session.prompt("Next question", { userInitiated: true });
		expect(changedModelIds).toEqual([taskModel.id, defaultModel.id]);

		// Re-setting the already-active model must not emit a redundant event.
		await harness.session.setModelTemporary(defaultModel);
		expect(changedModelIds).toEqual([taskModel.id, defaultModel.id]);

		unsubscribe();
	});
});
describe("AgentSession Fusion failure-streak escalation across tool cycles", () => {
	function emitToolResultEvent(agent: Agent, toolName: string, isError: boolean): void {
		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: `call-${toolName}-${Date.now()}`,
			toolName,
			content: [{ type: "text", text: isError ? "failed" : "ok" }],
			isError,
			timestamp: Date.now(),
		};
		agent.emitExternalEvent({ type: "message_end", message: toolResultMessage });
	}

	it("escalates back to frontier across intermediate read/edit/grep calls between failing tests", async () => {
		const harness = await createSavingsHarness({ "fusion.escalateFailureStreak": 3 });
		cleanups.push(harness.cleanup);

		const context = makeContinuingContext();
		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(taskModel.id);

		emitToolResultEvent(harness.agent, "bash", true);
		await Bun.sleep(0);
		emitToolResultEvent(harness.agent, "read", false);
		emitToolResultEvent(harness.agent, "edit", false);
		emitToolResultEvent(harness.agent, "bash", true);
		await Bun.sleep(0);
		emitToolResultEvent(harness.agent, "grep", false);
		emitToolResultEvent(harness.agent, "write", false);
		emitToolResultEvent(harness.agent, "todo", false);
		await Bun.sleep(0);
		expect(harness.session.model?.id).toBe(taskModel.id);

		emitToolResultEvent(harness.agent, "bash", true);
		await Bun.sleep(0);
		expect(harness.session.model?.id).toBe(defaultModel.id);
	});

	it("resets the failure streak when a verification command (bash/eval) succeeds", async () => {
		const harness = await createSavingsHarness({ "fusion.escalateFailureStreak": 3 });
		cleanups.push(harness.cleanup);

		const context = makeContinuingContext();
		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(taskModel.id);

		emitToolResultEvent(harness.agent, "bash", true);
		emitToolResultEvent(harness.agent, "bash", true);
		emitToolResultEvent(harness.agent, "bash", false);
		emitToolResultEvent(harness.agent, "bash", true);
		emitToolResultEvent(harness.agent, "bash", true);
		await Bun.sleep(0);

		expect(harness.session.model?.id).toBe(taskModel.id);
	});

	it("resets the failure streak when a turn settles cleanly on agent_end", async () => {
		const harness = await createSavingsHarness({ "fusion.escalateFailureStreak": 3 });
		cleanups.push(harness.cleanup);

		const context = makeContinuingContext();
		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(taskModel.id);

		emitToolResultEvent(harness.agent, "bash", true);
		emitToolResultEvent(harness.agent, "bash", true);
		await Bun.sleep(0);

		const settledAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Completed step." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: taskModel.id,
			stopReason: "stop",
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		harness.agent.emitExternalEvent({ type: "agent_end", messages: [settledAssistant] });
		await Bun.sleep(0);

		emitToolResultEvent(harness.agent, "bash", true);
		emitToolResultEvent(harness.agent, "bash", true);
		await Bun.sleep(0);
		expect(harness.session.model?.id).toBe(taskModel.id);
	});
});

describe("Fusion token-savings cache break-even & TTL stickiness", () => {
	const paidDefaultModel = makeTestModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet", {
		input: 3,
		output: 15,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	});
	const paidTaskModel = makeTestModel("anthropic", "claude-haiku", "Claude Haiku", {
		input: 1.0,
		output: 5,
		cacheRead: 0.1,
		cacheWrite: 1.25,
	});
	const zeroCostDefaultModel = makeTestModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet", {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});
	const zeroCostTaskModel = makeTestModel("anthropic", "claude-haiku", "Claude Haiku", {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});

	const paidFlashTaskModel = makeTestModel("google", "gemini-flash", "Gemini Flash", {
		input: 0.15,
		output: 0.6,
		cacheRead: 0.015,
		cacheWrite: 0,
	});
	// Unambiguous paid switch on a deep context: Sonnet prefill is expensive,
	// Gemini Flash is cheap and caches reads at 10% of its input rate.
	const deepPaidOverrides = {
		"fusion.tokenSavingsAmortizationCalls": 6,
		modelRoles: {
			default: "anthropic/claude-sonnet-4-5",
			task: "google/gemini-flash",
			slow: "anthropic/claude-opus-4-8",
		},
	};

	function makeDeepContext(options: { willContinue?: boolean; modelId?: string } = {}): AgentTurnEndContext {
		const willContinue = options.willContinue ?? true;
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-deep-1",
			toolName: "read",
			content: [{ type: "text", text: "deep file content" }],
			isError: false,
			timestamp: Date.now(),
		};
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: willContinue
				? [
						{
							type: "toolCall",
							id: "call-deep-1",
							name: "read",
							arguments: { path: "foo.txt" },
						},
					]
				: [{ type: "text", text: "Completed step." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: options.modelId ?? paidDefaultModel.id,
			stopReason: willContinue ? "toolUse" : "stop",
			usage: {
				input: 2_000,
				output: 500,
				cacheRead: 58_000,
				cacheWrite: 0,
				totalTokens: 60_500,
				cost: { input: 0.006, output: 0.0075, cacheRead: 0.0174, cacheWrite: 0, total: 0.0309 },
			},
			timestamp: Date.now(),
		};
		return {
			message: assistantMessage,
			toolResults: willContinue ? [toolResult] : [],
			willContinue,
		};
	}

	function emitToolResultEvent(agent: Agent, toolName: string, isError: boolean): void {
		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: `call-${toolName}-${Date.now()}`,
			toolName,
			content: [{ type: "text", text: isError ? "failed" : "ok" }],
			isError,
			timestamp: Date.now(),
		};
		agent.emitExternalEvent({ type: "message_end", message: toolResultMessage });
	}

	it("blocks unprofitable short switches on deep paid context until open todos or amortization justify prefill", async () => {
		const shortHarness = await createSavingsHarness(
			{ "fusion.tokenSavingsAmortizationCalls": 1 },
			{ defaultModel: paidDefaultModel, taskModel: paidTaskModel },
		);
		cleanups.push(shortHarness.cleanup);

		const deepContext = makeDeepContext();
		await shortHarness.onTurnEndFn([deepContext.message], undefined, deepContext);
		await shortHarness.onTurnEndFn([deepContext.message], undefined, deepContext);
		expect(shortHarness.session.model?.id).toBe(paidDefaultModel.id);
		expect(shortHarness.agent.peekSteeringQueue()).toHaveLength(0);

		const todoHarness = await createSavingsHarness(
			{ "fusion.tokenSavingsAmortizationCalls": 1 },
			{ defaultModel: paidDefaultModel, taskModel: paidTaskModel },
		);
		cleanups.push(todoHarness.cleanup);
		todoHarness.session.setTodoPhases([
			{
				name: "Execution",
				tasks: [
					{ content: "step 1", status: "pending" },
					{ content: "step 2", status: "pending" },
					{ content: "step 3", status: "pending" },
					{ content: "step 4", status: "pending" },
					{ content: "step 5", status: "pending" },
					{ content: "step 6", status: "pending" },
				],
			},
		]);

		await todoHarness.onTurnEndFn([deepContext.message], undefined, deepContext);
		await todoHarness.onTurnEndFn([deepContext.message], undefined, deepContext);
		expect(todoHarness.session.model?.id).toBe(paidTaskModel.id);
	});

	it.each([
		{
			label: "zero-cost subscription models",
			models: { defaultModel: zeroCostDefaultModel, taskModel: zeroCostTaskModel },
			overrides: {},
		},
		{
			label: "paid cheap taskModel",
			models: { defaultModel: paidDefaultModel, taskModel: paidTaskModel },
			overrides: { "fusion.tokenSavingsAmortizationCalls": 6 },
		},
	])("keeps sticky pi/task across rapid follow-up prompts within TTL ($label)", async ({ models, overrides }) => {
		const harness = await createSavingsHarness(overrides, models);
		cleanups.push(harness.cleanup);

		const continuingContext = makeDeepContext({ willContinue: true, modelId: models.defaultModel.id });
		await harness.onTurnEndFn([continuingContext.message], undefined, continuingContext);
		await harness.onTurnEndFn([continuingContext.message], undefined, continuingContext);
		expect(harness.session.model?.id).toBe(models.taskModel.id);

		const settledTaskContext = makeDeepContext({ willContinue: false, modelId: models.taskModel.id });
		await harness.onTurnEndFn([settledTaskContext.message], undefined, settledTaskContext);

		harness.agent.clearAllQueues();
		await harness.session.prompt("follow-up", { userInitiated: true });
		expect(harness.session.model?.id).toBe(models.taskModel.id);
	});

	it("restores defaultModel when idle time reaches >= 5 minutes (TTL expiry)", async () => {
		let currentNow = 1_700_000_000_000;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => currentNow);
		spies.push(nowSpy);

		const harness = await createSavingsHarness(
			{ "fusion.tokenSavingsAmortizationCalls": 6 },
			{ defaultModel: paidDefaultModel, taskModel: paidTaskModel },
		);
		cleanups.push(harness.cleanup);

		const continuingContext = makeDeepContext({ willContinue: true });
		await harness.onTurnEndFn([continuingContext.message], undefined, continuingContext);
		await harness.onTurnEndFn([continuingContext.message], undefined, continuingContext);
		expect(harness.session.model?.id).toBe(paidTaskModel.id);

		const settledTaskContext = makeDeepContext({ willContinue: false, modelId: paidTaskModel.id });
		await harness.onTurnEndFn([settledTaskContext.message], undefined, settledTaskContext);

		currentNow += 300_001;
		harness.agent.clearAllQueues();
		await harness.session.prompt("after idle", { userInitiated: true });
		expect(harness.session.model?.id).toBe(paidDefaultModel.id);
	});

	it("escalates back to defaultModel on failure streak while sticky on pi/task and keeps defaultModel on next prompt", async () => {
		const harness = await createSavingsHarness(
			{
				"fusion.tokenSavingsAmortizationCalls": 6,
				"fusion.escalateFailureStreak": 3,
			},
			{ defaultModel: paidDefaultModel, taskModel: paidTaskModel },
		);
		cleanups.push(harness.cleanup);

		const continuingContext = makeDeepContext({ willContinue: true });
		await harness.onTurnEndFn([continuingContext.message], undefined, continuingContext);
		await harness.onTurnEndFn([continuingContext.message], undefined, continuingContext);
		expect(harness.session.model?.id).toBe(paidTaskModel.id);

		const settledTaskContext = makeDeepContext({ willContinue: false, modelId: paidTaskModel.id });
		await harness.onTurnEndFn([settledTaskContext.message], undefined, settledTaskContext);

		harness.agent.clearAllQueues();
		await harness.session.prompt("follow-up", { userInitiated: true });
		expect(harness.session.model?.id).toBe(paidTaskModel.id);

		emitToolResultEvent(harness.agent, "bash", true);
		await Bun.sleep(0);
		emitToolResultEvent(harness.agent, "read", false);
		emitToolResultEvent(harness.agent, "edit", false);
		emitToolResultEvent(harness.agent, "bash", true);
		await Bun.sleep(0);
		expect(harness.session.model?.id).toBe(paidTaskModel.id);

		emitToolResultEvent(harness.agent, "bash", true);
		await Bun.sleep(0);
		expect(harness.session.model?.id).toBe(paidDefaultModel.id);

		harness.agent.clearAllQueues();
		await harness.session.prompt("next prompt after escalation", { userInitiated: true });
		expect(harness.session.model?.id).toBe(paidDefaultModel.id);
	});

	it("keeps pi/task sticky when the default prefix aged out while pi/task stayed warm", async () => {
		let currentNow = 1_700_000_000_000;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => currentNow);
		spies.push(nowSpy);

		const harness = await createSavingsHarness(deepPaidOverrides, {
			defaultModel: paidDefaultModel,
			taskModel: paidFlashTaskModel,
		});
		cleanups.push(harness.cleanup);

		const continuingContext = makeDeepContext({ willContinue: true });
		await harness.onTurnEndFn([continuingContext.message], undefined, continuingContext);
		await harness.onTurnEndFn([continuingContext.message], undefined, continuingContext);
		expect(harness.session.model?.id).toBe(paidFlashTaskModel.id);

		// Let the default prefix fall out of the TTL while pi/task keeps working:
		// three settled task steps put the tail past the sticky call budget.
		currentNow += 300_001;
		const settledTaskContext = makeDeepContext({ willContinue: false, modelId: paidFlashTaskModel.id });
		for (let step = 0; step < 3; step++) {
			await harness.onTurnEndFn([settledTaskContext.message], undefined, settledTaskContext);
		}

		// Restoring the cold default would cost more over the amortization horizon
		// than staying on the warm task prefix, so pi/task remains sticky.
		harness.agent.clearAllQueues();
		await harness.session.prompt("follow-up", { userInitiated: true });
		expect(harness.session.model?.id).toBe(paidFlashTaskModel.id);

		// Once pi/task itself idles past the TTL, the default model comes back.
		currentNow += 300_001;
		harness.agent.clearAllQueues();
		await harness.session.prompt("after idle", { userInitiated: true });
		expect(harness.session.model?.id).toBe(paidDefaultModel.id);
	});

	it("restores the default model on the first prompt after compaction drops the watermarks", async () => {
		const harness = await createSavingsHarness(
			deepPaidOverrides,
			{ defaultModel: paidDefaultModel, taskModel: paidFlashTaskModel },
			{ compactionShortCircuit: true, seedCompactionHistory: true },
		);
		cleanups.push(harness.cleanup);

		const continuingContext = makeDeepContext({ willContinue: true });
		await harness.onTurnEndFn([continuingContext.message], undefined, continuingContext);
		await harness.onTurnEndFn([continuingContext.message], undefined, continuingContext);
		expect(harness.session.model?.id).toBe(paidFlashTaskModel.id);

		const settledTaskContext = makeDeepContext({ willContinue: false, modelId: paidFlashTaskModel.id });
		await harness.onTurnEndFn([settledTaskContext.message], undefined, settledTaskContext);

		await harness.session.compact();

		// A surviving task watermark would keep the short sticky tail on pi/task;
		// compaction invalidates every per-model prefix watermark instead.
		harness.agent.clearAllQueues();
		await harness.session.prompt("after compaction", { userInitiated: true });
		expect(harness.session.model?.id).toBe(paidDefaultModel.id);
	});
});
