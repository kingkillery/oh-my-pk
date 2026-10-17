import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionMemoryProject } from "../src/session-memory/project";
import { sha256 } from "../src/session-memory/records";
import { SessionMemoryStore } from "../src/session-memory/store";

// Corpus acceptance receipt; never prints session contents.
const project = await sessionMemoryProject(Bun.argv[2] ?? process.cwd());
const store = await SessionMemoryStore.open(project.dbPath, project.root, true);
const timings: number[] = [];
try {
	const verification = await store.verify();
	const queries = ["paste", "session lock", "btw", "colab", "thinking", "memory", "git", "checkpoint"];
	let hits = 0;
	for (let i = 0; i < 80; i++) {
		const start = performance.now();
		hits += store.search(queries[i % queries.length]).length;
		timings.push(performance.now() - start);
	}
	timings.sort((a, b) => a - b);
	const archive = store.wake(1)[0];
	let roundTrip: unknown = null;
	if (archive) {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ompk-session-memory-pilot-"));
		try {
			const restored = await store.restore(archive.id, path.join(directory, "restored"));
			const restoredHash = sha256(await Bun.file(path.join(directory, "restored", "session.jsonl")).bytes());
			const original = Bun.file(archive.path);
			const originalHash = (await original.exists()) ? sha256(await original.bytes()) : null;
			roundTrip = {
				archiveId: archive.id,
				bytes: restored.bytes,
				hashVerified: restoredHash === archive.sha,
				originalStillMatches: originalHash === archive.sha,
				missingBlobs: restored.missingBlobs.length,
			};
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	}
	await Bun.write(
		Bun.stdout,
		`${JSON.stringify(
			{
				project: project.root,
				index: project.dbPath,
				...store.status(),
				verification,
				roundTrip,
				search: { queries: timings.length, hits, p50Ms: timings[39], p95Ms: timings[75], maxMs: timings[79] },
			},
			null,
			2,
		)}\n`,
	);
	if (verification.faults.length || verification.missingBlobs || !archive) process.exitCode = 1;
} finally {
	store.close();
}
