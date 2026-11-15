#!/usr/bin/env bun

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");

type BuildManifest = {
	version: string;
	buildLabel: string;
	builtAtUtc: string;
	gitCommit: string;
	sourceIndexHash: string;
	sourcePaths: string[];
};

async function gitOutput(args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
	return stdout;
}

async function sourceIndexHash(pathspec: string[]): Promise<string> {
	const gitPathspec = pathspec.map(entry => (entry.endsWith("/src") ? `${entry}/**` : entry));
	const raw = await gitOutput(["ls-files", "-s", "-z", "--", ...gitPathspec]);
	const records = await Promise.all(
		raw
			.split("\0")
			.filter(Boolean)
			.map(async record => {
				const [meta, filePath] = record.split("\t");
				const [mode] = meta.split(" ");
				return {
					filePath,
					mode,
					bytes: new Uint8Array(await Bun.file(path.join(repoRoot, filePath)).arrayBuffer()),
				};
			}),
	);
	records.sort((left, right) => (left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0));
	const hash = createHash("sha256");
	for (const record of records) hash.update(`${record.mode} ${record.filePath}\n`).update(record.bytes);
	return hash.digest("hex");
}

async function main(): Promise<void> {
	const manifestPath = path.join(packageDir, "build-manifest.json");
	if (!fs.existsSync(manifestPath)) {
		console.log("dist manifest missing: run bun run build");
		process.exit(1);
	}

	const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf-8")) as BuildManifest;
	const hash = await sourceIndexHash(manifest.sourcePaths);

	if (hash !== manifest.sourceIndexHash) {
		console.log("dist binaries are stale: rebuild in the same commit as the final source edit");
		console.log(`manifest build: ${manifest.gitCommit} (${manifest.builtAtUtc})`);
		try {
			const gitPathspec = manifest.sourcePaths.map(entry => (entry.endsWith("/src") ? `${entry}/**` : entry));
			const diff = (await gitOutput(["diff", "--name-only", manifest.gitCommit, "--", ...gitPathspec])).trim();
			if (diff) console.log(diff);
		} catch {
			console.log("git diff unavailable; compare the manifest build against HEAD manually");
		}
		process.exit(1);
	}

	const docsIndexPath = path.join(packageDir, "src", "internal-urls", "docs-index.generated.txt");
	const docsStat = await fs.promises.stat(docsIndexPath);
	if (docsStat.size > 4096) {
		console.log("generated docs index committed as build output: run bun run gen:docs:reset");
		process.exit(1);
	}

	console.log(`dist manifest fresh: ${hash}`);
	process.exit(0);
}

await main();
