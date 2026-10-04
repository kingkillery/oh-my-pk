import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt, type SystemPromptToolMetadata } from "@pk-nerdsaver-ai/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

const TOOLS = new Map<string, SystemPromptToolMetadata>([
	["eval", { label: "Eval", description: "Run code." }],
	["read", { label: "Read", description: "Read files." }],
]);

describe("system prompt code-mode preference", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-code-mode-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-code-mode-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(toolNames: string[]): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames,
			tools: TOOLS,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});
		return systemPrompt.join("\n\n");
	}

	it("tells the model to batch tool calls in one eval cell when eval is available", async () => {
		const text = await render(["eval", "read"]);
		expect(text).toContain(
			"Prefer one `eval` cell that calls `tool.<name>(args)` over a series of individual tool calls",
		);
	});

	it("does not require code-mode when eval is unavailable", async () => {
		const text = await render(["read"]);
		expect(text).not.toContain("Prefer one `eval` cell");
	});
});
