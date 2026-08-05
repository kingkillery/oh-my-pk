import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@pk-nerdsaver-ai/pi-catalog/model-manager";
import { getBundledModels } from "@pk-nerdsaver-ai/pi-catalog/models";
import { googleVertexModelManagerOptions } from "@pk-nerdsaver-ai/pi-catalog/provider-models/google";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
} from "@pk-nerdsaver-ai/pi-catalog/provider-models/openai-compat";

const googleVertexModelsDevPayload = {
	"google-vertex": {
		models: {
			"gemini-3.5-flash": {
				name: "Gemini 3.5 Flash",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image", "pdf"] },
				limit: { context: 1_048_576, output: 65_536 },
				cost: { input: 0.3, output: 2.5, cache_read: 0.03, cache_write: 0.75 },
				provider: { npm: "@ai-sdk/google-vertex" },
			},
			"deepseek-ai/deepseek-v3.2-maas": {
				name: "DeepSeek V3.2",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "pdf"] },
				limit: { context: 163_840, output: 65_536 },
				provider: { npm: "@ai-sdk/openai-compatible" },
			},
			"claude-sonnet-4@20250514": {
				name: "Claude Sonnet 4",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image", "pdf"] },
				limit: { context: 200_000, output: 64_000 },
				provider: { npm: "@ai-sdk/google-vertex/anthropic" },
			},
			"gemini-embedding-001": {
				name: "Gemini Embedding 001",
				tool_call: false,
				provider: { npm: "@ai-sdk/google-vertex" },
			},
		},
	},
} satisfies Record<string, unknown>;

describe("google-vertex model catalog", () => {
	let cacheDir: string | undefined;
	afterEach(() => {
		if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
		cacheDir = undefined;
	});

	it("maps the models.dev Vertex catalog instead of the project discovery endpoint", () => {
		const models = mapModelsDevToModels(googleVertexModelsDevPayload, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
			model => model.provider === "google-vertex",
		);

		expect(models.map(model => model.id)).toEqual([
			"gemini-3.5-flash",
			"deepseek-ai/deepseek-v3.2-maas",
			"claude-sonnet-4@20250514",
		]);

		const gemini = models.find(model => model.id === "gemini-3.5-flash");
		expect(gemini?.api).toBe("google-vertex");
		expect(gemini?.baseUrl).toBe("https://{location}-aiplatform.googleapis.com");
		expect(gemini?.input).toEqual(["text", "image"]);
		expect(gemini?.contextWindow).toBe(1_048_576);

		const deepseek = models.find(model => model.id === "deepseek-ai/deepseek-v3.2-maas");
		expect(deepseek?.api).toBe("openai-completions");
		expect(deepseek?.baseUrl).toBe(
			"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi",
		);

		const claude = models.find(model => model.id === "claude-sonnet-4@20250514");
		expect(claude?.api).toBe("anthropic-messages");
		expect(claude?.baseUrl).toBe(
			"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/claude-sonnet-4@20250514:streamRawPredict",
		);
		expect(claude?.reasoning).toBe(true);
	});

	it("uses the bundled Vertex catalog without ADC project discovery", async () => {
		let fetches = 0;
		const options = googleVertexModelManagerOptions({
			project: "vertex-project",
			location: "global",
			fetch: async () => {
				fetches += 1;
				return new Response("unexpected", { status: 500 });
			},
		});

		expect(options.fetchDynamicModels).toBeUndefined();
		expect(options.staticModels).toBeUndefined();

		// Isolate the cache DB: the default path is the developer's own catalog
		// cache, which would otherwise decide what this resolves to.
		cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-catalog-"));
		const result = await resolveProviderModels(
			{ ...options, cacheDbPath: path.join(cacheDir, "models.sqlite") },
			"offline",
		);

		// The bundled slice verbatim — no project endpoint call, nothing dropped.
		const bundled = getBundledModels("google-vertex");
		expect(bundled.length).toBeGreaterThan(0);
		expect(result.models.map(model => model.id).sort()).toEqual(bundled.map(model => model.id).sort());
		expect(result.stale).toBe(false);
		expect(fetches).toBe(0);
	});
});
