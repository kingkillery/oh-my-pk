/**
 * Tests for the vice-versa path: ChatGptClient response/error handling and the
 * ask_chatgpt custom tool's execution contract. Fetch is stubbed — no network.
 */
import { describe, expect, test } from "bun:test";
import { ChatGptClient, type FetchLike } from "../src/chatgpt/client";
import factory from "../src/chatgpt/tool";
import { isConnectorError } from "../src/errors";

const BASE_OPTIONS = {
	baseUrl: "https://api.openai.com/v1",
	model: "gpt-5.1",
	apiKey: "sk-test",
	timeoutMs: 5_000,
};

function fetchReturning(
	body: unknown,
	status = 200,
): { fetch: FetchLike; calls: Array<{ url: string; body: string }> } {
	const calls: Array<{ url: string; body: string }> = [];
	const fake: FetchLike = async (input, init) => {
		calls.push({ url: String(input), body: String(init?.body) });
		return new Response(JSON.stringify(body), { status });
	};
	return { fetch: fake, calls };
}

function successBody(text: string, model = "gpt-5.1") {
	return {
		model,
		output: [{ type: "message", content: [{ type: "output_text", text }] }],
		usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
	};
}

describe("ChatGptClient.ask", () => {
	test("extracts message text and usage from the Responses API shape", async () => {
		const { fetch, calls } = fetchReturning(successBody("hello from chatgpt"));
		const client = new ChatGptClient({ ...BASE_OPTIONS, fetch });
		const result = await client.ask("what is up?");
		expect(result.text).toBe("hello from chatgpt");
		expect(result.model).toBe("gpt-5.1");
		expect(result.usage?.totalTokens).toBe(10);
		expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
		expect(JSON.parse(calls[0].body).model).toBe("gpt-5.1");
	});

	test("honors per-call reasoning effort and model overrides", async () => {
		const { fetch, calls } = fetchReturning(successBody("ok"));
		const client = new ChatGptClient({ ...BASE_OPTIONS, fetch });
		await client.ask("q", { model: "gpt-5", reasoningEffort: "high" });
		const body = JSON.parse(calls[0].body);
		expect(body.model).toBe("gpt-5");
		expect(body.reasoning.effort).toBe("high");
	});

	test("missing api key is a config error, not a crash", async () => {
		const saved = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		try {
			const client = new ChatGptClient({ ...BASE_OPTIONS, apiKey: undefined });
			try {
				await client.ask("x");
				expect.unreachable();
			} catch (error) {
				expect(isConnectorError(error) && error.code).toBe("not_configured");
			}
		} finally {
			if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
		}
	});

	test("empty prompt is rejected client-side", async () => {
		const client = new ChatGptClient({ ...BASE_OPTIONS });
		try {
			await client.ask("   ");
			expect.unreachable();
		} catch (error) {
			expect(isConnectorError(error) && error.code).toBe("invalid_request");
		}
	});

	test("HTTP errors map to chatgpt_error with the API message", async () => {
		const { fetch } = fetchReturning({ error: { message: "rate limited" } }, 429);
		const client = new ChatGptClient({ ...BASE_OPTIONS, fetch });
		try {
			await client.ask("x");
			expect.unreachable();
		} catch (error) {
			expect(isConnectorError(error) && error.code).toBe("chatgpt_error");
			expect((error as Error).message).toContain("rate limited");
		}
	});

	test("an empty assistant response is an error", async () => {
		const { fetch } = fetchReturning({ model: "gpt-5.1", output: [] });
		const client = new ChatGptClient({ ...BASE_OPTIONS, fetch });
		try {
			await client.ask("x");
			expect.unreachable();
		} catch (error) {
			expect(isConnectorError(error) && error.code).toBe("chatgpt_error");
		}
	});
});
describe("ask_chatgpt custom tool", () => {
	// pi.zod stand-in: every chained builder call returns the same object, which
	// is enough for the factory to attach `parameters` without a real zod dep.
	const chain = (): Record<string, unknown> => ({
		min: () => chain(),
		optional: () => chain(),
		describe: () => chain(),
		enum: () => chain(),
	});
	const zod = {
		object: () => chain(),
		string: () => chain(),
		enum: () => chain(),
	};

	function toolContext(responseBody: unknown, status = 200) {
		const fetch: FetchLike = async () => new Response(JSON.stringify(responseBody), { status });
		return { fetch } as never;
	}

	function buildTool() {
		const tool = factory({ zod } as never);
		if (!tool) throw new Error("factory returned undefined");
		return tool as {
			execute: (
				id: string,
				params: Record<string, unknown>,
				onUpdate: unknown,
				ctx: unknown,
			) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
		};
	}

	test("returns ChatGPT text through the tool contract", async () => {
		const tool = buildTool();
		const result = await tool.execute("tc1", { question: "2+2?" }, async () => {}, toolContext(successBody("4")));
		expect(result.content[0].text).toContain("4");
		expect(result.isError).toBeFalsy();
	});

	test("a missing API key produces a tool error result", async () => {
		const tool = buildTool();
		const saved = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		try {
			const result = await tool.execute("tc1", { question: "q" }, async () => {}, toolContext({}));
			expect(result.isError).toBe(true);
			expect(result.content[0].text.toLowerCase()).toContain("api key");
		} finally {
			if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
		}
	});
});
