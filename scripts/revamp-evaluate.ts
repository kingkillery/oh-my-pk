/**
 * Reproducible offline-first revamp evaluation harness (A16).
 *
 * Usage: bun scripts/revamp-evaluate.ts --manifest <absolute-json> --output <absolute-dir>
 *
 * The manifest pins candidate/baseline labels, deterministic task files,
 * seeds, limits, and acceptance policy. This harness executes each listed
 * `bun test` file for the candidate checkout and writes a JSON report with
 * accepted outcome counts, totals, and conflicts. Deterministic fixtures
 * run without paid providers. Promotion requires zero deterministic
 * invariant regressions plus a strictly improved efficiency metric —
 * decided by the operator from the report, never by this script.
 */

import { parseEvaluateManifest, type RevampEvaluateReport } from "../packages/coding-agent/src/task/evaluate-manifest";

function usage(): string {
	return "Usage: bun scripts/revamp-evaluate.ts --manifest <absolute-json> --output <absolute-dir>";
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const manifestIndex = args.indexOf("--manifest");
	const outputIndex = args.indexOf("--output");
	if (manifestIndex === -1 || outputIndex === -1 || !args[manifestIndex + 1] || !args[outputIndex + 1]) {
		console.error(usage());
		process.exit(2);
	}
	const manifestPath = args[manifestIndex + 1];
	const outputDir = args[outputIndex + 1];
	if (!manifestPath.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(manifestPath)) {
		console.error("Manifest path must be absolute.");
		process.exit(2);
	}
	const raw = await Bun.file(manifestPath).json();
	const manifest = parseEvaluateManifest(raw);

	const taskResults: { task: string; pass: boolean; detail: string }[] = [];
	for (const task of manifest.tasks) {
		for (const seed of manifest.seeds) {
			const proc = Bun.spawn(["bun", "test", task], {
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, REVAMP_EVAL_SEED: String(seed) },
			});
			const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
			taskResults.push({
				task: `${task}#seed-${seed}`,
				pass: exitCode === 0,
				detail: exitCode === 0 ? stdout.slice(-2000) : stderr.slice(-2000),
			});
		}
	}
	const report: RevampEvaluateReport = {
		candidateLabel: manifest.candidateLabel,
		baselineLabel: manifest.baselineLabel,
		taskResults,
		acceptedCount: taskResults.filter(r => r.pass).length,
		totalCount: taskResults.length,
		seedCount: manifest.seeds.length,
	};
	await Bun.$`mkdir -p ${outputDir}`;
	await Bun.write(`${outputDir}/revamp-evaluate-report.json`, JSON.stringify(report, null, 2));
	console.log(
		`Evaluated ${report.acceptedCount}/${report.totalCount} accepted. Report: ${outputDir}/revamp-evaluate-report.json`,
	);
	if (report.acceptedCount !== report.totalCount) process.exit(1);
}

if (import.meta.main) {
	await main();
}
