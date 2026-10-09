import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { Effort } from "@pk-nerdsaver-ai/pi-catalog/effort";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import {
	applyFastModeCommand,
	formatFastModeStatus,
} from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/helpers/fast";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

type FastModeScope = "both" | "openai" | "claude";

describe("fast mode scope", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-fast-mode-scope-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	async function createSession(fastModeScope?: FastModeScope, selectedModel?: Model<Api>): Promise<AgentSession> {
		const model = selectedModel ?? getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled test model to exist");
		}

		const settings = fastModeScope === undefined ? Settings.isolated() : Settings.isolated({ fastModeScope });
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(model.provider, "anthropic-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});
		return session;
	}

	it("scopes enabled fast mode to OpenAI when configured", async () => {
		const session = await createSession("openai");

		session.setFastMode(true);

		expect(session.serviceTier).toBe("openai-only");
	});

	it("scopes enabled fast mode to Claude when configured", async () => {
		const session = await createSession("claude");

		session.setFastMode(true);

		expect(session.serviceTier).toBe("claude-only");
	});

	it("defaults enabled fast mode to priority for both providers", async () => {
		const session = await createSession();

		session.setFastMode(true);

		expect(session.serviceTier).toBe("priority");
	});

	it("clears the service tier when disabled", async () => {
		const session = await createSession("openai");
		session.setFastMode(true);

		session.setFastMode(false);

		expect(session.serviceTier).toBeUndefined();
	});

	it("does not broaden an already enabled scoped tier", async () => {
		const session = await createSession("claude");
		session.setFastMode(true);
		expect(session.serviceTier).toBe("claude-only");
		session.settings.set("fastModeScope", "both");

		session.setFastMode(true);

		expect(session.serviceTier).toBe("claude-only");
	});

	const sol = buildModel({
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
	});

	it("selects both Sol speeds, reports the selected mode, and records transitions", async () => {
		const session = await createSession(undefined, sol);
		expect(applyFastModeCommand(session, "fast")).toBe("Fast mode enabled.");
		expect(session.serviceTier).toBe("fast");
		expect(session.isFastModeActive()).toBe(true);
		expect(applyFastModeCommand(session, "ultrafast")).toBe("Ultrafast mode enabled.");
		expect(session.serviceTier).toBe("ultrafast");
		expect(session.isFastModeEnabled()).toBe(true);
		expect(session.isFastModeActive()).toBe(true);
		expect(formatFastModeStatus(session)).toBe("ultrafast");
		expect(applyFastModeCommand(session, "status")).toBe("Fast mode is ultrafast.");
		expect(
			session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "service_tier_change")
				.map(entry => entry.serviceTier),
		).toEqual(["fast", "ultrafast"]);
		expect(session.toggleFastMode()).toBe(false);
		expect(session.serviceTier).toBeUndefined();
	});

	it("preserves provider scope for Sol /fast on and accepts persisted speed settings", async () => {
		const session = await createSession(undefined, sol);
		expect(applyFastModeCommand(session, "on")).toBe("Fast mode enabled.");
		expect(session.serviceTier).toBe("priority");
		for (const tier of ["fast", "ultrafast"] as const) {
			session.settings.set("serviceTier", tier);
			expect(session.settings.get("serviceTier")).toBe(tier);
		}
	});

	it.each(["both", "openai", "claude"] as const)("preserves %s scope when switching from Sol", async scope => {
		const session = await createSession(scope, sol);
		applyFastModeCommand(session, "on");
		expect(session.isFastModeActive()).toBe(scope !== "claude");

		for (const provider of ["openai", "anthropic"] as const) {
			const model = getBundledModel(provider, provider === "openai" ? "gpt-4o" : "claude-sonnet-4-5");
			if (!model) throw new Error(`Missing bundled ${provider} model`);
			authStorage.setRuntimeApiKey(provider, "test-token");
			await session.setModel(model);
			expect(session.isFastModeActive()).toBe(
				scope === "both" || scope === (provider === "openai" ? "openai" : "claude"),
			);
			applyFastModeCommand(session, "on");
			expect(session.serviceTier).toBe(
				scope === "both" ? "priority" : scope === "openai" ? "openai-only" : "claude-only",
			);
		}
	});

	it("rejects explicit Sol speeds on other providers without changing the tier", async () => {
		const session = await createSession();
		session.setFastMode(true);
		expect(applyFastModeCommand(session, "ultrafast")).toContain("requires GPT-6.1 Sol");
		expect(session.serviceTier).toBe("priority");
		session.setServiceTier("ultrafast");
		expect(session.isFastModeActive()).toBe(false);
		expect(applyFastModeCommand(session, "off")).toBe("Fast mode disabled.");
		expect(session.serviceTier).toBeUndefined();
	});
});
