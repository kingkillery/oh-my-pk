/** Explicit opt-in entry point: bun completion-pilot-cli.ts <pilot.json>. */
import { type CompletionPilotInput, runCompletionPilot } from "./completion-pilot";

const path = process.argv[2];
if (!path || process.argv.length !== 3) {
	process.stderr.write("Usage: bun completion-pilot-cli.ts <pilot.json>\n");
	process.exitCode = 2;
} else {
	try {
		const input = (await Bun.file(path).json()) as CompletionPilotInput;
		const result = await runCompletionPilot(input);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		process.exitCode = result.evaluation.outcome === "pass" ? 0 : 1;
	} catch (error) {
		process.stderr.write(`Pilot could not run: ${error instanceof Error ? error.message : "unknown error"}\n`);
		process.exitCode = 2;
	}
}
