import { describe, expect, test } from "bun:test";
import { applyGeneratedModelPolicies } from "../scripts/generated-policies";
import { buildModel } from "../src/build";
import { Effort } from "../src/effort";
import { DEFAULT_MODEL_PER_PROVIDER } from "../src/provider-models";
import { applyMiniMaxCodeModelPolicy, buildMiniMaxCodeStaticSeed } from "../src/provider-models/minimax-code";
import { MODELS_DEV_PROVIDER_DESCRIPTORS, mapModelsDevToModels } from "../src/provider-models/openai-compat";

const currentModelIds = [
	"MiniMax-M2",
	"MiniMax-M2.1",
	"MiniMax-M2.5",
	"MiniMax-M2.5-highspeed",
	"MiniMax-M2.7",
	"MiniMax-M2.7-highspeed",
	"MiniMax-M3",
	"MiniMax-M3.1-Flash",
];
const flashEfforts = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];

function flashSeed() {
	const model = buildMiniMaxCodeStaticSeed().find(entry => entry.id === "MiniMax-M3.1-Flash");
	if (!model) throw new Error("Missing Flash seed");
	applyMiniMaxCodeModelPolicy(model);
	return model;
}

describe("MiniMax M Plan model catalog", () => {
	for (const provider of ["minimax-code", "minimax-code-cn"] as const) {
		test(`${provider} maps every current coding-plan model through its descriptor`, () => {
			const descriptors = MODELS_DEV_PROVIDER_DESCRIPTORS.filter(entry => entry.providerId === provider);
			expect(descriptors).toHaveLength(1);
			const rawModels = Object.fromEntries(
				currentModelIds.map(id => [
					id,
					{
						name: id,
						tool_call: true,
						reasoning: true,
						modalities: { input: ["text"] },
						limit: { context: 200_000, output: 16_384 },
					},
				]),
			);
			const models = mapModelsDevToModels({ [descriptors[0].modelsDevKey]: { models: rawModels } }, descriptors);
			applyGeneratedModelPolicies(models);
			expect(models.map(model => model.id)).toEqual(currentModelIds);
			expect(DEFAULT_MODEL_PER_PROVIDER[provider]).toBe("MiniMax-M3.1-Flash");
			const flash = models.find(model => model.id === "MiniMax-M3.1-Flash");
			expect(flash).toMatchObject({
				provider,
				api: "openai-completions",
				baseUrl: provider === "minimax-code" ? "https://api.minimax.io/v1" : "https://api.minimaxi.com/v1",
				contextWindow: 1_000_000,
				maxTokens: 131_072,
				input: ["text", "image"],
				compat: { supportsReasoningEffort: true },
				thinking: { efforts: flashEfforts, defaultLevel: Effort.Max, requiresEffort: true },
			});
		});
	}

	test("seed metadata survives policy rebaking with mandatory Flash effort but unchanged M3 behavior", () => {
		const seeds = buildMiniMaxCodeStaticSeed();
		applyGeneratedModelPolicies(seeds);
		for (const model of seeds) {
			if (model.id === "MiniMax-M3.1-Flash") {
				expect(model.thinking).toMatchObject({
					mode: "effort",
					efforts: flashEfforts,
					defaultLevel: Effort.Max,
					requiresEffort: true,
				});
			} else {
				expect(model.maxTokens).toBe(128_000);
				expect(model.compat?.supportsReasoningEffort).toBe(false);
				expect(model.compat?.thinkingFormat).toBeUndefined();
			}
		}
	});

	test("normalizes the retired Flash preview into the stable model without changing provider identity", () => {
		const model = flashSeed();
		model.id = "MiniMax-M3.1-Flash-Preview";
		model.name = "outdated preview";
		model.contextWindow = 200_000;
		applyMiniMaxCodeModelPolicy(model);
		expect(model.id).toBe("MiniMax-M3.1-Flash");
		expect(model.name).toBe("MiniMax-M3.1-Flash");
		expect(model.provider).toBe("minimax-code");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.compat?.supportsReasoningEffort).toBe(true);
	});

	test("normalizes stale explicit Flash thinking rather than retaining unsupported minimal or disabled effort", () => {
		const model = buildModel({
			...flashSeed(),
			thinking: {
				mode: "budget",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				defaultLevel: Effort.Minimal,
				requiresEffort: false,
			},
		});
		expect(model.thinking).toMatchObject({
			mode: "effort",
			efforts: flashEfforts,
			defaultLevel: Effort.Max,
			requiresEffort: true,
		});
	});

	test("fills the Flash default while retaining a valid explicit default selection", () => {
		const base = flashSeed();
		const missing = buildModel({ ...base, thinking: { mode: "effort", efforts: flashEfforts } });
		const selected = buildModel({
			...base,
			thinking: { mode: "effort", efforts: flashEfforts, defaultLevel: Effort.High },
		});
		expect(missing.thinking?.defaultLevel).toBe(Effort.Max);
		expect(selected.thinking?.defaultLevel).toBe(Effort.High);
		expect(selected.thinking?.requiresEffort).toBe(true);
	});
});
