import { describe, expect, test } from "bun:test";
import { mapOpenAIResponsesToolChoiceForTools } from "@pk-nerdsaver-ai/pi-ai/providers/openai-responses";
import type { ModelSpec, Tool, ToolChoice } from "@pk-nerdsaver-ai/pi-ai/types";
import { sanitizeOpenAIResponsesHistoryItemsForReplay } from "@pk-nerdsaver-ai/pi-ai/utils";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { metaModelManagerOptions } from "@pk-nerdsaver-ai/pi-catalog/provider-models";
import { type } from "arktype";
import modelsJson from "../../catalog/src/models.json" with { type: "json" };

const tool: Tool = { name: "yield", description: "Finish.", parameters: type({}) };
const forcedChoices: ToolChoice[] = ["none", "required", { type: "tool", name: "yield" }];

type RequestHeaders = RequestInit["headers"];

function specFor(provider: string, id: string): ModelSpec<"openai-responses"> {
	return (modelsJson as unknown as Record<string, Record<string, ModelSpec<"openai-responses">>>)[provider][id];
}

describe("Meta / Muse Code wire contract", () => {
	test("omits tool_choice on api.meta.ai, which accepts only auto", () => {
		// Verified upstream: "none", "required" and named function choices all
		// 400 with `only "auto" is supported for tool_choice`.
		for (const provider of ["meta", "meta-muse-code"]) {
			const model = buildModel(specFor(provider, "muse-spark-1.3"));
			expect(model.compat.supportsToolChoice).toBe(false);
			for (const choice of forcedChoices) {
				expect(mapOpenAIResponsesToolChoiceForTools(choice, [tool], model)).toBeUndefined();
			}
		}
	});

	test("keeps encrypted reasoning replay enabled (stateless store:false mode)", () => {
		const model = buildModel(specFor("meta-muse-code", "muse-spark-1.3"));
		expect(model.compat.includeEncryptedReasoning).toBe(true);
	});

	test("bundled muse-code models carry the x-api-version header", () => {
		for (const spec of Object.values(
			(modelsJson as Record<string, Record<string, { headers?: Record<string, string> }>>)["meta-muse-code"],
		)) {
			expect(spec.headers).toMatchObject({ "x-api-version": "1.0.0" });
		}
	});

	test("bundled muse-spark-1.3 exposes the documented max effort tier", () => {
		for (const provider of ["meta", "meta-muse-code"]) {
			expect(specFor(provider, "muse-spark-1.3").thinking?.efforts as unknown[]).toContain("max");
			expect(specFor(provider, "muse-spark-1.3-contributor").thinking?.efforts as unknown[]).not.toContain("max");
		}
	});

	test("subscription discovery stays on the bundled catalog", () => {
		const options = metaModelManagerOptions({
			apiKey: "LLM|test",
			providerId: "meta-muse-code",
		});
		expect(options.fetchDynamicModels).toBeUndefined();
	});

	test("plain meta provider discovery does not send x-api-version", async () => {
		const seen: { headers?: RequestHeaders }[] = [];
		const options = metaModelManagerOptions({
			apiKey: "LLM|test",
			fetch: async (_input: string | URL | Request, init?: RequestInit) => {
				seen.push({ headers: init?.headers });
				return Response.json({ object: "list", data: [{ id: "muse-spark-1.3" }] });
			},
		});
		const models = await options.fetchDynamicModels?.();
		expect(seen[0]?.headers).not.toMatchObject({ "x-api-version": "1.0.0" });
		expect(models?.[0]?.headers).toBeUndefined();
	});

	test("replayed reasoning items always carry a summary array", () => {
		const items = sanitizeOpenAIResponsesHistoryItemsForReplay([
			{ type: "reasoning", encrypted_content: "enc" } as Record<string, unknown>,
		]);
		expect(items[0]).toMatchObject({ type: "reasoning", summary: [], encrypted_content: "enc" });
	});
});
