import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { loadSkills, type Skill } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/skills";
import { buildSystemPrompt } from "@pk-nerdsaver-ai/pi-coding-agent/system-prompt";
import {
	launchInteractiveTerminal,
	type TerminalLaunchDependencies,
	type TerminalLaunchRequest,
} from "@pk-nerdsaver-ai/pi-coding-agent/terminal/launch";
import { createTools, type ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { createTerminalLaunchTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/terminal-launch";

const skillContent =
	"---\nname: pk-herdr\ndescription: Scoped terminal operations\n---\nUse returned IDs and close only owned resources.\n";
let skillRoot: string;
let skill: Skill;
beforeEach(async () => {
	skillRoot = await mkdtemp(join(tmpdir(), "ompk-herdr-tool-"));
	skill = {
		name: "pk-herdr",
		description: "Scoped terminal operations",
		baseDir: skillRoot,
		filePath: join(skillRoot, "SKILL.md"),
		source: "test",
	};
	await Bun.write(skill.filePath, skillContent);
});
afterEach(async () => {
	await rm(skillRoot, { recursive: true, force: true });
});
function sessionWithSkill(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: process.cwd(),
		settings: Settings.isolated(),
		hasUI: false,
		skills: [skill],
		...overrides,
	} as ToolSession;
}

const launched = {
	backend: "pk-herdr" as const,
	id: "w1:p2",
	paneId: "w1:p2",
	tabId: "w1:t2",
	workspaceId: "w1",
};

it("requires PK-Herdr by default and migrates legacy backend preferences", () => {
	expect(Settings.isolated().get("terminal.launchBackend")).toBe("pk-herdr");
	for (const backend of ["managed", "system"]) {
		const settings = Settings.isolated({ "terminal.launchBackend": backend, "terminal.showImages": false });
		expect(settings.get("terminal.launchBackend")).toBe("pk-herdr");
		expect(settings.get("terminal.showImages")).toBe(false);
	}
});

it("migrates persisted user and overlay preferences without rewriting read-only configuration", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "ompk-herdr-settings-"));
	try {
		const configPath = join(cwd, "config.yml");
		const overlayPath = join(cwd, "overlay.yml");
		const config = JSON.stringify({ terminal: { launchBackend: "system", showImages: false } });
		const overlay = JSON.stringify({ "terminal.launchBackend": "managed" });
		await Bun.write(configPath, config);
		await Bun.write(overlayPath, overlay);
		const settings = await Settings.loadReadOnly({ cwd, agentDir: cwd, configFiles: [overlayPath] });
		expect(settings.get("terminal.launchBackend")).toBe("pk-herdr");
		expect(settings.getGlobal("terminal.launchBackend")).toBe("pk-herdr");
		expect(settings.get("terminal.showImages")).toBe(false);
		expect(await Bun.file(configPath).text()).toBe(config);
		expect(await Bun.file(overlayPath).text()).toBe(overlay);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

it("rejects runtime attempts to restore a non-Herdr backend", () => {
	const settings = Settings.isolated();
	const invalidBackend = "system" as "pk-herdr";
	expect(() => settings.set("terminal.launchBackend", invalidBackend)).toThrow("PK-Herdr");
	expect(() => settings.override("terminal.launchBackend", invalidBackend)).toThrow("PK-Herdr");
	expect(settings.get("terminal.launchBackend")).toBe("pk-herdr");
});

it("reports a PK-Herdr tab and pane without offering a fallback", async () => {
	const session = sessionWithSkill();
	const launch = vi.fn(async (request: TerminalLaunchRequest) => {
		expect(request.backend).toBe("pk-herdr");
		return launched;
	});
	const result = await (await createTerminalLaunchTool(session, launch)).execute("call", { command: "Get-Date" });
	expect(result.content).toEqual([{ type: "text", text: "Launched in PK-Herdr tab w1:t2 (pane w1:p2)." }]);
	expect(result.details).toEqual({ ok: true, ...launched });
	expect(launch).toHaveBeenCalledTimes(1);
});

it("reports the exact session scope for an outside-Herdr launch", async () => {
	const session = sessionWithSkill();
	const launch = async () => ({ ...launched, sessionName: "ompk-terminal-job" });
	const result = await (await createTerminalLaunchTool(session, launch)).execute("call", { command: "Get-Date" });
	expect(result.details).toEqual({ ok: true, ...launched, sessionName: "ompk-terminal-job" });
	expect(result.content).toEqual([
		{
			type: "text",
			text: "Launched in PK-Herdr session ompk-terminal-job, workspace w1, tab w1:t2 (pane w1:p2). Scope control commands to --session ompk-terminal-job; stop only this owned session when work finishes.",
		},
	]);
});

it("reports Herdr failure rather than opening another terminal", async () => {
	const session = sessionWithSkill({ hasUI: true });
	const launch = vi.fn(async () => {
		throw new Error("PK-Herdr is unavailable; start the owned session inside a managed pane.");
	});
	const result = await (await createTerminalLaunchTool(session, launch)).execute("call", { command: "Get-Date" });
	expect(result.isError).toBe(true);
	expect(result.details).toEqual({ ok: false });
	expect(result.content).toEqual([
		{
			type: "text",
			text: "Terminal launch failed: PK-Herdr is unavailable; start the owned session inside a managed pane.",
		},
	]);
	expect(launch).toHaveBeenCalledTimes(1);
});

it("does not invoke the launcher for an already cancelled tool call", async () => {
	const session = sessionWithSkill();
	const controller = new AbortController();
	controller.abort();
	const launch = vi.fn(async () => launched);
	const result = await (await createTerminalLaunchTool(session, launch)).execute(
		"call",
		{ command: "Get-Date" },
		controller.signal,
	);
	expect(result.isError).toBe(true);
	expect(launch).not.toHaveBeenCalled();
});

it("keeps the launch tool restricted to the main agent", async () => {
	const session = sessionWithSkill({ taskDepth: 0 });
	const available = await createTools(session, ["terminal_launch"]);
	expect(available.some(tool => tool.name === "terminal_launch")).toBe(true);
	const child = await createTools({ ...session, taskDepth: 1 }, ["terminal_launch"]);
	expect(child.some(tool => tool.name === "terminal_launch")).toBe(false);
});

it("exposes the selected installed skill instructions before invocation", async () => {
	const launch = vi.fn(async (_request: TerminalLaunchRequest, dependencies: { skill: { content: string } }) => {
		expect(dependencies.skill.content).toBe(skillContent);
		return launched;
	});
	const tool = await createTerminalLaunchTool(sessionWithSkill(), launch);
	expect(tool.description).toContain(skillContent);
	expect(tool.description).toContain(skill.filePath);
	expect(launch).not.toHaveBeenCalled();
	await tool.execute("call", { command: "Get-Date" });
	expect(launch).toHaveBeenCalledTimes(1);
});

it("exposes the canonical skill discovered from a configured root", async () => {
	const root = join(skillRoot, "configured");
	const filePath = join(root, "pk-herdr", "SKILL.md");
	await Bun.write(filePath, skillContent);
	const { skills } = await loadSkills({
		cwd: process.cwd(),
		enableBuiltinSkills: false,
		enablePiUser: false,
		enablePiProject: false,
		enableAgentsUser: false,
		enableAgentsProject: false,
		enableClaudeUser: false,
		enableClaudeProject: false,
		enableCodexUser: false,
		customDirectories: [root],
		environmentsCloudRoot: null,
	});
	const tool = await createTerminalLaunchTool(sessionWithSkill({ skills }));
	expect(tool.description).toContain(skillContent);
	expect(tool.description).toContain(filePath);
});

it("rejects changed installed instructions through the real launcher without spawning", async () => {
	const sideEffects: string[] = [];
	const launch = (request: TerminalLaunchRequest, dependencies: TerminalLaunchDependencies) =>
		launchInteractiveTerminal(request, {
			...dependencies,
			startServer: async () => {
				sideEffects.push("server");
				throw new Error("Unexpected server startup");
			},
			run: async () => {
				sideEffects.push("command");
				throw new Error("Unexpected Herdr command");
			},
		});
	const tool = await createTerminalLaunchTool(sessionWithSkill(), launch);
	await Bun.write(skill.filePath, `${skillContent}\nChanged after tool construction.\n`);
	const result = await tool.execute("call", { command: "Get-Date" });
	expect(result.isError).toBe(true);
	expect(result.content.find(content => content.type === "text")?.text).toContain("installed instructions changed");
	expect(sideEffects).toEqual([]);
});

it("fails closed without an exact installed pk-herdr skill", async () => {
	for (const skills of [[], [{ ...skill, name: "herdr" }], [{ ...skill, embeddedContent: skillContent }]]) {
		const launch = vi.fn(async () => launched);
		const tool = await createTerminalLaunchTool(sessionWithSkill({ skills }), launch);
		const result = await tool.execute("call", { command: "Get-Date" });
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Terminal launch failed: Interactive terminals require the installed pk-herdr skill; resolve skill://pk-herdr before launching.",
			},
		]);
		expect(launch).not.toHaveBeenCalled();
	}
});

it("rejects a skill disabled after tool construction without invoking the launcher", async () => {
	const session = sessionWithSkill();
	const launch = vi.fn(async () => launched);
	const tool = await createTerminalLaunchTool(session, launch);
	session.skills = [];
	const result = await tool.execute("call", { command: "Get-Date" });
	expect(result.isError).toBe(true);
	expect(launch).not.toHaveBeenCalled();
});

it("requires the PK-Herdr skill for terminal control regardless of prompt mode", async () => {
	for (const managedTerminalLaunches of [true, false]) {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: process.cwd(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["terminal_launch", "read", "bash"],
			workspaceTree: { rootPath: process.cwd(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			activeRepoContext: null,
			managedTerminalLaunches,
		});
		const rendered = systemPrompt.join("\n");
		expect(rendered).toContain("skill://pk-herdr");
		expect(rendered).toContain("pk-herdr/SKILL.md");
		expect(rendered).toContain("stop and report the missing skill");
		expect(rendered).toContain("terminal_launch");
		expect(rendered).toContain("Never fall back to psmux");
		expect(rendered).toContain("--session-auto-close-after 4h");
	}
});
