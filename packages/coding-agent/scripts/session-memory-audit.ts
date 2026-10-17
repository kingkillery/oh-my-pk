import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sessionMemoryProject } from "../src/session-memory/project";

// Independent, read-only inventory: do not reuse the importer's folder prefilter.
const project = await sessionMemoryProject(Bun.argv[2] ?? process.cwd());
const normalize = (value: string) => {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
const roots = project.roots.map(normalize);
const archives = new Database(project.dbPath, { readonly: true });
const archived = new Map<string, Set<string>>();
for (const row of archives.query<{ path: string; sha: string }, []>("SELECT path,sha FROM archives").all()) {
	const key = normalize(row.path);
	const hashes = archived.get(key) ?? new Set<string>();
	hashes.add(row.sha);
	archived.set(key, hashes);
}
archives.close();

interface InventoryEntry {
	path: string;
	cwd: string;
	reason: string;
	bytes: number;
	sha?: string;
	archived?: boolean;
	stable?: boolean;
}
const entries: InventoryEntry[] = [];
const files = await Array.fromAsync(
	new Bun.Glob("**/*.jsonl").scan({ cwd: project.sessionsDir, onlyFiles: true, followSymlinks: false }),
);
let cursor = 0;
async function inspect(file: string): Promise<void> {
	const handle = await fs.open(file, "r");
	let header: Record<string, unknown> = {};
	try {
		const chunks: Buffer[] = [];
		let position = 0;
		while (position < 1024 * 1024) {
			const buffer = Buffer.alloc(4096);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
			if (!bytesRead) break;
			const end = buffer.subarray(0, bytesRead).indexOf(10);
			chunks.push(buffer.subarray(0, end < 0 ? bytesRead : end));
			position += bytesRead;
			if (end >= 0) break;
		}
		const parsed: unknown = JSON.parse(
			Buffer.concat(chunks)
				.toString("utf8")
				.replace(/^\uFEFF/, ""),
		);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) header = parsed as Record<string, unknown>;
	} catch {
		if (file.toLowerCase().includes(path.basename(project.root).toLowerCase()))
			entries.push({ path: file, cwd: "", reason: "invalid-header", bytes: (await handle.stat()).size });
		return;
	} finally {
		await handle.close();
	}
	if (header.type !== "session" || typeof header.cwd !== "string") {
		if (file.toLowerCase().includes(path.basename(project.root).toLowerCase()))
			entries.push({ path: file, cwd: "", reason: "invalid-header", bytes: (await fs.stat(file)).size });
		return;
	}
	const cwd = header.cwd;
	const normalized = normalize(cwd);
	const root = roots.find(value => normalized === value || normalized.startsWith(value + path.sep));
	let reason = "eligible";
	if (!root) {
		if (
			!file.toLowerCase().includes(path.basename(project.root).toLowerCase()) &&
			!cwd.toLowerCase().includes(path.basename(project.root).toLowerCase())
		)
			return;
		reason = "outside-registered-roots";
	} else {
		let parent = normalized;
		while (parent !== root) {
			if (
				await fs.stat(path.join(parent, ".git")).then(
					() => true,
					() => false,
				)
			) {
				reason = "nested-repository";
				break;
			}
			const next = path.dirname(parent);
			if (next === parent) break;
			parent = next;
		}
	}
	const before = await fs.stat(file);
	const entry: InventoryEntry = { path: file, cwd, reason, bytes: before.size };
	if (reason === "eligible") {
		const digest = new Bun.SHA256();
		for await (const chunk of Bun.file(file).stream()) digest.update(chunk);
		entry.sha = digest.digest("hex");
		const after = await fs.stat(file);
		entry.stable = before.size === after.size && before.mtimeMs === after.mtimeMs;
		entry.archived = archived.get(normalize(file))?.has(entry.sha) ?? false;
	}
	entries.push(entry);
}
await Promise.all(
	Array.from({ length: 8 }, async () => {
		while (cursor < files.length) {
			const file = path.join(project.sessionsDir, files[cursor++]);
			try {
				await inspect(file);
			} catch (error) {
				entries.push({ path: file, cwd: "", reason: `read-error: ${String(error)}`, bytes: 0 });
			}
		}
	}),
);
entries.sort((a, b) => a.path.localeCompare(b.path));
const eligible = entries.filter(entry => entry.reason === "eligible");
const missing = eligible.filter(entry => !entry.archived || !entry.stable);
const receipt = {
	project: project.root,
	scannedFiles: files.length,
	eligibleFiles: eligible.length,
	coveredFiles: eligible.filter(entry => entry.archived).length,
	uncovered: missing,
	exclusions: entries.filter(entry => entry.reason !== "eligible"),
	entries,
};
const serialized = JSON.stringify(receipt, null, 2);
if (Bun.argv[3]) await Bun.write(Bun.argv[3], `${serialized}\n`);
await Bun.write(Bun.stdout, `${JSON.stringify({ ...receipt, entries: undefined }, null, 2)}\n`);
if (missing.length || entries.some(entry => entry.reason.startsWith("read-error"))) process.exitCode = 1;
