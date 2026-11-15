import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAuthStorage } from "@pk-nerdsaver-ai/pi-ai/auth-broker/discover";
import { EDIT_MATRIX_CASES } from "./cases.ts";

const MATRIX_PROVIDERS = [
	{ provider: "google-antigravity", label: "google-antigravity:gemini-3.6-flash-high" },
	{ provider: "anthropic", label: "anthropic:claude-sonnet-4-5" },
	{ provider: "openai-codex", label: "openai-codex:gpt-5.3-codex" },
] as const;

function parseArgs(argv: string[]): {
	providerFilter?: string;
	caseFilter?: string;
	noCache: boolean;
} {
	let providerFilter: string | undefined;
	let caseFilter: string | undefined;
	let noCache = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--provider" && argv[i + 1]) providerFilter = argv[++i];
		else if (arg === "--case" && argv[i + 1]) caseFilter = argv[++i];
		else if (arg === "--no-cache") noCache = true;
	}
	return { providerFilter, caseFilter, noCache };
}

async function main(): Promise<void> {
	const { providerFilter, caseFilter, noCache } = parseArgs(process.argv.slice(2));
	const auth = await discoverAuthStorage();

	const enabledLabels: string[] = [];
	for (const entry of MATRIX_PROVIDERS) {
		if (providerFilter && entry.provider !== providerFilter) continue;
		const key = await auth.getApiKey(entry.provider);
		if (key) {
			enabledLabels.push(entry.label);
			console.log(`[preflight] ${entry.label}: credentials OK`);
		} else {
			console.log(`[preflight] ${entry.label}: SKIPPED (no credentials/OAuth token)`);
		}
	}

	if (enabledLabels.length === 0) {
		console.error("No matching providers have configured credentials. Aborting.");
		process.exit(1);
	}

	if (caseFilter && !EDIT_MATRIX_CASES.some(c => c.id === caseFilter)) {
		console.error(`Unknown --case "${caseFilter}". Available: ${EDIT_MATRIX_CASES.map(c => c.id).join(", ")}`);
		process.exit(1);
	}

	const dir = import.meta.dir;
	const outDir = path.join(dir, ".out");
	fs.mkdirSync(outDir, { recursive: true });
	const outPath = path.join(outDir, "results.json");

	const cmd = [
		"bunx",
		"promptfoo@latest",
		"eval",
		"-c",
		path.join(dir, "promptfooconfig.yaml"),
		"--filter-providers",
		enabledLabels.join("|"),
		"--output",
		outPath,
	];
	if (caseFilter) {
		cmd.push("--filter-pattern", caseFilter);
	}
	if (noCache) {
		cmd.push("--no-cache");
	}

	console.log(`[run] ${cmd.join(" ")}`);
	const proc = Bun.spawn(cmd, {
		cwd: path.resolve(dir, "../.."),
		env: { ...process.env, BUN_BIN: process.execPath },
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	});
	const code = await proc.exited;
	process.exit(code);
}

await main();
