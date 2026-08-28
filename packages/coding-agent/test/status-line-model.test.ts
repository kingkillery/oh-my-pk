import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { SegmentContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

/**
 * `fastModeActive` is what the bolt reflects (fast mode applies to the next
 * request). `fastModeEnabled` is the broader "some tier is configured" flag —
 * they diverge for a scoped tier on a non-matching provider, which is the case
 * the bolt used to get wrong, so the two are settable independently here.
 */
function createModelContext(
	advisorActive: boolean,
	fastModeActive = false,
	fastModeEnabled = fastModeActive,
): SegmentContext {
	return {
		session: {
			state: { model: { id: "test-model", name: "Test Model" } },
			isFastModeActive: () => fastModeActive,
			isFastModeEnabled: () => fastModeEnabled,
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			isAdvisorActive: () => advisorActive,
			getAdvisorStatusOverview: () => ({
				configured: advisorActive,
				advisors: advisorActive ? [{ name: "default", status: "running" }] : [],
			}),
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		activeMs: 0,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

describe("status line model segment advisor badge", () => {
	it("appends a success-colored advisor symbol when all advisors run", () => {
		const rendered = renderSegment("model", createModelContext(true));
		expect(rendered.content).toContain("Test Model");
		expect(rendered.content).toContain(theme.fg("success", ` ${theme.icon.advisor}`));
	});

	it("colors the badge by the worst roster status", () => {
		const ctx = createModelContext(true);
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "a", status: "running" },
				{ name: "b", status: "quota_exhausted" },
			],
		});
		expect(renderSegment("model", ctx).content).toContain(theme.fg("warning", ` ${theme.icon.advisor}`));
		ctx.session.getAdvisorStatusOverview = () => ({
			configured: true,
			advisors: [
				{ name: "a", status: "error" },
				{ name: "b", status: "quota_exhausted" },
			],
		});
		expect(renderSegment("model", ctx).content).toContain(theme.fg("error", ` ${theme.icon.advisor}`));
	});

	it("omits the badge when the advisor is inactive", () => {
		const rendered = renderSegment("model", createModelContext(false));
		expect(rendered.content).toContain("Test Model");
		expect(rendered.content).not.toContain(theme.icon.advisor);
	});
});

describe("status line model segment compact thinking level", () => {
	function createThinkingContext(compactThinkingLevel: boolean): SegmentContext {
		return {
			...createModelContext(false),
			compactThinkingLevel,
			session: {
				state: {
					model: { id: "test-model", name: "Test Model", thinking: true },
					thinkingLevel: ThinkingLevel.High,
				},
				isFastModeActive: () => false,
				isAutoThinking: false,
				autoResolvedThinkingLevel: () => undefined,
				isAdvisorActive: () => false,
				getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
			} as unknown as SegmentContext["session"],
		};
	}

	it("trails the level as a ` · <level>` suffix when compact mode is off", () => {
		const display = theme.thinking.high;
		const modelPrefix = theme.icon.model ? `${theme.icon.model} ` : "";
		const rendered = renderSegment("model", createThinkingContext(false));
		expect(Bun.stripANSI(rendered.content)).toBe(`${modelPrefix}Test Model${theme.sep.dot}${display}`);
	});

	it("swaps the model icon for the level glyph and drops the suffix when compact", () => {
		const display = theme.thinking.high;
		const glyph = display.includes(" ") ? display.slice(0, display.indexOf(" ")) : display;
		const rendered = renderSegment("model", createThinkingContext(true));
		expect(Bun.stripANSI(rendered.content)).toBe(`${glyph} Test Model`);
		expect(Bun.stripANSI(rendered.content)).not.toContain(theme.sep.dot);
	});
});

describe("status line model segment fast-mode indicator", () => {
	it("shows a bright bolt immediately after the model name when fast mode is on", () => {
		const rendered = renderSegment("model", createModelContext(false, true));
		expect(rendered.content).toContain(
			theme.fg("statusLineModel", `${theme.icon.model} Test Model`) + theme.fg("warning", ` ${theme.icon.fast}`),
		);
	});

	it("shows a muted bolt immediately after the model name when fast mode is off", () => {
		const rendered = renderSegment("model", createModelContext(false));
		expect(rendered.content).toContain(
			theme.fg("statusLineModel", `${theme.icon.model} Test Model`) + theme.fg("muted", ` ${theme.icon.fast}`),
		);
	});

	it("mutes the bolt when a scoped tier is configured but does not apply to this model's provider", () => {
		// e.g. `openai-only` while an Anthropic model is selected: the tier is
		// configured (enabled) but resolves to no priority for this provider, so
		// fast mode is not applied and the bolt must not read as on.
		const rendered = renderSegment("model", createModelContext(false, false, true));
		expect(rendered.content).toContain(
			theme.fg("statusLineModel", `${theme.icon.model} Test Model`) + theme.fg("muted", ` ${theme.icon.fast}`),
		);
		expect(rendered.content).not.toContain(theme.fg("warning", ` ${theme.icon.fast}`));
	});
});
