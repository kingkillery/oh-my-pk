import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "@pk-nerdsaver-ai/pi-coding-agent/system-prompt";
import { loadSimLedger } from "@pk-nerdsaver-ai/pi-coding-agent/utils/sim-ledger";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

describe("system prompt SIM ledger injection", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-sim-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-sim-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	function writeSampleSim(rootDir: string, problemName: string): string {
		const ompDir = path.join(rootDir, ".omp");
		fs.mkdirSync(ompDir, { recursive: true });
		const ledger = {
			next_id: 2,
			aliases: {},
			problems: [
				{
					id: "P1",
					name: problemName,
					opened_round: 1,
					attempts: [
						{
							round: 1,
							accepted: true,
							what: "Recalibrate parser recovery threshold",
							files: ["packages/ai/src/utils/json-parse.ts"],
							model: "gemini-3.8-flash",
							domain: "parsers",
							predicted: ["parser-json-unescaped-controls"],
							fixed: ["parser-json-unescaped-controls"],
							missed: [],
							passed: 16,
							total: 16,
						},
					],
				},
			],
		};
		const content = JSON.stringify(ledger, null, "\t");
		fs.writeFileSync(path.join(ompDir, "sim.json"), content, "utf-8");
		return content;
	}

	async function renderBlocks(opts: Partial<BuildSystemPromptOptions> = {}): Promise<string[]> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "task"],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			...opts,
		});
		return systemPrompt;
	}

	it("auto-discovers .omp/sim.json and injects the full ledger verbatim with Appendix D.2 rules", async () => {
		writeSampleSim(tempDir, "cross-model parser escape mismatch");
		const blocks = await renderBlocks();
		const joined = blocks.join("\n\n");

		expect(joined).toContain('<self-improvement-memory path=".omp/sim.json">');
		expect(joined).toContain("Appendix D.2");
		expect(joined).toContain("Check the `model` and `domain` provenance");
		expect(joined).toContain("cross-model parser escape mismatch");
		expect(joined).toContain('"gemini-3.8-flash"');
		expect(joined).toContain("</self-improvement-memory>");
	});

	it("omits the SIM block when no .omp/sim.json exists or when explicitly disabled with simLedger: null", async () => {
		const absent = (await renderBlocks()).join("\n\n");
		expect(absent).not.toContain("<self-improvement-memory");

		writeSampleSim(tempDir, "should be suppressed");
		const disabled = (await renderBlocks({ simLedger: null })).join("\n\n");
		expect(disabled).not.toContain("<self-improvement-memory");
		expect(disabled).not.toContain("should be suppressed");
	});

	it("keeps block 0 byte-stable and keeps Fusion policies terminal when SIM is injected", async () => {
		const withoutSim = await renderBlocks({ simLedger: null });
		writeSampleSim(tempDir, "prefix stability check");
		const withSim = await renderBlocks();
		const withSimAndFusion = await renderBlocks({
			fusionSidekick: true,
			sidekickModel: "pi/smol",
		});

		expect(withSim[0]).toBe(withoutSim[0]);
		expect(withSimAndFusion[0]).toBe(withoutSim[0]);
		expect(withSimAndFusion.at(-1)?.trim()).toMatch(/^<fusion-sidekick>[\s\S]*<\/fusion-sidekick>$/);
	});

	it("ignores malformed .omp/sim.json without breaking system prompt generation", async () => {
		fs.mkdirSync(path.join(tempDir, ".omp"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".omp", "sim.json"), "{ invalid json", "utf-8");

		const loaded = await loadSimLedger(tempDir);
		expect(loaded).toBeNull();
		const joined = (await renderBlocks()).join("\n\n");
		expect(joined).not.toContain("<self-improvement-memory");
	});

	it("walks up from a nested subdirectory to the enclosing git repo root", async () => {
		fs.mkdirSync(path.join(tempDir, ".git"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf-8");
		writeSampleSim(tempDir, "nested subdirectory walk-up hypothesis");
		const nested = path.join(tempDir, "packages", "coding-agent", "src");
		fs.mkdirSync(nested, { recursive: true });

		const loaded = await loadSimLedger(nested);
		expect(loaded).not.toBeNull();
		expect(loaded?.content).toContain("nested subdirectory walk-up hypothesis");
	});
});
