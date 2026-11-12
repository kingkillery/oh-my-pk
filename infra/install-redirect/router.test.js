import { describe, expect, it, vi } from "vitest";
import worker from "./worker.js";
import { evaluateFastRoute, PREFERRED_MODELS } from "./router.js";

describe("Cloudflare Router Endpoints", () => {
	it("returns list of preferred models and router lanes on GET /v1/models", async () => {
		const res = await worker.fetch(new Request("https://oh-my-pk.pkking.computer/v1/models"), {}, {});
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("application/json");

		const json = await res.json();
		expect(json.object).toBe("list");
		const ids = json.data.map(m => m.id);

		// Core preferred models
		expect(ids).toContain("router/auto");
		expect(ids).toContain("router/decision");
		expect(ids).toContain("kimi-code/k3.1-pro");
		expect(ids).toContain("minimax-code/MiniMax-M3.1-Flash");
		expect(ids).toContain("openrouter/deepseek/deepseek-v4.1-flash-1017");
		expect(ids).toContain("openrouter/recursive/flint-v1.0:free");
		expect(ids).toContain("openrouter/baidu/ernie-5.5-flash-preview:free");
		expect(ids).toContain("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free");
		expect(ids).toContain("openrouter/dots-studio/dots-3-note-preview:free");
		expect(ids).toContain("google-antigravity/gemini-3.8-flash-tiered");
		expect(ids).toContain("openai-codex/gpt-6-luna");
		expect(ids).toContain("openai-codex/gpt-6.1-terra");
	});

	it("evaluates fast route decisions correctly", () => {
		// Coding task
		const codeRoute = evaluateFastRoute({
			messages: [{ role: "user", content: "Implement a red-black tree with unit tests in TypeScript." }],
		});
		expect(codeRoute.selectedModel).toBe("kimi-code/k3.1-pro");
		expect(codeRoute.lane).toBe("coding");

		// Security task
		const secRoute = evaluateFastRoute({
			messages: [{ role: "user", content: "Perform a security audit looking for cryptographic exploit vulnerabilities." }],
		});
		expect(secRoute.selectedModel).toBe("openai-codex/gpt-6.1-terra");
		expect(secRoute.lane).toBe("quality");

		// Vision task
		const visionRoute = evaluateFastRoute({
			messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
		});
		expect(visionRoute.selectedModel).toBe("google-antigravity/gemini-3.8-flash-tiered");
		expect(visionRoute.lane).toBe("multimodal");

		// Free/cost preference
		const freeRoute = evaluateFastRoute({
			messages: [{ role: "user", content: "What is the capital of France?" }],
			preference: "free",
		});
		expect(freeRoute.selectedModel).toBe("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free");
		expect(freeRoute.lane).toBe("free");

		// Speed preference
		const speedRoute = evaluateFastRoute({
			messages: [{ role: "user", content: "Summarize this paragraph." }],
			preference: "speed",
		});
		expect(speedRoute.selectedModel).toBe("openrouter/deepseek/deepseek-v4.1-flash-1017");
		expect(speedRoute.lane).toBe("fast");
	});

	it("returns decision metadata on POST /v1/route", async () => {
		const req = new Request("https://oh-my-pk.pkking.computer/v1/route", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "Refactor this database connection pool." }],
			}),
		});

		const res = await worker.fetch(req, {}, {});
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.selectedModel).toBe("kimi-code/k3.1-pro");
		expect(json.confidence).toBeGreaterThan(0.8);
		expect(json.fallbackChain).toBeDefined();
	});

	it("handles router/decision model on POST /v1/chat/completions", async () => {
		const req = new Request("https://oh-my-pk.pkking.computer/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "router/decision",
				messages: [{ role: "user", content: "Fix memory leak in node server." }],
			}),
		});

		const res = await worker.fetch(req, {}, {});
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.model).toBe("router/decision");
		const content = JSON.parse(json.choices[0].message.content);
		expect(content.selectedModel).toBe("kimi-code/k3.1-pro");
	});

	it("dispatches auto-routed request to upstream OpenRouter with headers", async () => {
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init?.headers;
			capturedBody = JSON.parse(init?.body);
			return Promise.resolve(
				new Response(
					JSON.stringify({
						id: "gen-123",
						choices: [{ message: { role: "assistant", content: "Done!" } }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		});

		const env = { OPENROUTER_API_KEY: "test-openrouter-key" };
		const req = new Request("https://oh-my-pk.pkking.computer/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "router/auto",
				messages: [{ role: "user", content: "Quick greeting" }],
				preference: "speed",
			}),
		});

		const res = await worker.fetch(req, env, {});
		expect(res.status).toBe(200);
		expect(res.headers.get("x-router-selected-model")).toBe("openrouter/deepseek/deepseek-v4.1-flash-1017");
		expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(capturedBody.model).toBe("deepseek/deepseek-v4.1-flash-1017");
		expect(capturedHeaders["Authorization"]).toBe("Bearer test-openrouter-key");

		fetchSpy.mockRestore();
	});

	it("round-robins OPENROUTER_API_KEYS on free models", async () => {
		const tokens = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
			tokens.push(init?.headers["Authorization"]);
			return Promise.resolve(
				new Response(JSON.stringify({ id: "gen-f", choices: [{ message: { role: "assistant", content: "ok" } }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		});

		const env = { OPENROUTER_API_KEYS: "sk-or-a, sk-or-b" };
		const req = () =>
			new Request("https://oh-my-pk.pkking.computer/v1/chat/completions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
					messages: [{ role: "user", content: "hi" }],
				}),
			});

		await worker.fetch(req(), env, {});
		await worker.fetch(req(), env, {});

		expect(tokens).toHaveLength(2);
		expect(new Set(tokens)).toEqual(new Set(["Bearer sk-or-a", "Bearer sk-or-b"]));
		expect(fetchSpy.mock.calls[0][1].headers["Authorization"]).toMatch(/^Bearer sk-or-/);

		fetchSpy.mockRestore();
	});
	it.each([429, 401, 403, 503])("round-robins NVIDIA keys and rotates past a %i", async (failStatus) => {
		const seenTokens = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
			seenTokens.push(init?.headers["Authorization"]);
			// First key is rate-limited, the next one succeeds.
			const status = seenTokens.length === 1 ? failStatus : 200;
			return Promise.resolve(
				new Response(JSON.stringify({ id: "gen-rr", choices: [{ message: { role: "assistant", content: "ok" } }] }), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
			);
		});

		const env = { NVIDIA_API_KEYS: "nvapi-a, nvapi-b" };
		const req = () =>
			new Request("https://oh-my-pk.pkking.computer/v1/chat/completions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "nvidia/deepseek-ai/deepseek-v4.1-flash",
					messages: [{ role: "user", content: "hi" }],
				}),
			});

		const res1 = await worker.fetch(req(), env, {});
		expect(res1.status).toBe(200);
		expect(seenTokens).toHaveLength(2);
		expect(new Set(seenTokens)).toEqual(new Set(["Bearer nvapi-a", "Bearer nvapi-b"]));
		expect(fetchSpy.mock.calls[0][0]).toBe("https://integrate.api.nvidia.com/v1/chat/completions");

		// Second request adds exactly one key: rotation advanced, no retry.
		const res2 = await worker.fetch(req(), env, {});
		expect(res2.status).toBe(200);
		expect(seenTokens).toHaveLength(3);

		fetchSpy.mockRestore();
	});

	it("returns 503 for nvidia lane without keys", async () => {
		const req = new Request("https://oh-my-pk.pkking.computer/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "nvidia/deepseek-ai/deepseek-v4.1-flash-1017",
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		const res = await worker.fetch(req, {}, {});
		expect(res.status).toBe(503);
	});

	it("dedupes repeated keys so a retry never reuses the throttled key", async () => {
		const seenTokens = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
			seenTokens.push(init?.headers["Authorization"]);
			const status = seenTokens.length === 1 ? 429 : 200;
			return Promise.resolve(
				new Response(JSON.stringify({ id: "gen-dedupe", choices: [{ message: { role: "assistant", content: "ok" } }] }), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
			);
		});

		const env = { NVIDIA_API_KEYS: "nvapi-a, nvapi-a, nvapi-b" };
		const res = await worker.fetch(
			new Request("https://oh-my-pk.pkking.computer/v1/chat/completions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "nvidia/deepseek-ai/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
			}),
			env,
			{},
		);

		expect(res.status).toBe(200);
		expect(seenTokens).toHaveLength(2);
		expect(new Set(seenTokens).size).toBe(2);
		expect(seenTokens[1]).not.toBe(seenTokens[0]);

		fetchSpy.mockRestore();
	});

	it("uses the caller's own bearer when no NVIDIA keys are configured", async () => {
		const seenTokens = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
			seenTokens.push(init?.headers["Authorization"]);
			return Promise.resolve(
				new Response(JSON.stringify({ id: "gen-client", choices: [{ message: { role: "assistant", content: "ok" } }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		});

		const res = await worker.fetch(
			new Request("https://oh-my-pk.pkking.computer/v1/chat/completions", {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer nvapi-client" },
				body: JSON.stringify({ model: "nvidia/deepseek-ai/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
			}),
			{},
			{},
		);

		expect(res.status).toBe(200);
		expect(seenTokens).toEqual(["Bearer nvapi-client"]);
		expect(fetchSpy.mock.calls[0][0]).toBe("https://integrate.api.nvidia.com/v1/chat/completions");

		fetchSpy.mockRestore();
	});
});
