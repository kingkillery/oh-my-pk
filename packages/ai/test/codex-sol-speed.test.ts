import { describe, expect, it } from "bun:test";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { fetchCodexModels } from "@pk-nerdsaver-ai/pi-catalog/discovery/codex";
import { Effort } from "@pk-nerdsaver-ai/pi-catalog/effort";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses";
import { type ProviderSessionState, resolveServiceTier } from "../src/types";

describe("GPT-6.1 Sol through ChatGPT sign-in", () => {
	for (const [tier, responseTier, wireTier, multiplier] of [
		[undefined, "default", undefined, 1],
		["fast", "fast", "fast", 2],
		["ultrafast", "ultrafast", "ultrafast", 6],
		["fast", "default", "fast", 1],
		["ultrafast", "default", "ultrafast", 1],
		["fast", undefined, "fast", 2],
		["ultrafast", undefined, "ultrafast", 6],
		["priority", "fast", "fast", 2],
		["openai-only", "fast", "fast", 2],
	] as const) {
		it(`discovers Sol and sends ${tier ?? "standard"} over HTTP with response tier ${responseTier ?? "missing"}`, async () => {
			let requestBody: Record<string, unknown> | undefined;
			const server = Bun.serve({
				port: 0,
				async fetch(request) {
					if (request.method === "GET")
						return Response.json({
							models: [
								{
									slug: "gpt-6.1-sol",
									display_name: "GPT-6.1 Sol",
									context_window: 272_000,
									supported_in_api: true,
									default_reasoning_level: "medium",
									prefer_websockets: true,
									supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map(
										effort => ({ effort }),
									),
									multi_agent_reasoning_effort: "max",
									input_modalities: ["text", "image"],
								},
							],
						});
					requestBody = (await request.json()) as Record<string, unknown>;
					return new Response(
						[
							{
								type: "response.output_item.added",
								item: { type: "message", id: "msg_sol", role: "assistant", status: "in_progress", content: [] },
							},
							{ type: "response.output_text.delta", delta: "Hello" },
							{
								type: "response.output_item.done",
								item: {
									type: "message",
									id: "msg_sol",
									role: "assistant",
									status: "completed",
									content: [{ type: "output_text", text: "Hello" }],
								},
							},
							{
								type: "response.completed",
								response: {
									status: "completed",
									service_tier: responseTier,
									usage: {
										input_tokens: 5,
										output_tokens: 3,
										total_tokens: 8,
										input_tokens_details: { cached_tokens: 0 },
									},
								},
							},
						]
							.map(event => `data: ${JSON.stringify(event)}\n\n`)
							.join(""),
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			});
			try {
				const discovery = await fetchCodexModels({
					accessToken: "test-token",
					clientVersion: "0.153.4",
					baseUrl: server.url.toString(),
				});
				const spec = discovery?.models[0];
				if (!spec) throw new Error("Sol was not discovered");
				const model = buildModel({
					...spec,
					preferWebsockets: false,
					cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
				});
				expect(model.id).toBe("gpt-6.1-sol");
				expect(model.thinking?.efforts).toEqual([
					Effort.Low,
					Effort.Medium,
					Effort.High,
					Effort.XHigh,
					Effort.Max,
					Effort.Ultra,
				]);
				expect(model.thinking?.effortMap?.[Effort.Ultra]).toBe("max");
				const payload = Buffer.from(
					JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
				).toString("base64url");
				const result = await streamOpenAICodexResponses(
					model,
					{ systemPrompt: ["Test"], messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
					{
						apiKey: `test.${payload}.test`,
						serviceTier: tier,
					},
				).result();
				expect(result.stopReason).toBe("stop");
				expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Hello" }));
				expect(requestBody?.model).toBe("gpt-6.1-sol");
				expect(requestBody?.service_tier).toBe(wireTier);
				expect(result.usage.cost.total).toBeCloseTo(0.000011 * multiplier, 10);
			} finally {
				await server.stop(true);
			}
		});
	}

	it.each(["fast", "ultrafast"] as const)("sends %s over a real WebSocket", async tier => {
		let requestBody: Record<string, unknown> | undefined;
		const server = Bun.serve({
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return;
				return new Response("WebSocket required", { status: 400 });
			},
			websocket: {
				message(socket, message) {
					requestBody = JSON.parse(message.toString()) as Record<string, unknown>;
					socket.send(
						JSON.stringify({
							type: "response.output_item.added",
							item: { type: "message", id: "ws_sol", role: "assistant", status: "in_progress", content: [] },
						}),
					);
					socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "Hello" }));
					socket.send(
						JSON.stringify({
							type: "response.output_item.done",
							item: {
								type: "message",
								id: "ws_sol",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "Hello" }],
							},
						}),
					);
					socket.send(
						JSON.stringify({
							type: "response.completed",
							response: {
								id: "response_sol",
								status: "completed",
								service_tier: tier,
								usage: { input_tokens: 5, output_tokens: 3 },
							},
						}),
					);
				},
			},
		});
		const providerSessionState = new Map<string, ProviderSessionState>();
		try {
			const model = buildModel({
				id: "gpt-6.1-sol",
				name: "GPT-6.1 Sol",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: server.url.toString(),
				reasoning: true,
				preferWebsockets: true,
				thinking: { mode: "effort", efforts: [Effort.Low] },
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 272_000,
				maxTokens: 128_000,
			});
			const payload = Buffer.from(
				JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
			).toString("base64url");
			const result = await streamOpenAICodexResponses(
				model,
				{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
				{
					apiKey: `test.${payload}.test`,
					serviceTier: tier,
					providerSessionState,
					sessionId: `sol-${tier}`,
					signal: AbortSignal.timeout(5000),
				},
			).result();
			expect(result.stopReason).toBe("stop");
			expect(requestBody?.type).toBe("response.create");
			expect(requestBody?.model).toBe("gpt-6.1-sol");
			expect(requestBody?.service_tier).toBe(tier);
		} finally {
			for (const state of providerSessionState.values()) state.close();
			await server.stop(true);
		}
	});

	it("keeps explicit ChatGPT speeds off other provider families", () => {
		for (const tier of ["fast", "ultrafast"] as const) {
			expect(resolveServiceTier(tier, "openai-codex")).toBe(tier);
			for (const provider of ["anthropic", "openrouter", "openai"] as const)
				expect(resolveServiceTier(tier, provider)).toBeUndefined();
		}
	});
});
