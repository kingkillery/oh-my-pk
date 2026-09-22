import { describe, expect, test } from "bun:test";
import { extractToolTarget, TelemetryTap } from "../../src/watchdog/telemetry-tap";

describe("TelemetryTap", () => {
	test("maintains bounded sliding window of actions", () => {
		const tap = new TelemetryTap(3);
		expect(tap.recentActions.length).toBe(0);

		tap.record({ tool: "read", target: "a.ts", status: "success", durationMs: 10 });
		tap.record({ tool: "edit", target: "a.ts", status: "success", durationMs: 20 });
		tap.record({ tool: "bash", target: "bun test", status: "success", durationMs: 30 });
		expect(tap.recentActions.length).toBe(3);

		tap.record({ tool: "grep", target: "pattern", status: "success", durationMs: 40 });
		expect(tap.recentActions.length).toBe(3);
		expect(tap.recentActions[0].tool).toBe("edit");
		expect(tap.recentActions[2].tool).toBe("grep");
	});

	test("accurately counts consecutive errors backwards from tail", () => {
		const tap = new TelemetryTap(5);
		expect(tap.consecutiveErrors).toBe(0);

		tap.record({ tool: "read", status: "success", durationMs: 10 });
		expect(tap.consecutiveErrors).toBe(0);

		tap.record({ tool: "edit", status: "error", errorMessage: "tag mismatch", durationMs: 15 });
		expect(tap.consecutiveErrors).toBe(1);

		tap.record({ tool: "edit", status: "error", errorMessage: "tag mismatch", durationMs: 15 });
		expect(tap.consecutiveErrors).toBe(2);

		tap.record({ tool: "read", status: "success", durationMs: 5 });
		expect(tap.consecutiveErrors).toBe(0);
	});

	test("accurately counts consecutive same target interactions", () => {
		const tap = new TelemetryTap(5);
		expect(tap.consecutiveSameTarget).toBe(0);

		tap.record({ tool: "read", target: "src/index.ts", status: "success", durationMs: 10 });
		expect(tap.consecutiveSameTarget).toBe(1);

		tap.record({ tool: "edit", target: "src/index.ts", status: "error", durationMs: 20 });
		expect(tap.consecutiveSameTarget).toBe(2);

		tap.record({ tool: "edit", target: "src/index.ts", status: "error", durationMs: 20 });
		expect(tap.consecutiveSameTarget).toBe(3);

		tap.record({ tool: "read", target: "src/other.ts", status: "success", durationMs: 10 });
		expect(tap.consecutiveSameTarget).toBe(1);
	});

	test("compacts state into concise formatted string", () => {
		const tap = new TelemetryTap(5);
		tap.record({
			tool: "edit",
			target: "src/auth.ts",
			status: "error",
			errorMessage: "Tag mismatch #1A2B",
			durationMs: 25,
		});
		tap.record({
			tool: "edit",
			target: "src/auth.ts",
			status: "error",
			errorMessage: "Tag mismatch #1A2B",
			durationMs: 20,
		});

		const state = tap.toCompactState("tester", "Fix auth token refresh");
		expect(state).toContain("Agent Role: tester");
		expect(state).toContain("Goal: Fix auth token refresh");
		expect(state).toContain('edit "src/auth.ts" [ERROR: Tag mismatch #1A2B]');
		expect(state).toContain('Target "src/auth.ts" touched 2x consecutively');
	});

	test("extracts tool targets correctly from diverse tool args", () => {
		expect(extractToolTarget("edit", { path: "src/foo.ts" })).toBe("src/foo.ts");
		expect(extractToolTarget("edit", { target: "src/bar.ts" })).toBe("src/bar.ts");
		expect(extractToolTarget("read", { path: "README.md" })).toBe("README.md");
		expect(extractToolTarget("write", { path: "dist/out.js" })).toBe("dist/out.js");
		expect(extractToolTarget("bash", { command: "git status\nand more" })).toBe("git status");
		expect(extractToolTarget("grep", { pattern: "TODO" })).toBe("TODO");
		expect(extractToolTarget("ast_grep", { pat: "console.log($$$)" })).toBe("console.log($$$)");
		expect(extractToolTarget("glob", { paths: ["src/**/*.ts"] })).toBe("src/**/*.ts");
		expect(extractToolTarget("unknown_tool", null)).toBeUndefined();
	});
});
