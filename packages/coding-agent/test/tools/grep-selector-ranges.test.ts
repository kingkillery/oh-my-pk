import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { GrepTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/grep";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

describe("grep exact line selectors", () => {
	let cwd: string;
	let tool: GrepTool;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "grep-exact-ranges-"));
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "grep.contextBefore": 2, "grep.contextAfter": 2 }),
		};
		tool = new GrepTool(session);
		await Bun.write(
			path.join(cwd, "matches.txt"),
			Array.from({ length: 200 }, (_, i) => `needle ${i + 1}`).join("\n"),
		);
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it.each(["150+1", "150-150", "150-152", "150+1,180-181"])(
		"filters %s before match caps and trims context",
		async selector => {
			const result = await tool.execute(`ranged-${selector}`, {
				pattern: "needle",
				paths: [`matches.txt:${selector}`],
			});
			const text = result.content
				.filter(entry => entry.type === "text")
				.map(entry => entry.text)
				.join("\n");
			const expected = selector.includes("180") ? [150, 180, 181] : selector === "150-152" ? [150, 151, 152] : [150];
			expect(result.details?.matchCount).toBe(expected.length);
			for (const line of expected) expect(text).toContain(`needle ${line}`);
			for (const line of [1, 149, 153, 179, 182]) expect(text).not.toMatch(new RegExp(`needle ${line}(?:\\n|$)`));
		},
	);

	it("combines a ranged file with an unrestricted peer without losing either scope", async () => {
		await Bun.write(path.join(cwd, "peer.txt"), "needle peer\n");
		const result = await tool.execute("mixed-ranges", {
			pattern: "needle",
			paths: ["matches.txt:150+1", "peer.txt"],
		});
		const text = result.content
			.filter(entry => entry.type === "text")
			.map(entry => entry.text)
			.join("\n");
		expect(result.details?.matchCount).toBe(2);
		expect(text).toContain("needle 150");
		expect(text).toContain("needle peer");
	});

	it("does not duplicate the ranged file when a peer directory also contains it", async () => {
		const result = await tool.execute("overlapping-scope", { pattern: "needle", paths: ["matches.txt:3+1", "."] });
		expect(result.details?.matchCount).toBe(1);
		expect(result.details?.truncated).toBe(false);
	});

	it.each([false, true])(
		"checks complete multiline spans before range limits (long first line: %s)",
		async longLine => {
			const firstLine = `needle${longLine ? "x".repeat(1000) : ""}`;
			await Bun.write(path.join(cwd, "span.txt"), `${firstLine}\nsecond\nthird\n`);
			const pattern = "needle[^\\n]*\\nsecond";
			for (const selector of ["1+1", "1+1,3+1"]) {
				const result = await tool.execute(`excluded-span-${selector}`, {
					pattern,
					paths: [`span.txt:${selector}`],
				});
				expect(result.details?.matchCount).toBe(0);
			}
			const included = await tool.execute("included-span", { pattern, paths: ["span.txt:1-2"] });
			expect(included.details?.matchCount).toBe(1);
		},
	);

	it("keeps the local file size guard for ranged selectors", async () => {
		await Bun.write(path.join(cwd, "oversized.txt"), `needle\n${"x".repeat(4 * 1024 * 1024)}`);
		const result = await tool.execute("oversized-range", { pattern: "needle", paths: ["oversized.txt:1+1"] });
		const text = result.content
			.filter(entry => entry.type === "text")
			.map(entry => entry.text)
			.join("\n");
		expect(result.details?.matchCount).toBe(0);
		expect(text).toContain("oversized");
	});

	it("does not infer multiline bounds from a display payload that trims blank lines", async () => {
		await Bun.write(path.join(cwd, "blank-lines.txt"), "needle\n\noutside\n");
		const excluded = await tool.execute("excluded-blank-line", {
			pattern: "needle\\n\\n",
			paths: ["blank-lines.txt:1+1"],
		});
		expect(excluded.details?.matchCount).toBe(0);
		const included = await tool.execute("included-blank-line", {
			pattern: "needle\\n\\n",
			paths: ["blank-lines.txt:1-2"],
		});
		expect(included.details?.matchCount).toBe(1);
	});
});
