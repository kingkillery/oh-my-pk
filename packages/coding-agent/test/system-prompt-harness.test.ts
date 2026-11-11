import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "@pk-nerdsaver-ai/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

describe("system prompt harness and settings workflow", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-harness-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-harness-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(opts: Partial<BuildSystemPromptOptions> = {}): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read", "bash"],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			...opts,
		});
		return systemPrompt.join("\n\n");
	}

	it("instructs agent to use omp:// for harness documentation and questions", async () => {
		const prompt = await render();
		expect(prompt).toContain("- `omp://`: harness docs; use to inspect harness documentation");
		expect(prompt).toContain("Harness Capabilities & Settings");
		expect(prompt).toContain("use `omp://` to consult authoritative harness documentation");
	});

	it("instructs agent on settings changes with explicit user approval", async () => {
		const prompt = await render();
		expect(prompt).toContain("**Explicitly ask the user for confirmation/approval** before making persistent changes to settings");
		expect(prompt).toContain("omp config set <key> <value>");
	});
});
