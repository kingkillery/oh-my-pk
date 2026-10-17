import { sessionMemoryProject } from "../src/session-memory/project";
import { SessionMemoryStore } from "../src/session-memory/store";

const project = await sessionMemoryProject(Bun.argv[2] ?? process.cwd());
const store = await SessionMemoryStore.open(project.dbPath, project.root, true);
try {
	const queries = ["paste", "session lock", "btw", "colab", "thinking", "memory", "git", "checkpoint"];
	const timings: number[] = [];
	const firstPass: { query: string; ms: number; hits: number }[] = [];
	for (let i = 0; i < 80; i++) {
		const query = queries[i % queries.length];
		const start = performance.now();
		const hits = store.search(query).length;
		const ms = performance.now() - start;
		timings.push(ms);
		if (i < queries.length) firstPass.push({ query, ms, hits });
	}
	timings.sort((a, b) => a - b);
	await Bun.write(
		Bun.stdout,
		`${JSON.stringify({ queries: 80, p50Ms: timings[39], p95Ms: timings[75], maxMs: timings[79], firstPass }, null, 2)}\n`,
	);
} finally {
	store.close();
}
