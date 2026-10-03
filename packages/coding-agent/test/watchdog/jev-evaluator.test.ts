import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { clearDecisionEndpointCache } from "../../src/lib/decision-endpoint-discovery";
import { evaluateAgentTelemetry } from "../../src/watchdog/jev-evaluator";

const ENV_KEYS = [
	"TYPESAFE_API_KEY",
	"TYPESAFE_BASE_URL",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"OMP_DECISION_DISCOVERY",
	"OMP_DECISION_ENDPOINT",
	"OMP_DECISION_MODEL",
] as const;

describe("evaluateAgentTelemetry", () => {
	let savedEnv: Record<string, string | undefined>;
	let fetchSpy: Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

	beforeEach(() => {
		savedEnv = {};
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		process.env.OMP_DECISION_DISCOVERY = "off";
		clearDecisionEndpointCache();
		fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected watchdog request"));
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		clearDecisionEndpointCache();
		// Preserve the environment object captured by the shared SystemOne client.
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("fails silent and returns undefined when unconfigured", async () => {
		const result = await evaluateAgentTelemetry("Agent state snippet");
		expect(result).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("returns undefined when explicitly disabled", async () => {
		process.env.TYPESAFE_API_KEY = "test-key";
		const result = await evaluateAgentTelemetry("Agent state snippet", { enabled: false });
		expect(result).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("returns undefined when provider is mock", async () => {
		process.env.TYPESAFE_API_KEY = "test-key";
		const result = await evaluateAgentTelemetry("Agent state snippet", { provider: "mock" });
		expect(result).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("catches network failure gracefully without throwing", async () => {
		process.env.TYPESAFE_API_KEY = "test-key";
		fetchSpy.mockRejectedValue(new Error("Connection refused"));

		const result = await evaluateAgentTelemetry("Agent state snippet");
		expect(result).toBeUndefined();
		expect(fetchSpy).toHaveBeenCalled();
	});

	test("catches non-200 HTTP response gracefully without throwing", async () => {
		process.env.TYPESAFE_API_KEY = "test-key";
		fetchSpy.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

		const result = await evaluateAgentTelemetry("Agent state snippet");
		expect(result).toBeUndefined();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test.each([
		["TYPESAFE_API_KEY", "https://api.typesafe.ai/v1/systemone", "jev-1.13.0"],
		["OPENROUTER_API_KEY", "https://openrouter.ai/api/v1/systemone", "jev-1.13"],
	] as const)(
		"parses valid Jev response using %s after earlier tests restore the environment",
		async (key, endpoint, model) => {
			process.env[key] = "test-key";
			const mockResponseData = {
				model: "jev-latest",
				provider: "TypeSafe",
				answers: {
					is_thrashing: { type: "noul", noul: 0.88 },
					stall_severity: { type: "score", score: 2.7, confidence: 0.92 },
					blocker_type: { type: "choice", choice: "syntax_or_tag_mismatch", confidence: 0.85 },
				},
			};

			fetchSpy.mockImplementation(() => {
				return Promise.resolve(
					new Response(JSON.stringify(mockResponseData), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			});

			const result = await evaluateAgentTelemetry("Agent state snippet");
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const [url, init] = fetchSpy.mock.calls[0];
			expect(url).toBe(endpoint);
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
			const body = JSON.parse(String(init?.body)) as {
				model: string;
				state: string;
				questions: Record<string, { type: string }>;
			};
			expect(body.model).toBe(model);
			expect(body.state).toBe("Agent state snippet");
			expect(body.questions.is_thrashing.type).toBe("noul");
			expect(body.questions.stall_severity.type).toBe("score");
			expect(body.questions.blocker_type.type).toBe("choice");
			expect(result).toBeDefined();
			expect(result?.isThrashing).toBe(0.88);
			expect(result?.stallSeverity).toBe(2.7);
			expect(result?.blockerType).toBe("syntax_or_tag_mismatch");
			expect(result?.confidence).toBe(0.92);
			expect(result?.latencyMs).toBeGreaterThanOrEqual(0);
		},
	);
});
