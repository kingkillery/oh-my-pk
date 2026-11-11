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
});
