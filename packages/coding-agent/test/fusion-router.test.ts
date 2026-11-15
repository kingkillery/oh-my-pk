import { describe, expect, it } from "bun:test";
import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import type { TypeSafeAnswer } from "@pk-nerdsaver-ai/pi-coding-agent/lib/typesafe-http";
import {
	buildDecisionRouteState,
	classifyFusionRouteViaDecision,
	computeFusionWarmPrefixTokens,
	DEFAULT_FUSION_TOKEN_SAVINGS_CACHE_TTL_MS,
	DEFAULT_FUSION_TOKEN_SAVINGS_MIN_CACHE_CONTEXT_TOKENS,
	DEFAULT_FUSION_TOKEN_SAVINGS_STICKY_MAX_CALLS,
	decideFusionTokenSavingsSwitch,
	decideFusionTokenSavingsTurnStart,
	decisionRouteQuestion,
	estimateFusionPrefixHorizonCostUsd,
	formatFusionPoolEntries,
	isFusionAutoDowngradedRoute,
	isFusionStreakNeutralToolSuccess,
	nextFusionToolFailureStreak,
	parseDecisionRouteAnswer,
	parseFusionPoolEntries,
	parseFusionRoute,
	renderPoolClassifierPrompt,
	resolveEffectiveFusionRoute,
	resolveSidekickRoute,
	shouldRunFusionCompactionSwitch,
} from "@pk-nerdsaver-ai/pi-coding-agent/session/fusion-router";

describe("isFusionAutoDowngradedRoute", () => {
	const frontier = { provider: "test", id: "frontier" } as Model;
	const cheap = { provider: "test", id: "cheap" } as Model;
	const manual = { provider: "test", id: "manual" } as Model;
	const active = { routingDisabled: false, baseModel: frontier, lastAutoModel: cheap, currentModel: cheap };

	it("is true only while the current model is the auto-selected cheaper route", () => {
		expect(isFusionAutoDowngradedRoute(active)).toBe(true);
		// On the frontier model, failures must not pre-load a later cheap-route streak.
		expect(isFusionAutoDowngradedRoute({ ...active, currentModel: frontier })).toBe(false);
		expect(isFusionAutoDowngradedRoute({ ...active, currentModel: manual })).toBe(false);
		expect(isFusionAutoDowngradedRoute({ ...active, routingDisabled: true })).toBe(false);
		expect(isFusionAutoDowngradedRoute({ ...active, baseModel: undefined })).toBe(false);
		expect(isFusionAutoDowngradedRoute({ ...active, lastAutoModel: undefined })).toBe(false);
		expect(isFusionAutoDowngradedRoute({ ...active, currentModel: undefined })).toBe(false);
	});
});

describe("nextFusionToolFailureStreak", () => {
	it("treats inspection, edit, and bookkeeping tools as streak-neutral on success", () => {
		for (const toolName of ["read", "grep", "glob", "ast_grep", "lsp", "edit", "write", "ast_edit", "todo", "goal"]) {
			expect(isFusionStreakNeutralToolSuccess(toolName)).toBe(true);
			expect(
				nextFusionToolFailureStreak({
					currentStreak: 2,
					isError: false,
					toolName,
					autoDowngradedRoute: true,
				}),
			).toBe(2);
		}
	});

	it("resets streak to 0 when a verification or execution tool succeeds", () => {
		for (const toolName of ["bash", "eval", "debug", "task", undefined]) {
			expect(isFusionStreakNeutralToolSuccess(toolName)).toBe(false);
			expect(
				nextFusionToolFailureStreak({
					currentStreak: 2,
					isError: false,
					toolName,
					autoDowngradedRoute: true,
				}),
			).toBe(0);
		}
	});

	it("increments streak on any tool error while on an auto-downgraded route and zeroes outside it", () => {
		expect(
			nextFusionToolFailureStreak({
				currentStreak: 1,
				isError: true,
				toolName: "read",
				autoDowngradedRoute: true,
			}),
		).toBe(2);
		expect(
			nextFusionToolFailureStreak({
				currentStreak: 2,
				isError: true,
				toolName: "bash",
				autoDowngradedRoute: false,
			}),
		).toBe(0);
	});
});

