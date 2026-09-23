import { createInterface } from "node:readline/promises";
import { Settings } from "../src/config/settings";
import { launchInteractiveTerminal } from "../src/terminal/launch";

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
		const result = await launchInteractiveTerminal(
			{ command, cwd, title: argumentValue(args, "--title"), backend: settings.get("terminal.launchBackend") },
			{
				confirmFallback: process.stdin.isTTY
					? async reason => {
							const input = createInterface({ input: process.stdin, output: process.stdout });
							try {
								return (await input.question(`${reason}\nType YES to continue: `)).trim() === "YES";
							} finally {
								input.close();
							}
						}
					: undefined,
			},
		);
		process.stdout.write(`Launched in ${result.backend}${result.id ? ` (${result.id})` : ""}.\n`);
	} catch (error) {
		process.stderr.write(`Terminal launch failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
