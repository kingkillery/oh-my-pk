import { afterEach, describe, expect, test } from "bun:test";
import { evaluateAgentTelemetry } from "../../src/watchdog/jev-evaluator";

describe("evaluateAgentTelemetry", () => {
	const originalEnv = { ...process.env };
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		process.env = { ...originalEnv };
		globalThis.fetch = originalFetch;
	});

	test("fails silent and returns undefined when unconfigured", async () => {
		delete process.env.TYPESAFE_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		delete process.env.AI_GATEWAY_API_KEY;

		const result = await evaluateAgentTelemetry("Agent state snippet");
		expect(result).toBeUndefined();
	});

	test("returns undefined when explicitly disabled", async () => {
		process.env.TYPESAFE_API_KEY = "test-key";
		const result = await evaluateAgentTelemetry("Agent state snippet", { enabled: false });
		expect(result).toBeUndefined();
	});

	test("returns undefined when provider is mock", async () => {
		process.env.TYPESAFE_API_KEY = "test-key";
		const result = await evaluateAgentTelemetry("Agent state snippet", { provider: "mock" });
		expect(result).toBeUndefined();
	});

	test("catches network failure gracefully without throwing", async () => {
		process.env.TYPESAFE_API_KEY = "test-key";
		globalThis.fetch = (() => Promise.reject(new Error("Connection refused"))) as unknown as typeof fetch;

		const result = await evaluateAgentTelemetry("Agent state snippet");
		expect(result).toBeUndefined();
	});

	test("catches non-200 HTTP response gracefully without throwing", async () => {
		process.env.TYPESAFE_API_KEY = "test-key";
		globalThis.fetch = (() =>
			Promise.resolve(new Response("Internal Server Error", { status: 500 }))) as unknown as typeof fetch;

		const result = await evaluateAgentTelemetry("Agent state snippet");
		expect(result).toBeUndefined();
	});

	test("parses valid Jev response with structured probabilities and scores", async () => {
		process.env.TYPESAFE_API_KEY = "test-key";
		const mockResponseData = {
			model: "jev-latest",
			provider: "TypeSafe",
			answers: {
				is_thrashing: { type: "noul", noul: 0.88 },
				stall_severity: { type: "score", score: 2.7, confidence: 0.92 },
				blocker_type: { type: "choice", choice: "syntax_or_tag_mismatch", confidence: 0.85 },
			},
		};

		globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
			expect(init?.method).toBe("POST");
			expect(init?.headers).toBeDefined();
			return Promise.resolve(
				new Response(JSON.stringify(mockResponseData), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;

		const result = await evaluateAgentTelemetry("Agent state snippet");
		expect(result).toBeDefined();
		expect(result?.isThrashing).toBe(0.88);
		expect(result?.stallSeverity).toBe(2.7);
		expect(result?.blockerType).toBe("syntax_or_tag_mismatch");
		expect(result?.confidence).toBe(0.92);
		expect(result?.latencyMs).toBeGreaterThanOrEqual(0);
	});
});