describe("parseFusionRoute", () => {
	it("parses cheap and frontier route markers", () => {
		expect(parseFusionRoute("<route>cheap</route>")).toBe("cheap");
		expect(parseFusionRoute("<route>frontier</route>")).toBe("frontier");
	});

	it("parses tier-number route markers", () => {
		expect(parseFusionRoute("<route>1</route>")).toBe(1);
		expect(parseFusionRoute("verdict: <route> 5 </route>")).toBe(5);
	});

	it("tolerates surrounding text, whitespace, and case", () => {
		expect(parseFusionRoute("Reasoning done.\n<route> CHEAP </route>\n")).toBe("cheap");
		expect(parseFusionRoute("verdict: <ROUTE>Frontier</ROUTE>".toLowerCase())).toBe("frontier");
	});

	it("returns null for missing or invalid markers", () => {
		expect(parseFusionRoute("")).toBeNull();
		expect(parseFusionRoute("cheap")).toBeNull();
		expect(parseFusionRoute("<route>medium</route>")).toBeNull();
		expect(parseFusionRoute("<route>0</route>")).toBeNull();
		expect(parseFusionRoute("<route>6</route>")).toBeNull();
	});
});

describe("fusion pool entries", () => {
	it("parses tier=selector entries sorted strongest-first", () => {
		const pool = parseFusionPoolEntries(["3=vendor/mid", "1=vendor/big", "5=vendor/tiny"]);
		expect(pool).toEqual([
			{ tier: 1, selector: "vendor/big" },
			{ tier: 3, selector: "vendor/mid" },
			{ tier: 5, selector: "vendor/tiny" },
		]);
	});

	it("drops invalid tiers and empty selectors, keeps last duplicate", () => {
		const pool = parseFusionPoolEntries(["0=vendor/x", "6=vendor/y", "2=", "garbage", "2=vendor/a", "2=vendor/b"]);
		expect(pool).toEqual([{ tier: 2, selector: "vendor/b" }]);
	});

	it("round-trips through formatFusionPoolEntries", () => {
		const entries = ["1=vendor/big", "4=vendor/small"];
		expect(formatFusionPoolEntries(parseFusionPoolEntries(entries))).toEqual(entries);
	});
});

describe("resolveEffectiveFusionRoute", () => {
	const pool = parseFusionPoolEntries(["1=vendor/big", "5=vendor/tiny"]);

	it("passes real routes through unchanged", () => {
		expect(resolveEffectiveFusionRoute("frontier", { alreadySwitched: true })).toBe("frontier");
		expect(resolveEffectiveFusionRoute(3, { alreadySwitched: true, pool })).toBe(3);
	});

	it("binary mode: null falls back to the one-shot cheap downgrade", () => {
		expect(resolveEffectiveFusionRoute(null, { alreadySwitched: false })).toBe("cheap");
		expect(resolveEffectiveFusionRoute(null, { alreadySwitched: true })).toBeUndefined();
	});

	it("pool mode: null never routes (no silent drop to a weaker tier)", () => {
		expect(resolveEffectiveFusionRoute(null, { alreadySwitched: false, pool })).toBeUndefined();
		expect(resolveEffectiveFusionRoute(null, { alreadySwitched: true, pool })).toBeUndefined();
	});
});

describe("renderPoolClassifierPrompt", () => {
	it("lists each tier with its descriptor and the strongest-when-unsure rule", () => {
		const rendered = renderPoolClassifierPrompt(parseFusionPoolEntries(["1=vendor/big", "3=vendor/mid"]));
		expect(rendered).toContain("Tier 1: vendor/big");
		expect(rendered).toContain("Tier 3: vendor/mid");
		expect(rendered).toContain("pick the strongest available tier");
	});
});

