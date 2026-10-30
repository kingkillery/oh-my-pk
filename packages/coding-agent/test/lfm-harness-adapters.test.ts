import { describe, expect, test } from "bun:test";
import { isLfmHarnessAdapterModelId, isLfmModelId } from "@pk-nerdsaver-ai/pi-catalog/identity";
import { resolveDiscoveredApi } from "../src/config/model-discovery";

describe("isLfmModelId", () => {
	test("matches namespaced LFM ids", () => {
		expect(isLfmModelId("LiquidAI/LFM2.5-24B-A2B")).toBe(true);
		expect(isLfmModelId("harness-hub/LFM2.5-24B-A2B-pi")).toBe(true);
		expect(isLfmModelId("lfm2.5-24b")).toBe(true);
		expect(isLfmModelId("lfm-7b")).toBe(true);
	});

	test("rejects non-LFM ids", () => {
		expect(isLfmModelId("openai/gpt-5.4")).toBe(false);
		expect(isLfmModelId("anthropic/claude-sonnet")).toBe(false);
		expect(isLfmModelId("qwen3-coder")).toBe(false);
	});
});

describe("isLfmHarnessAdapterModelId", () => {
	test("matches harbor adapter names", () => {
		expect(isLfmHarnessAdapterModelId("lfm-harbor-pi")).toBe(true);
		expect(isLfmHarnessAdapterModelId("lfm-harbor-claude-code")).toBe(true);
		expect(isLfmHarnessAdapterModelId("harness-hub/LFM2.5-24B-A2B-pi")).toBe(true);
		expect(isLfmHarnessAdapterModelId("harness-hub/LFM2.5-24B-A2B-claude-code")).toBe(true);
		expect(isLfmHarnessAdapterModelId("lfm-a2b-pi-gguf")).toBe(true);
	});

	test("rejects non-adapter ids", () => {
		expect(isLfmHarnessAdapterModelId("LiquidAI/LFM2.5-24B-A2B")).toBe(false);
		expect(isLfmHarnessAdapterModelId("openai/gpt-5.4")).toBe(false);
		expect(isLfmHarnessAdapterModelId("anthropic/claude-sonnet")).toBe(false);
	});
});

describe("resolveDiscoveredApi", () => {
	test("forces openai-completions for adapter ids on responses-family or unset api", () => {
		expect(resolveDiscoveredApi("openai-responses", "lfm-harbor-pi")).toBe("openai-completions");
		expect(resolveDiscoveredApi("azure-openai-responses", "lfm-harbor-pi")).toBe("openai-completions");
		expect(resolveDiscoveredApi("openai-codex-responses", "lfm-harbor-pi")).toBe("openai-completions");
		expect(resolveDiscoveredApi(undefined, "lfm-harbor-pi")).toBe("openai-completions");
	});

	test("keeps explicit non-Responses api", () => {
		expect(resolveDiscoveredApi("anthropic-messages", "lfm-harbor-pi")).toBe("anthropic-messages");
		expect(resolveDiscoveredApi("openai-completions", "lfm-harbor-pi")).toBe("openai-completions");
	});

	test("returns api unchanged for non-adapter ids", () => {
		expect(resolveDiscoveredApi("openai-responses", "openai/gpt-5.4")).toBe("openai-responses");
		expect(resolveDiscoveredApi(undefined, "qwen3-coder")).toBe(undefined);
	});
});
