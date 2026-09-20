import { describe, expect, it, spyOn } from "bun:test";
import { Buffer } from "node:buffer";
import type { Rule } from "@pk-nerdsaver-ai/pi-coding-agent/capability/rule";
import { TtsrManager, type TtsrMatchContext } from "@pk-nerdsaver-ai/pi-coding-agent/export/ttsr";
import { logger } from "@pk-nerdsaver-ai/pi-utils";

function makeRule(overrides: Partial<Rule>): Rule {
	return {
		name: "test-rule",
		path: "/tmp/test-rule.md",
		content: "test rule",
		_source: { provider: "test", providerName: "test", path: "/tmp/test-rule.md", level: "project" },
		...overrides,
	};
}

const toolCtx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["src/foo.ts"] };

describe("TTSR oversized AST snapshot", () => {
	it("skips only the AST condition while regex conditions still fire", async () => {
		const manager = new TtsrManager();
		const rule = makeRule({
			name: "regex-and-ast",
			condition: ["needle-marker"],
			astCondition: ["const $A = $B"],
		});
		expect(manager.addRule(rule)).toBe(true);

		// >1 MB UTF-8 snapshot: over TTSR's preflight ceiling. The regex marker is
		// present, and the AST pattern would also match if it ran.
		const snapshot = `const x = 1; /* needle-marker */ ${"😀".repeat(300_000)}`;
		expect(Buffer.byteLength(snapshot, "utf8")).toBeGreaterThan(1_000_000);

		const debugSpy = spyOn(logger, "debug");
		try {
			// AST condition is skipped for the oversized snapshot.
			expect(await manager.checkAstSnapshot(snapshot, toolCtx)).toEqual([]);
			// The regex/literal condition still evaluates against the same snapshot —
			// the rule pass does not fail.
			expect(manager.checkSnapshot(snapshot, toolCtx).map(r => r.name)).toEqual(["regex-and-ast"]);
			// The skip is recorded with the internal diagnostic reason.
			expect(
				debugSpy.mock.calls.some(
					call =>
						call[0] === "TTSR ast match skipped oversized snapshot" &&
						(call[1] as { reason?: string } | undefined)?.reason === "ast-source-too-large",
				),
			).toBe(true);
		} finally {
			debugSpy.mockRestore();
		}
	});

	it("still evaluates AST conditions for snapshots under the ceiling", async () => {
		const manager = new TtsrManager();
		const rule = makeRule({ name: "ast-only", astCondition: ["const $A = $B"] });
		expect(manager.addRule(rule)).toBe(true);
		expect((await manager.checkAstSnapshot("const x = 1;", toolCtx)).map(r => r.name)).toEqual(["ast-only"]);
	});
});
