import { describe, expect, it } from "bun:test";
import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import {
	formatFusionPoolEntries,
	isFusionAutoDowngradedRoute,
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
	const active = {
		enabled: true,
		mode: "escalate",
		routingDisabled: false,
		baseModel: frontier,
		lastAutoModel: cheap,
		currentModel: cheap,
	};

	it("counts failures only on the current auto-downgraded route", () => {
		expect(isFusionAutoDowngradedRoute(active)).toBeTrue();
		expect(isFusionAutoDowngradedRoute({ ...active, mode: "delegate" })).toBeFalse();
		expect(isFusionAutoDowngradedRoute({ ...active, baseModel: undefined })).toBeFalse();
		expect(isFusionAutoDowngradedRoute({ ...active, currentModel: frontier })).toBeFalse();
		expect(isFusionAutoDowngradedRoute({ ...active, currentModel: manual })).toBeFalse();
		expect(isFusionAutoDowngradedRoute({ ...active, routingDisabled: true })).toBeFalse();
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
