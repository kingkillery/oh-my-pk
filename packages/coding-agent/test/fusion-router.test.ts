import { describe, expect, it } from "bun:test";
import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import {
	buildDecisionRouteState,
	classifyFusionRouteViaDecision,
	decisionRouteQuestion,
	formatFusionPoolEntries,
	isFusionAutoDowngradedRoute,
	parseDecisionRouteAnswer,
	parseFusionPoolEntries,
	parseFusionRoute,
	renderPoolClassifierPrompt,
	resolveEffectiveFusionRoute,
	resolveSidekickRoute,
	shouldRunFusionCompactionSwitch,
} from "@pk-nerdsaver-ai/pi-coding-agent/session/fusion-router";
import type { TypeSafeAnswer } from "@pk-nerdsaver-ai/pi-coding-agent/lib/typesafe-http";

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
