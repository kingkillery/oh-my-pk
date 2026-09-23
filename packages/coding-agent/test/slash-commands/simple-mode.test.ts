import { expect, test, vi } from "bun:test";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";

test("/simple changes active tools and restores the full mode without losing other tools", async () => {
	const settings = Settings.isolated();
	let activeTools = ["read", "task", "irc", "eval"];
	const setActiveToolsByName = vi.fn(async (names: string[]) => {
		activeTools = names;
	});
	const refreshBaseSystemPrompt = vi.fn(async () => {});
	const statuses: string[] = [];
	const ctx = {
		settings,
		session: { getActiveToolNames: () => activeTools, setActiveToolsByName, refreshBaseSystemPrompt },
		sessionManager: { getCwd: () => process.cwd() },
		showStatus: (text: string) => statuses.push(text),
		editor: { setText: vi.fn() },
	} as unknown as InteractiveModeContext;
	const runtime = { ctx };

	expect(await executeBuiltinSlashCommand("/simple 0", runtime)).toBe(true);
	expect(settings.get("task.simpleMode")).toBe(true);
	expect(settings.get("task.simpleMaxAgents")).toBe(0);
	expect(activeTools).toEqual(["read", "eval"]);
	expect(statuses.at(-1)).toContain("subagents off");

	expect(await executeBuiltinSlashCommand("/simple 2", runtime)).toBe(true);
	expect(settings.get("task.simpleMaxAgents")).toBe(2);
	expect(activeTools).toEqual(["read", "eval", "task"]);

	expect(await executeBuiltinSlashCommand("/simple off", runtime)).toBe(true);
	expect(settings.get("task.simpleMode")).toBe(false);
	expect(activeTools).toContain("eval");
	expect(activeTools).toContain("task");
	expect(activeTools).toContain("irc");
	expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(3);

	settings.override("task.simpleMode", false);
	settings.override("task.simpleMaxAgents", 0);
	expect(await executeBuiltinSlashCommand("/simple 2", runtime)).toBe(true);
	expect(settings.get("task.simpleMode")).toBe(true);
	expect(settings.get("task.simpleMaxAgents")).toBe(2);
	expect(activeTools).not.toContain("irc");
});

test("/simple never activates tools excluded from this session", async () => {
	const settings = Settings.isolated();
	let activeTools = ["read", "eval"];
	const ctx = {
		settings,
		session: {
			getActiveToolNames: () => activeTools,
			setActiveToolsByName: async (names: string[]) => {
				activeTools = names;
			},
			refreshBaseSystemPrompt: async () => {},
		},
		sessionManager: { getCwd: () => process.cwd() },
		showStatus: vi.fn(),
		editor: { setText: vi.fn() },
	} as unknown as InteractiveModeContext;
	const runtime = { ctx };
	await executeBuiltinSlashCommand("/simple 2", runtime);
	expect(activeTools).toEqual(["read", "eval"]);
	await executeBuiltinSlashCommand("/simple off", runtime);
	expect(activeTools).toEqual(["read", "eval"]);
});
