/** Explicit opt-in entry point: bun completion-pilot-cli.ts [--allow-dirty-tree] <pilot.json>. */
import { type CompletionPilotInput, runCompletionPilot } from "./completion-pilot";

const rawArgs = process.argv.slice(2);
const allowDirtyTreeFlag = rawArgs.includes("--allow-dirty-tree");
const positional = rawArgs.filter(arg => arg !== "--allow-dirty-tree");
const path = positional[0];
if (!path || positional.length !== 1) {
	process.stderr.write("Usage: bun completion-pilot-cli.ts [--allow-dirty-tree] <pilot.json>\n");
	process.exitCode = 2;
} else {
	try {
		const loaded = (await Bun.file(path).json()) as CompletionPilotInput;
		const input: CompletionPilotInput = allowDirtyTreeFlag ? { ...loaded, allowDirtyTree: true } : loaded;
		const result = await runCompletionPilot(input);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		process.exitCode = result.evaluation.outcome === "pass" ? 0 : 1;
	} catch (error) {
		process.stderr.write(`Pilot could not run: ${error instanceof Error ? error.message : "unknown error"}\n`);
		process.exitCode = 2;
	}
}
