import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import { resolveThresholdTokens, shouldCompact } from "@pk-nerdsaver-ai/pi-agent-core/compaction";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { resolveColabCompactionSettings } from "@pk-nerdsaver-ai/pi-coding-agent/session/colab-compaction";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { assistantMsg, userMsg } from "./utilities";

const colab = buildModel({
	provider: "Orca (colab)",
	id: "orca",
	name: "Orca",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:1/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
});

describe("Colab compaction", () => {
	let session: AgentSession | undefined;
	let auth: AuthStorage | undefined;
	let temporary: TempDir | undefined;
	let server: Bun.Server<undefined> | undefined;
	afterEach(async () => {
		await session?.dispose();
		auth?.close();
		server?.stop(true);
		temporary?.removeSync();
		session = undefined;
		auth = undefined;
		server = undefined;
		temporary = undefined;
	});

	it("triggers maintenance with positive headroom on the served 8K window", () => {
		const configured = Settings.isolated().getGroup("compaction");
		const resolved = resolveColabCompactionSettings(colab, configured);
		const threshold = resolveThresholdTokens(8192, resolved);
		expect(threshold).toBeGreaterThan(0);
		expect(threshold + colab.maxTokens!).toBeLessThan(8192);
		expect(shouldCompact(threshold + 1, 8192, resolved)).toBe(true);
		expect(resolved.keepRecentTokens + resolved.reserveTokens).toBeLessThan(threshold * 0.8);
		expect(configured.keepRecentTokens).toBe(20000);
	});

	it("preserves explicit thresholds, smaller budgets, disabled maintenance and other providers", () => {
		const configured = Settings.isolated({
			"compaction.thresholdPercent": 60,
			"compaction.keepRecentTokens": 100,
			"compaction.reserveTokens": 200,
			"compaction.enabled": false,
		}).getGroup("compaction");
		const resolved = resolveColabCompactionSettings(colab, configured);
		expect(resolved.thresholdPercent).toBe(60);
		expect(resolved.keepRecentTokens).toBe(100);
		expect(resolved.reserveTokens).toBe(200);
		expect(shouldCompact(8000, 8192, resolved)).toBe(false);
		expect(
			resolveColabCompactionSettings(
				buildModel({ ...colab, provider: "local", compat: colab.compatConfig }),
				configured,
			),
		).toBe(configured);
	});

	async function createSession(summaryModel?: string) {
		temporary = TempDir.createSync("colab-compaction-");
		auth = await AuthStorage.create(path.join(temporary.path(), "auth.db"));
		const registry = new ModelRegistry(auth, path.join(temporary.path(), "models.yml"));
		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.model": summaryModel });
		const requests: string[] = [];
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as { model: string };
				requests.push(body.model);
				const chunk = {
					id: "summary",
					object: "chat.completion.chunk",
					created: 1,
					model: body.model,
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								content: "Continue editing the selected file; prior changes are saved.",
							},
							finish_reason: null,
						},
					],
				};
				return new Response(
					`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
					{
						headers: { "Content-Type": "text/event-stream" },
					},
				);
			},
		});
		registry.registerProvider("summary-service", {
			api: "openai-completions",
			apiKey: "test-key",
			baseUrl: `${server.url}v1`,
			models: [
				{
					id: "summary",
					name: "Summary",
					reasoning: false,
					input: ["text"],
					cost: colab.cost,
					contextWindow: 32768,
					maxTokens: 2048,
				},
			],
		});
		settings.setModelRole("smol", "summary-service/summary");
		session = new AgentSession({
			agent: new Agent({ initialState: { model: colab, systemPrompt: ["Continue the task"], tools: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
		});
		for (let i = 0; i < 3; i++) {
			for (const message of [userMsg(`Edit file ${i}`), assistantMsg(`Saved edit ${i}`)]) {
				session.agent.appendMessage(message);
				session.sessionManager.appendMessage(message);
			}
		}
		return { active: session, requests };
	}

	it("does not send history to an available API role without selection", async () => {
		const { active, requests } = await createSession();
		await expect(active.compact()).rejects.toThrow("Choose an authenticated Compaction Model");
		expect(requests).toEqual([]);
		expect(active.model).toBe(colab);
	});

	it("persists an explicitly selected API summary and keeps the Colab worker", async () => {
		const { active, requests } = await createSession("summary-service/summary");
		const result = await active.compact();
		expect(result.summary).toContain("prior changes are saved");
		expect(requests.length).toBeGreaterThan(0);
		expect(requests.every(model => model === "summary")).toBe(true);
		expect(active.model).toBe(colab);
		expect(active.messages[0].role).toBe("compactionSummary");
		expect(active.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(true);
	});

	it("reports an unavailable user selection without sending history elsewhere", async () => {
		const { active, requests } = await createSession("missing/model");
		await expect(active.compact()).rejects.toThrow("is unavailable");
		expect(requests).toEqual([]);
	});
});
