/**
 * Fixer-Guided Context Packet Benchmark & Unit Tests (arXiv:2611.12164).
 *
 * Compares `rankAndBudgetFixerSlices` (backing `ContextOracle.buildFixerContextPacket`)
 * against a naive full-file/grep baseline on a deterministic multi-file fixture,
 * verifying target-symbol recall, explicit `maxTokens` enforcement, and token reduction.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { estimateTokens, rankAndBudgetFixerSlices, scanWorkspaceForTarget } from "../../src/context-layer/fixer-packet";

const tempDirs: string[] = [];
afterAll(async () => {
	for (const dir of tempDirs) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

function fillerLines(prefix: string, count: number): string {
	return Array.from(
		{ length: count },
		(_, i) => `export const ${prefix}_padding_${i} = "${prefix}_unused_metadata_block_${i}_abcdef0123456789";`,
	).join("\n");
}

describe("ContextOracle fixer-guided context packet", () => {
	it("cuts context tokens substantially vs naive full-file grep baseline while preserving 100% target definition + caller recall", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompk-fixer-packet-"));
		tempDirs.push(dir);

		const targetSymbol = "reconcileQuotaBudget";
		const files: Record<string, string> = {
			"src/quota/engine.ts": [
				fillerLines("engine_top", 40),
				`export function ${targetSymbol}(used: number, limit: number): { ok: boolean; remaining: number } {`,
				"  const remaining = Math.max(0, limit - used);",
				"  return { ok: used <= limit, remaining };",
				"}",
				fillerLines("engine_bottom", 40),
			].join("\n"),
			"src/quota/caller-a.ts": [
				fillerLines("caller_a_top", 35),
				`import { ${targetSymbol} } from "./engine";`,
				`export function checkSessionQuota(used: number) { return ${targetSymbol}(used, 1000); }`,
				fillerLines("caller_a_bottom", 35),
			].join("\n"),
			"src/quota/caller-b.ts": [
				fillerLines("caller_b_top", 35),
				`import { ${targetSymbol} } from "./engine";`,
				`export function enforceWriteQuota(used: number) { return ${targetSymbol}(used, 500).ok; }`,
				fillerLines("caller_b_bottom", 35),
			].join("\n"),
			"src/quota/docs-mention.md": [
				fillerLines("doc_noise", 40),
				`Note: see ${targetSymbol} for legacy discussion.`,
				fillerLines("doc_tail", 40),
			].join("\n"),
			"src/unrelated/noise-a.ts": fillerLines("noise_a", 60),
			"src/unrelated/noise-b.ts": fillerLines("noise_b", 60),
		};

		for (const [rel, content] of Object.entries(files)) {
			const full = path.join(dir, rel);
			await fs.mkdir(path.dirname(full), { recursive: true });
			await fs.writeFile(full, content, "utf8");
		}

		// Baseline: naive grep-matched full-file dump (all files containing targetSymbol).
		const lexicalCandidates = await scanWorkspaceForTarget(dir, targetSymbol);
		const matchedFiles = [
			...new Set(lexicalCandidates.map(item => item.file).filter((f): f is string => Boolean(f))),
		];
		let naiveBaselineTokens = 0;
		for (const rel of matchedFiles) {
			const fullText = await fs.readFile(path.join(dir, rel), "utf8");
			naiveBaselineTokens += estimateTokens(fullText);
		}

		// Candidate: ranked, budgeted fixer packet (maxTokens: 520, contextLines: 3).
		const packet = await rankAndBudgetFixerSlices(dir, targetSymbol, lexicalCandidates, {
			file: "src/quota/engine.ts",
			maxTokens: 520,
			contextLines: 3,
		});

		expect(packet.target).toBe(targetSymbol);
		expect(packet.targetSymbolIncluded).toBe(true);
		expect(packet.tokenEstimate).toBeLessThanOrEqual(520);
		expect(packet.slices[0]?.reason).toBe("definition");
		expect(packet.slices[0]?.file).toBe("src/quota/engine.ts");
		expect(packet.filesIncluded).toContain("src/quota/engine.ts");
		expect(packet.filesIncluded).toContain("src/quota/caller-a.ts");
		expect(packet.filesIncluded).toContain("src/quota/caller-b.ts");
		expect(packet.filesIncluded).not.toContain("src/quota/docs-mention.md");
		expect(packet.droppedEvidenceCount).toBeGreaterThan(0);

		const reductionRatio = (naiveBaselineTokens - packet.tokenEstimate) / naiveBaselineTokens;
		expect(naiveBaselineTokens).toBeGreaterThan(5_000);
		expect(reductionRatio).toBeGreaterThan(0.9);
	});

	it("prioritizes definitions and diagnostics over summaries under a tight token budget", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompk-fixer-tight-"));
		tempDirs.push(dir);

		await fs.writeFile(
			path.join(dir, "target.ts"),
			[
				"// header",
				"export function applyPolicyGuard(x: number): boolean {",
				"  return x > 0;",
				"}",
				fillerLines("tail", 20),
			].join("\n"),
			"utf8",
		);
		await fs.writeFile(path.join(dir, "summary.ts"), fillerLines("summary_noise", 30), "utf8");

		const packet = await rankAndBudgetFixerSlices(
			dir,
			"applyPolicyGuard",
			[
				{ type: "summary", file: "summary.ts", range: { startLine: 1, endLine: 25 }, detail: "large summary" },
				{
					type: "search",
					file: "target.ts",
					range: { startLine: 2, endLine: 4 },
					detail: "export function applyPolicyGuard",
				},
			],
			{ maxTokens: 120, contextLines: 2 },
		);

		expect(packet.slices).toHaveLength(1);
		expect(packet.slices[0]?.file).toBe("target.ts");
		expect(packet.slices[0]?.reason).toBe("definition");
		expect(packet.droppedEvidenceCount).toBe(1);
		expect(packet.tokenEstimate).toBeLessThanOrEqual(120);
	});
});
