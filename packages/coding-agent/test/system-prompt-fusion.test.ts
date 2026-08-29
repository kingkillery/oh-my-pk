import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt } from "@pk-nerdsaver-ai/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

describe("system prompt fusion sidekick policy", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-fusion-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-fusion-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	type FusionPromptOptions = {
		fusionSidekick?: boolean;
		fusionEscalate?: boolean;
		sidekickModel?: string;
		sidekickId?: string;
		toolNames?: string[];
	};

	async function renderBlocks(opts: FusionPromptOptions): Promise<string[]> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: opts.toolNames ?? ["hub"],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			fusionSidekick: opts.fusionSidekick,
			fusionEscalate: opts.fusionEscalate,
			sidekickModel: opts.sidekickModel,
			sidekickId: opts.sidekickId,
		});
		return systemPrompt;
	}

	async function render(opts: FusionPromptOptions): Promise<string> {
		return (await renderBlocks(opts)).join("\n\n");
	}

	it("injects the sidekick policy with the configured model when enabled", async () => {
		const rendered = await render({
			fusionSidekick: true,
			sidekickModel: "vendor/cheapo-1",
			sidekickId: "Sidekick-7",
		});
		expect(rendered).toContain("Sidekick (cost mode)");
		expect(rendered).toContain("Minimize your own actions");
		// The configured sidekick model is interpolated into the policy.
		expect(rendered).toContain("vendor/cheapo-1");
		expect(rendered).toContain("`Sidekick-7`");
		expect(rendered).toContain('op: "send"');
		expect(rendered).toContain('to: "Sidekick-7"');
		expect(rendered).toContain("Do not spawn another task agent");
	});

	it("adds the escalate guidance only in escalate mode", async () => {
		const escalate = await render({ fusionSidekick: true, fusionEscalate: true, sidekickModel: "pi/smol" });
		expect(escalate).toContain("escalate the hard parts");

		const delegateOnly = await render({ fusionSidekick: true, fusionEscalate: false, sidekickModel: "pi/smol" });
		expect(delegateOnly).toContain("Sidekick (cost mode)");
		expect(delegateOnly).not.toContain("escalate the hard parts");
	});

	it("keeps every stable prompt block byte-identical before the terminal Fusion suffix", async () => {
		const withoutFusion = await renderBlocks({ fusionSidekick: false });
		const delegate = await renderBlocks({
			fusionSidekick: true,
			fusionEscalate: false,
			sidekickModel: "vendor/cheap",
			sidekickId: "Sidekick-1",
		});
		const escalate = await renderBlocks({
			fusionSidekick: true,
			fusionEscalate: true,
			sidekickModel: "vendor/strong",
			sidekickId: "Sidekick-9",
		});

		expect(delegate.slice(0, -1)).toEqual(withoutFusion);
		expect(escalate.slice(0, -1)).toEqual(withoutFusion);
		expect(delegate.at(-1)).toContain('to: "Sidekick-1"');
		expect(delegate.at(-1)).not.toContain("escalate the hard parts");
		expect(escalate.at(-1)).toContain('to: "Sidekick-9"');
		expect(escalate.at(-1)).toContain("escalate the hard parts");
	});

	it("omits the sidekick policy when fusion is off", async () => {
		const rendered = await render({ fusionSidekick: false });
		expect(rendered).not.toContain("Sidekick (cost mode)");
	});

	it("omits the sidekick policy when the hub tool is unavailable", async () => {
		const rendered = await render({ fusionSidekick: true, toolNames: [] });
		expect(rendered).not.toContain("Sidekick (cost mode)");
	});
});
