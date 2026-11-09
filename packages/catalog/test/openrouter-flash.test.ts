import { expect, test } from "bun:test";
import { buildModel } from "../src/build";
import { Effort } from "../src/effort";
import { openrouterModelManagerOptions } from "../src/provider-models/openai-compat";

test("OpenRouter discovery preserves Flash identity, limits, pricing and mandatory effort", async () => {
	const paths: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			paths.push(new URL(request.url).pathname);
			return Response.json({
				data: [
					{
						id: "minimax/minimax-m3.1-flash",
						name: "MiniMax: MiniMax M3.1 Flash",
						context_length: 1_048_576,
						top_provider: { max_completion_tokens: 524_288 },
						architecture: { modality: "text+image+video->text" },
						pricing: { prompt: "0.000000075", completion: "0.0000003", input_cache_read: "0.0000000075" },
						supported_parameters: ["tools", "tool_choice", "reasoning", "reasoning_effort"],
					},
					{
						id: "not-a-tool-model",
						supported_parameters: [],
					},
				],
			});
		},
	});
	try {
		const options = openrouterModelManagerOptions({ baseUrl: `${server.url}api/v1` });
		const models = (await options.fetchDynamicModels?.())?.map(spec => buildModel(spec)) ?? [];
		expect(paths).toEqual(["/api/v1/models"]);
		expect(models.map(model => model.id)).toEqual(["minimax/minimax-m3.1-flash"]);
		expect(models[0]).toMatchObject({
			provider: "openrouter",
			api: "openrouter",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_048_576,
			maxTokens: 524_288,
			cost: { input: 0.075, output: 0.3, cacheRead: 0.0075 },
			thinking: {
				mode: "effort",
				requiresEffort: true,
				defaultLevel: Effort.Max,
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			},
		});
	} finally {
		await server.stop(true);
	}
});
