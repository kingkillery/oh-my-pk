import { Settings } from "../src/config/settings";
import { loadSkills } from "../src/extensibility/skills";
import { launchInteractiveTerminal } from "../src/terminal/launch";
import { resolveTerminalLaunchSkill } from "../src/tools/terminal-skill";

function argumentValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const command = argumentValue(args, "--command");
if (!command?.trim()) {
	process.stderr.write(
		"Usage: bun run terminal:launch --command <shell-command> [--cwd <directory>] [--title <title>]\n",
	);
	process.exitCode = 2;
} else {
	const cwd = argumentValue(args, "--cwd") ?? process.cwd();
	const settings = await Settings.loadReadOnly({ cwd });
	try {
		const { skills } = await loadSkills({
			...settings.getGroup("skills"),
			disabledExtensions: settings.get("disabledExtensions"),
			cwd,
		});
		const skill = await resolveTerminalLaunchSkill(skills);
		const result = await launchInteractiveTerminal(
			{
				command,
				cwd,
				title: argumentValue(args, "--title"),
				backend: settings.get("terminal.launchBackend"),
			},
			{ skill },
		);
		process.stdout.write(
			`Launched in PK-Herdr${result.sessionName ? ` session ${result.sessionName}` : ""}, tab ${result.tabId} (pane ${result.paneId}).\n`,
		);
	} catch (error) {
		process.stderr.write(`Terminal launch failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
