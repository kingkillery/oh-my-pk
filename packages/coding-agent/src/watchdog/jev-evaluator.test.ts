import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { clearDecisionEndpointCache } from "../lib/decision-endpoint-discovery";
import { evaluateAgentTelemetry } from "./jev-evaluator";

const ENV_KEYS = [
	"TYPESAFE_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"OMP_DECISION_DISCOVERY",
	"OMP_DECISION_ENDPOINT",
	"OMP_DECISION_MODEL",
] as const;

let savedEnv: Record<string, string | undefined>;
let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.OMP_DECISION_DISCOVERY = "off";
	clearDecisionEndpointCache();
	fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
	fetchSpy.mockRestore();
	clearDecisionEndpointCache();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("evaluateAgentTelemetry decision endpoint", () => {
	it("uses a live Clef SystemOne endpoint without an API key", async () => {
		process.env.OMP_DECISION_ENDPOINT = "http://clef-inference:8000";
		fetchSpy
			.mockImplementationOnce(() =>
				Promise.resolve(Response.json({ status: "ok", model: "clef-flash", tailnet_only: true })),
			)
			.mockImplementationOnce(() =>
				Promise.resolve(
					Response.json({
						model: "clef-flash",
						answers: {
							is_thrashing: { type: "noul", noul: 0.82 },
							stall_severity: {
								type: "score",
								score: 2.4,
								probabilities: {},
								legend: {},
								confidence: 0.91,
							},
							blocker_type: {
								type: "choice",
								choice: "command_failure_loop",
								probabilities: {},
								confidence: 0.94,
							},
						},
						usage: { input_tokens: 80, output_tokens: 3 },
					}),
				),
			);

		const result = await evaluateAgentTelemetry("compact state");

		expect(result).toMatchObject({
			isThrashing: 0.82,
			stallSeverity: 2.4,
			blockerType: "command_failure_loop",
			confidence: 0.91,
			provider: "clef",
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect((fetchSpy.mock.calls[1] as [string])[0]).toBe("http://clef-inference:8000/v1/systemone");
	});

	it("fails open when no decision backend is available", async () => {
		const result = await evaluateAgentTelemetry("compact state");
		expect(result).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
