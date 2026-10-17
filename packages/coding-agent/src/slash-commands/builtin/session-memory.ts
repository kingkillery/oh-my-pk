import { Markdown, Spacer } from "@pk-nerdsaver-ai/pi-tui";
import { getMarkdownTheme } from "../../modes/theme/theme";
import { readSessionMemory, sessionMemoryProject } from "../../session-memory/project";
import { SessionMemoryStore } from "../../session-memory/store";
import { commandConsumed, parseSubcommand } from "../helpers/parse";
import type { SlashCommandResult, SlashCommandRuntime, TuiSlashCommandRuntime } from "../types";

const USAGE =
	"/session-memory build | status | wake [offset] | search <words> | expand <id> [offset] | source <record-id> [byte-offset]";

export async function runSessionMemoryCommand(args: string, cwd: string): Promise<string> {
	const { verb, rest } = parseSubcommand(args);
	if (!verb || !["build", "status", "wake", "search", "expand", "source"].includes(verb)) return USAGE;
	const project = await sessionMemoryProject(cwd);
	if (verb === "build") {
		const store = await SessionMemoryStore.open(project.dbPath, project.root);
		try {
			const receipt = await store.build(project);
			return JSON.stringify(
				{ project: project.root, index: project.dbPath, ...receipt, ...store.status() },
				null,
				2,
			);
		} finally {
			store.close();
		}
	}
	const parts = rest.split(/\s+/);
	const offset = verb === "wake" ? Number(parts[0] || 0) : verb === "search" ? 0 : Number(parts[1] || 0);
	if (!Number.isSafeInteger(offset) || offset < 0) return USAGE;
	const value = verb === "search" ? rest : parts[0] || "";
	return JSON.stringify(await readSessionMemory(project, verb, value, offset, verb === "source" ? 8192 : 10), null, 2);
}

export async function handleSessionMemoryCommand(
	args: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	await runtime.output(await runSessionMemoryCommand(args, runtime.cwd));
	return commandConsumed();
}

export async function handleSessionMemoryCommandTui(args: string, runtime: TuiSlashCommandRuntime): Promise<void> {
	runtime.ctx.editor.setText("");
	runtime.ctx.showStatus("Reading session memory…");
	try {
		const output = await runSessionMemoryCommand(args, runtime.ctx.sessionManager.getCwd());
		runtime.ctx.present([
			new Spacer(1),
			new Markdown(`~~~json\n${output}\n~~~`, 1, 0, getMarkdownTheme()),
			new Spacer(1),
		]);
	} catch (error) {
		runtime.ctx.showError(error instanceof Error ? error.message : String(error));
	}
}
