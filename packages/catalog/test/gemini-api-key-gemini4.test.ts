import { describe, expect, it } from "bun:test";
import { fetchGeminiModels } from "@pk-nerdsaver-ai/pi-catalog/discovery/gemini";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-catalog/types";

/**
 * The API-key endpoint advertises Gemini 4 but rejects it with 402 while the project's
 * prepaid balance is empty. `google-antigravity` serves that family on the subscription
 * transport, so the API-key provider must not advertise dead duplicates.
 */
function listResponse(ids: string[]): Response {
	return new Response(
		JSON.stringify({
			models: ids.map(id => ({
				name: `models/${id}`,
				displayName: id,
				supportedGenerationMethods: ["generateContent"],
				inputTokenLimit: 1_048_576,
				outputTokenLimit: 65_536,
			})),
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function createFetch(ids: string[]): FetchImpl {
	return async () => listResponse(ids);
}

describe("google API-key discovery", () => {
	it("omits the Gemini 4 ids that only the Antigravity subscription serves", async () => {
		const models = await fetchGeminiModels({
			apiKey: "test-key",
			fetch: createFetch(["gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-3-flash"]),
		});

		expect(models?.map(model => model.id)).toEqual(["gemini-3-flash"]);
	});

	it("keeps effort-suffixed Gemini 4 ids off the API-key provider", async () => {
		const models = await fetchGeminiModels({
			apiKey: "test-key",
			fetch: createFetch(["gemini-4-argon-medium", "gemini-3.8-flash"]),
		});

		expect(models?.map(model => model.id)).toEqual(["gemini-3.8-flash"]);
	});
});
