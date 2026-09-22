import { describe, expect, test } from "bun:test";
import { arbitrateHealth, buildSyntheticHint } from "../../src/watchdog/arbitrator";
import type { WatchdogEvaluation } from "../../src/watchdog/types";

describe("arbitrateHealth", () => {
	test("returns pass when evaluation is undefined", () => {
		const result = arbitrateHealth(undefined);
		expect(result).toEqual({ action: "pass" });
	});

	test("returns pass when agent is healthy and progressing normally", () => {
		const evalNominal: WatchdogEvaluation = {
			isThrashing: 0.1,
			stallSeverity: 0.3,
			blockerType: "none",
			confidence: 0.95,
			latencyMs: 120,
		};
		const result = arbitrateHealth(evalNominal);
		expect(result).toEqual({ action: "pass" });
	});

	test("returns inject_hint when agent enters warning zone (severity >= 1.6)", () => {
		const evalWarning: WatchdogEvaluation = {
			isThrashing: 0.65,
			stallSeverity: 1.8,
			blockerType: "syntax_or_tag_mismatch",
			confidence: 0.8,
			latencyMs: 140,
		};
		const result = arbitrateHealth(evalWarning, {}, { tool: "edit", target: "src/auth.ts" });
		expect(result.action).toBe("inject_hint");
		if (result.action === "inject_hint") {
			expect(result.severity).toBe(1.8);
			expect(result.blockerType).toBe("syntax_or_tag_mismatch");
			expect(result.hint).toContain("src/auth.ts");
			expect(result.hint).toContain("read");
		}
	});

	test("returns tripwire_abort when stall severity reaches danger zone (severity >= 2.5)", () => {
		const evalFatal: WatchdogEvaluation = {
			isThrashing: 0.7,
			stallSeverity: 2.8,
			blockerType: "command_failure_loop",
			confidence: 0.9,
			latencyMs: 150,
		};
		const result = arbitrateHealth(evalFatal, {}, { tool: "bash", target: "npm install" });
		expect(result.action).toBe("tripwire_abort");
		if (result.action === "tripwire_abort") {
			expect(result.severity).toBe(2.8);
			expect(result.thrashing).toBe(0.7);
			expect(result.reason).toContain("System 1 Watchdog: Agent wedged");
			expect(result.reason).toContain("command_failure_loop");
		}
	});

	test("returns tripwire_abort when is_thrashing >= 0.85 even with moderate severity", () => {
		const evalThrashing: WatchdogEvaluation = {
			isThrashing: 0.92,
			stallSeverity: 2.1,
			blockerType: "missing_dependency_or_path",
			confidence: 0.85,
			latencyMs: 130,
		};
		const result = arbitrateHealth(evalThrashing);
		expect(result.action).toBe("tripwire_abort");
	});

	test("builds synthetic hints tailored to blocker types", () => {
		const syntaxHint = buildSyntheticHint("syntax_or_tag_mismatch", { target: "index.ts" });
		expect(syntaxHint).toContain("refresh the snapshot tag");

		const cmdHint = buildSyntheticHint("command_failure_loop", { target: "cargo build" });
		expect(cmdHint).toContain("Re-verify arguments");

		const pathHint = buildSyntheticHint("missing_dependency_or_path", { target: "foo/bar" });
		expect(pathHint).toContain("glob or read");

		const semanticHint = buildSyntheticHint("semantic_confusion");
		expect(semanticHint).toContain("assignment instructions");
	});
});