describe("resolveSidekickRoute", () => {
	const pool = parseFusionPoolEntries(["1=vendor/big", "3=vendor/mid", "5=vendor/tiny"]);

	it("frontier route maps to strong (the hard stretch)", () => {
		expect(resolveSidekickRoute("frontier", pool)).toBe("strong");
	});

	it("strongest pool tier maps to strong; weaker tiers map to base", () => {
		expect(resolveSidekickRoute(1, pool)).toBe("strong");
		expect(resolveSidekickRoute(3, pool)).toBe("base");
		expect(resolveSidekickRoute(5, pool)).toBe("base");
	});

	it("cheap route (binary mode) maps to base", () => {
		expect(resolveSidekickRoute("cheap", pool)).toBe("base");
	});

	it("empty pool: only `frontier` maps to strong", () => {
		expect(resolveSidekickRoute("frontier", [])).toBe("strong");
		expect(resolveSidekickRoute("cheap", [])).toBe("base");
	});
});

describe("shouldRunFusionCompactionSwitch", () => {
	const baseOpts = {
		hasCompactSelector: false,
		poolMode: false,
		dynamicRouting: false,
		hasSidekickStrongSelector: false,
		pool: [] as ReturnType<typeof parseFusionPoolEntries>,
	};

	it("runs when a compact model is configured", () => {
		expect(shouldRunFusionCompactionSwitch({ ...baseOpts, hasCompactSelector: true })).toBe(true);
	});

	it("runs in pool mode regardless of dynamic routing", () => {
		expect(shouldRunFusionCompactionSwitch({ ...baseOpts, poolMode: true })).toBe(true);
	});

	it("runs in dynamic routing when a pool has 2+ tiers", () => {
		const pool = parseFusionPoolEntries(["1=big", "3=mid"]);
		expect(shouldRunFusionCompactionSwitch({ ...baseOpts, dynamicRouting: true, pool })).toBe(true);
	});

	it("runs in dynamic routing when sidekick strong model is set, even with no main target", () => {
		expect(
			shouldRunFusionCompactionSwitch({ ...baseOpts, dynamicRouting: true, hasSidekickStrongSelector: true }),
		).toBe(true);
	});

	it("skips when nothing is configured — opt-in by design", () => {
		expect(shouldRunFusionCompactionSwitch(baseOpts)).toBe(false);
		expect(shouldRunFusionCompactionSwitch({ ...baseOpts, dynamicRouting: true })).toBe(false);
	});
});

const pool = [
	{ tier: 1, selector: "frontier/strong" },
	{ tier: 3, selector: "mid/balanced" },
	{ tier: 5, selector: "cheap/fast" },
];

function choice(value: string, confidence: number): TypeSafeAnswer {
	return { type: "choice", choice: value, probabilities: { [value]: confidence }, confidence };
}

