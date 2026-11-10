import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@pk-nerdsaver-ai/pi-catalog/provider-models";
import { CATALOG_PROVIDERS } from "../src/provider-models/descriptors";

describe("Meta Muse Code subscription descriptor", () => {
	test("keeps subscription discovery separate from pay-as-you-go Meta", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(entry => entry.providerId === "meta-muse-code");
		const discovery = CATALOG_PROVIDERS.find(entry => entry.id === "meta-muse-code");
		expect(discovery?.envVars).toEqual(["META_MUSE_CODE_API_KEY"]);
		expect(descriptor?.defaultModel).toBe("muse-spark-1.3");
		expect(DEFAULT_MODEL_PER_PROVIDER["meta-muse-code"]).toBe("muse-spark-1.3");
		const manager = descriptor?.createModelManagerOptions({ apiKey: "subscription-key" });
		expect(manager?.providerId).toBe("meta-muse-code");
		// Subscription keys are refused by the direct API, so the bundled
		// catalog is the model list for this provider.
		expect(manager?.fetchDynamicModels).toBeUndefined();
		expect(manager?.dynamicModelsAuthoritative).toBeUndefined();
		expect(CATALOG_PROVIDERS.find(entry => entry.id === "meta")?.envVars).toEqual([
			"META_API_KEY",
			"MODEL_API_KEY",
			"META_MODEL_API_KEY",
		]);
	});
});
