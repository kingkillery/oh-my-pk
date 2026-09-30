import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import type { CompactionSettings } from "../config/settings-schema";

export function isColabModel(model: Model | null | undefined): boolean {
	return model?.provider.toLowerCase().endsWith("(colab)") ?? false;
}

/** Keep summary and recent history proportional to the served window, not GPU/model capacity. */
export function resolveColabCompactionSettings(
	model: Model | null | undefined,
	settings: CompactionSettings,
): CompactionSettings {
	const window = model?.contextWindow ?? 0;
	if (!isColabModel(model) || window <= 0 || window > 32768) return settings;
	return {
		...settings,
		reserveTokens: Math.min(settings.reserveTokens, Math.max(1, Math.floor(window / 8))),
		keepRecentTokens: Math.min(settings.keepRecentTokens, Math.max(1, Math.floor(window / 5))),
		thresholdPercent: settings.thresholdPercent > 0 || settings.thresholdTokens > 0 ? settings.thresholdPercent : 70,
	};
}