describe("decision-model fusion routing", () => {
	const messages = Array.from({ length: 10 }, (_, index) => ({
		role: index % 2 === 0 ? "user" : "assistant",
		content: `turn ${index}`,
	}));

	it("builds state from the summary plus the trailing window of the conversation", () => {
		const state = buildDecisionRouteState("settled plan", messages, 25);
		expect(state.startsWith("Summary:\nsettled plan")).toBe(true);
		expect(state).toContain("turn 8");
		expect(state).toContain("turn 9");
		expect(state).not.toContain("turn 6");
	});

	it("sends the summary alone when the window is zero", () => {
		expect(buildDecisionRouteState("only summary", messages, 0)).not.toContain("Recent conversation");
	});

	it("offers exactly the configured pool tiers as choices", () => {
		expect(Object.keys(decisionRouteQuestion(pool).criteria)).toEqual(["1", "3", "5"]);
	});

	it("accepts a confident choice of a listed tier", () => {
		expect(parseDecisionRouteAnswer(choice("3", 0.8), pool)).toBe(3);
	});

	it("rejects a low-confidence, unlisted, or non-choice answer", () => {
		expect(parseDecisionRouteAnswer(choice("3", 0.4), pool)).toBeNull();
		expect(parseDecisionRouteAnswer(choice("2", 0.9), pool)).toBeNull();
		expect(parseDecisionRouteAnswer({ type: "noul", noul: 1 }, pool)).toBeNull();
		expect(parseDecisionRouteAnswer(undefined, pool)).toBeNull();
	});

	it("returns the decision model's tier and never calls it without a pool", async () => {
		const seen: string[] = [];
		const client = {
			judge: async (state: string) => {
				seen.push(state);
				return choice("5", 0.9);
			},
		};
		expect(await classifyFusionRouteViaDecision("apply the plan", messages, pool, 25, { client })).toBe(5);
		expect(seen[0]).toContain("turn 9");
		expect(
			await classifyFusionRouteViaDecision("apply the plan", messages, pool.slice(0, 1), 25, { client }),
		).toBeNull();
		expect(seen).toHaveLength(1);
	});

	it("falls back instead of throwing when the decision model fails", async () => {
		const client = {
			judge: async () => {
				throw new Error("endpoint down");
			},
		};
		expect(await classifyFusionRouteViaDecision("summary", messages, pool, 25, { client })).toBeNull();
	});
});
describe("Fusion token-savings cache break-even & TTL stickiness helpers", () => {
	const paidFrontier = {
		provider: "anthropic",
		id: "claude-sonnet-4-5",
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	} as Model;
	const paidMidTask = {
		provider: "anthropic",
		id: "claude-mid-task",
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	} as Model;
	const paidFlashTask = {
		provider: "google",
		id: "gemini-flash",
		cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
	} as Model;
	const subscriptionFrontier = {
		provider: "claude-code",
		id: "sonnet-sub",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model;
	const subscriptionTask = {
		provider: "antigravity",
		id: "hydrogen-sub",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model;
	const cheapDefaultModel = {
		provider: "google",
		id: "gemini-flash-default",
		cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
	} as Model;

	it("computes warm prefix tokens within TTL and resets to full cold delta once TTL expires", () => {
		const now = 1_000_000;
		const warm = computeFusionWarmPrefixTokens({
			currentContextTokens: 60_000,
			watermark: { cachedTokens: 52_000, lastUsedAt: now - 60_000 },
			now,
		});
		expect(warm).toEqual({
			withinTtl: true,
			warmTokens: 52_000,
			uncachedDeltaTokens: 8_000,
		});

		const expired = computeFusionWarmPrefixTokens({
			currentContextTokens: 60_000,
			watermark: { cachedTokens: 52_000, lastUsedAt: now - DEFAULT_FUSION_TOKEN_SAVINGS_CACHE_TTL_MS },
			now,
		});
		expect(expired).toEqual({
			withinTtl: false,
			warmTokens: 0,
			uncachedDeltaTokens: 60_000,
		});
	});

	it("accounts for cacheRead, cacheWrite, and non-caching rates across horizonCalls", () => {
		const anthropicCost = estimateFusionPrefixHorizonCostUsd({
			cost: paidFrontier.cost,
			currentContextTokens: 60_000,
			warmTokens: 50_000,
			horizonCalls: 2,
		});
		expect(anthropicCost).toBeCloseTo((50_000 * 0.3 + 10_000 * 3.75 + 60_000 * 0.3) / 1_000_000, 8);

		const googleCost = estimateFusionPrefixHorizonCostUsd({
			cost: paidFlashTask.cost,
			currentContextTokens: 60_000,
			warmTokens: 0,
			horizonCalls: 2,
		});
		expect(googleCost).toBeCloseTo((60_000 * 0.15 + 60_000 * 0.015) / 1_000_000, 8);
	});

	it("bypasses cache gating below the small-context floor (< 16,000 tokens)", () => {
		const now = 500_000;
		const decision = decideFusionTokenSavingsSwitch({
			defaultModel: paidFrontier,
			taskModel: paidMidTask,
			currentContextTokens: DEFAULT_FUSION_TOKEN_SAVINGS_MIN_CACHE_CONTEXT_TOKENS - 1,
			defaultWatermark: {
				cachedTokens: DEFAULT_FUSION_TOKEN_SAVINGS_MIN_CACHE_CONTEXT_TOKENS - 1,
				lastUsedAt: now,
			},
			amortizationCalls: 1,
			now,
		});
		expect(decision.shouldSwitch).toBe(true);
		expect(decision.reason).toBe("small-context");
	});

	it("blocks unprofitable short switches on deep paid contexts until todos or warm deltas justify switching", () => {
		const now = 500_000;
		const blocked = decideFusionTokenSavingsSwitch({
			defaultModel: paidFrontier,
			taskModel: paidMidTask,
			currentContextTokens: 60_000,
			defaultWatermark: { cachedTokens: 60_000, lastUsedAt: now },
			amortizationCalls: 2,
			openTodoCount: 0,
			now,
		});
		expect(blocked.shouldSwitch).toBe(false);
		expect(blocked.reason).toBe("cache-break-even-not-met");

		const justifiedByTodos = decideFusionTokenSavingsSwitch({
			defaultModel: paidFrontier,
			taskModel: paidMidTask,
			currentContextTokens: 60_000,
			defaultWatermark: { cachedTokens: 60_000, lastUsedAt: now },
			amortizationCalls: 2,
			openTodoCount: 7,
			now,
		});
		expect(justifiedByTodos.shouldSwitch).toBe(true);
		expect(justifiedByTodos.reason).toBe("cache-break-even-met");

		const justifiedByDelta = decideFusionTokenSavingsSwitch({
			defaultModel: paidFrontier,
			taskModel: paidMidTask,
			currentContextTokens: 60_000,
			defaultWatermark: { cachedTokens: 60_000, lastUsedAt: now },
			taskWatermark: { cachedTokens: 54_000, lastUsedAt: now - 30_000 },
			amortizationCalls: 1,
			now,
		});
		expect(justifiedByDelta.shouldSwitch).toBe(true);
		expect(justifiedByDelta.reason).toBe("cache-break-even-met");
	});

	it("uses zero-cost-fallback when either model reports $0 catalog pricing (subscriptions/local)", () => {
		const now = 500_000;
		const subDecision = decideFusionTokenSavingsSwitch({
			defaultModel: subscriptionFrontier,
			taskModel: subscriptionTask,
			currentContextTokens: 70_000,
			defaultWatermark: { cachedTokens: 70_000, lastUsedAt: now },
			now,
		});
		expect(subDecision.shouldSwitch).toBe(true);
		expect(subDecision.reason).toBe("zero-cost-fallback");
	});

	it("keeps pi/task sticky on deep contexts within TTL for short tails and restores default on TTL expiry, small context, or escalation", () => {
		const now = 1_000_000;
		const baseArgs = {
			fusionEnabled: true,
			fusionMode: "token-savings",
			routingDisabled: false,
			switchedInPriorTurn: true,
			baseModel: cheapDefaultModel,
			lastAutoModel: paidMidTask,
			currentModel: paidMidTask,
			currentContextTokens: 60_000,
			taskCallsSinceSwitch: DEFAULT_FUSION_TOKEN_SAVINGS_STICKY_MAX_CALLS,
			amortizationCalls: 2,
			taskWatermark: { cachedTokens: 60_000, lastUsedAt: now - 20_000 },
			now,
		};

		expect(decideFusionTokenSavingsTurnStart(baseArgs)).toEqual({
			action: "keep-sticky-task",
			reason: "sticky-short-tail",
		});

		expect(
			decideFusionTokenSavingsTurnStart({
				...baseArgs,
				taskWatermark: { cachedTokens: 60_000, lastUsedAt: now - DEFAULT_FUSION_TOKEN_SAVINGS_CACHE_TTL_MS },
			}),
		).toEqual({
			action: "restore-default",
			reason: "ttl-expired",
		});

		expect(
			decideFusionTokenSavingsTurnStart({
				...baseArgs,
				currentContextTokens: 10_000,
			}),
		).toEqual({
			action: "restore-default",
			reason: "small-context",
		});

		expect(
			decideFusionTokenSavingsTurnStart({
				...baseArgs,
				taskCallsSinceSwitch: DEFAULT_FUSION_TOKEN_SAVINGS_STICKY_MAX_CALLS + 1,
			}),
		).toEqual({
			action: "restore-default",
			reason: "tail-amortized",
		});

		// `0` disables sticky retention: restore even though the default prefix is cold.
		expect(
			decideFusionTokenSavingsTurnStart({
				...baseArgs,
				stickyMaxCalls: 0,
				defaultWatermark: {
					cachedTokens: 60_000,
					lastUsedAt: now - DEFAULT_FUSION_TOKEN_SAVINGS_CACHE_TTL_MS,
				},
			}),
		).toEqual({
			action: "restore-default",
			reason: "tail-amortized",
		});

		expect(
			decideFusionTokenSavingsTurnStart({
				...baseArgs,
				lastAutoModel: cheapDefaultModel,
				currentModel: cheapDefaultModel,
			}),
		).toEqual({
			action: "already-default",
			reason: "escalated-or-already-default",
		});

		expect(
			decideFusionTokenSavingsTurnStart({
				...baseArgs,
				currentModel: paidFlashTask,
			}),
		).toEqual({
			action: "manual-override",
			reason: "manual-override",
		});
	});

	it("keeps pi/task sticky when restoring a cold default would cost more over the amortization horizon", () => {
		const now = 1_000_000;
		const decision = decideFusionTokenSavingsTurnStart({
			fusionEnabled: true,
			fusionMode: "token-savings",
			routingDisabled: false,
			switchedInPriorTurn: true,
			baseModel: paidFrontier,
			lastAutoModel: paidMidTask,
			currentModel: paidMidTask,
			currentContextTokens: 60_000,
			taskCallsSinceSwitch: DEFAULT_FUSION_TOKEN_SAVINGS_STICKY_MAX_CALLS + 1,
			amortizationCalls: 2,
			defaultWatermark: {
				cachedTokens: 60_000,
				lastUsedAt: now - DEFAULT_FUSION_TOKEN_SAVINGS_CACHE_TTL_MS,
			},
			taskWatermark: { cachedTokens: 60_000, lastUsedAt: now - 20_000 },
			now,
		});
		expect(decision).toEqual({ action: "keep-sticky-task", reason: "sticky-default-cold" });
	});

	it("restores default on tail amortization for zero-cost subscription models", () => {
		const now = 1_000_000;
		const decision = decideFusionTokenSavingsTurnStart({
			fusionEnabled: true,
			fusionMode: "token-savings",
			routingDisabled: false,
			switchedInPriorTurn: true,
			baseModel: subscriptionFrontier,
			lastAutoModel: subscriptionTask,
			currentModel: subscriptionTask,
			currentContextTokens: 60_000,
			taskCallsSinceSwitch: DEFAULT_FUSION_TOKEN_SAVINGS_STICKY_MAX_CALLS + 1,
			amortizationCalls: 2,
			taskWatermark: { cachedTokens: 60_000, lastUsedAt: now - 20_000 },
			now,
		});
		expect(decision).toEqual({ action: "restore-default", reason: "tail-amortized" });
	});
});
