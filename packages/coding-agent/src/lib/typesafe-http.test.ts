import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { clearDecisionEndpointCache } from "./decision-endpoint-discovery";
import { systemOne, TypeSafeApiError, withTypeSafeRequestTimeout } from "./typesafe-http";

const ENV_KEYS = [
	"TYPESAFE_API_KEY",
	"TYPESAFE_BASE_URL",
	"OPENROUTER_API_KEY",
	"OMP_DECISION_DISCOVERY",
	"OMP_DECISION_ENDPOINT",
	"OMP_DECISION_MODEL",
] as const;

let savedEnv: Record<string, string | undefined>;
let fetchSpy: ReturnType<typeof spyOn>;

function okResponse(model = "jev-1.13.0"): Response {
	return new Response(
		JSON.stringify({
			model,
			answers: { goal_met: { type: "noul", noul: 0.91 } },
			usage: { input_tokens: 120, output_tokens: 4 },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function healthResponse(model = "clef-flash"): Response {
	return Response.json({ status: "ok", model, model_id: `Cloudflare/${model}`, tailnet_only: true });
}

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

describe("systemOne", () => {
	it("routes through OpenRouter with its model id when only OPENROUTER_API_KEY is set", async () => {
		process.env.OPENROUTER_API_KEY = "or-key";
		fetchSpy.mockImplementation(() => Promise.resolve(okResponse()));

		await systemOne("s", { q: { type: "noul", instructions: "?" } });

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://openrouter.ai/api/v1/systemone");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer or-key");
		expect(JSON.parse(init.body as string).model).toBe("jev-1.13");
	});

	it("prefers TYPESAFE_API_KEY over OPENROUTER_API_KEY", async () => {
		process.env.TYPESAFE_API_KEY = "ts-key";
		process.env.OPENROUTER_API_KEY = "or-key";
		fetchSpy.mockImplementation(() => Promise.resolve(okResponse()));

		await systemOne("s", {});

		expect((fetchSpy.mock.calls[0] as [string])[0]).toBe("https://api.typesafe.ai/v1/systemone");
	});

	it("posts state, model, and questions with bearer auth", async () => {
		process.env.TYPESAFE_API_KEY = "ts-key";
		fetchSpy.mockImplementation(() => Promise.resolve(okResponse()));

		const result = await systemOne(
			{ page: "checkout complete" },
			{ goal_met: { type: "noul", instructions: "Did the checkout succeed?" } },
		);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ts-key");
		const body = JSON.parse(init.body as string) as {
			state: unknown;
			model: string;
			questions: Record<string, { type: string }>;
		};
		expect(body.model).toBe("jev-1.13.0");
		expect(body.questions.goal_met.type).toBe("noul");
		expect(result.answers.goal_met).toEqual({ type: "noul", noul: 0.91 });
	});

	it("uses a live explicit decision endpoint without an API key", async () => {
		process.env.OMP_DECISION_ENDPOINT = "http://clef-inference:8000";
		process.env.OMP_DECISION_MODEL = "clef-flash";
		clearDecisionEndpointCache();
		fetchSpy.mockImplementation((input: Parameters<typeof fetch>[0]) =>
			Promise.resolve(String(input).endsWith("/healthz") ? healthResponse() : okResponse("clef-flash")),
		);

		const result = await systemOne("state", { goal_met: { type: "noul", instructions: "Done?" } });

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
		expect(url).toBe("http://clef-inference:8000/v1/systemone");
		expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
		expect(JSON.parse(init.body as string).model).toBe("clef-flash");
		expect(result.model).toBe("clef-flash");
	});

	it("falls back to TypeSafe when a discovered decision endpoint disappears", async () => {
		process.env.OMP_DECISION_ENDPOINT = "http://clef-inference:8000";
		process.env.TYPESAFE_API_KEY = "ts-key";
		clearDecisionEndpointCache();
		fetchSpy
			.mockImplementationOnce(() => Promise.resolve(healthResponse()))
			.mockImplementationOnce(() => Promise.reject(new Error("connection reset")))
			.mockImplementationOnce(() => Promise.resolve(okResponse()));

		const result = await systemOne("state", { goal_met: { type: "noul", instructions: "Done?" } });

		expect(fetchSpy).toHaveBeenCalledTimes(3);
		expect((fetchSpy.mock.calls[2] as [string])[0]).toBe("https://api.typesafe.ai/v1/systemone");
		expect(result.model).toBe("jev-1.13.0");
	});

	it("throws without calling fetch when TYPESAFE_API_KEY is unset", async () => {
		await expect(systemOne("state", {})).rejects.toThrow("TYPESAFE_API_KEY");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not retry non-retryable statuses", async () => {
		process.env.TYPESAFE_API_KEY = "ts-key";
		fetchSpy.mockImplementation(() => Promise.resolve(new Response("bad request", { status: 422 })));

		const failure = systemOne("state", {});
		await expect(failure).rejects.toBeInstanceOf(TypeSafeApiError);
		await expect(failure).rejects.toMatchObject({ status: 422, retryable: false });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("retries 529 overload then returns the response", async () => {
		process.env.TYPESAFE_API_KEY = "ts-key";
		fetchSpy
			.mockImplementationOnce(() => Promise.resolve(new Response("overloaded", { status: 529 })))
			.mockImplementation(() => Promise.resolve(okResponse()));

		const result = await systemOne("state", {});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(result.answers.goal_met).toEqual({ type: "noul", noul: 0.91 });
	});
});

describe("withTypeSafeRequestTimeout", () => {
	it("aborts a stalled request with a timeout error", async () => {
		const stalled = (signal: AbortSignal): Promise<Response> => {
			const { promise, reject } = Promise.withResolvers<Response>();
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			return promise;
		};

		await expect(withTypeSafeRequestTimeout(undefined, 10, stalled)).rejects.toThrow("timed out");
	});
});
