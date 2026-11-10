import type { ModelSpec } from "../types";

export const MINIMAX_CODE_FLASH_MODEL_ID = "MiniMax-M3.1-Flash";

/** Current text models documented at https://platform.minimax.io/docs/m-plan/intro. */
export function buildMiniMaxCodeStaticSeed(): ModelSpec<"openai-completions">[] {
	return (["minimax-code", "minimax-code-cn"] as const).flatMap(provider =>
		(["MiniMax-M3", MINIMAX_CODE_FLASH_MODEL_ID] as const).map(id => ({
			id,
			name: id,
			provider,
			api: "openai-completions" as const,
			baseUrl: provider === "minimax-code" ? "https://api.minimax.io/v1" : "https://api.minimaxi.com/v1",
			reasoning: true,
			input: ["text", "image"] as ("text" | "image")[],
			contextWindow: 1_000_000,
			maxTokens: id === MINIMAX_CODE_FLASH_MODEL_ID ? 131_072 : 128_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	);
}

/** Preserve the plan transport while correcting stale models.dev / previous-snapshot metadata. */
export function applyMiniMaxCodeModelPolicy(model: ModelSpec): void {
	if (
		model.api !== "openai-completions" ||
		(model.provider !== "minimax-code" && model.provider !== "minimax-code-cn")
	) {
		return;
	}
	// The retired preview is now an alias of the stable model, not a separate picker entry.
	if (model.id === `${MINIMAX_CODE_FLASH_MODEL_ID}-Preview`) {
		model.id = MINIMAX_CODE_FLASH_MODEL_ID;
		model.name = MINIMAX_CODE_FLASH_MODEL_ID;
	}
	if (model.id === "MiniMax-M3") {
		model.contextWindow = 1_000_000;
		model.maxTokens = 128_000;
	}
	const flash = model.id === MINIMAX_CODE_FLASH_MODEL_ID;
	if (flash) {
		model.reasoning = true;
		model.input = ["text", "image"];
		model.contextWindow = 1_000_000;
		model.maxTokens = 131_072;
	}
	model.compat = {
		...model.compat,
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: flash,
		reasoningContentField: "reasoning_content",
	};
	delete model.compat.thinkingFormat;
}
