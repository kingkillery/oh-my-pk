import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { sha256 } from "../src/session-memory/records";
import { SessionMemoryStore } from "../src/session-memory/store";

type Builder = Subprocess<"ignore", "pipe", "pipe">;
let directory: string;
let project: string;
let sessions: string;
let blobs: string;
let file: string;
let database: string;
let driver: string;
let reader: SessionMemoryStore;
let children: Builder[];

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "ompk-memory-lifecycle-"));
	project = path.join(directory, "project");
	sessions = path.join(directory, "sessions");
	blobs = path.join(directory, "blobs");
	file = path.join(sessions, "active.jsonl");
	database = path.join(directory, "archive.sqlite");
	driver = path.join(directory, "builder.ts");
	children = [];
	await Promise.all([fs.mkdir(project), fs.mkdir(sessions), fs.mkdir(blobs)]);
	const initial = await SessionMemoryStore.open(database, project);
	initial.close();
	reader = await SessionMemoryStore.open(database, project, true);
	await Bun.write(
		driver,
		[
			`import { SessionMemoryStore } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/session-memory/store.ts"))};`,
			"const [db,root,sessionsDir,blobsDir] = Bun.argv.slice(2);",
			"const store = await SessionMemoryStore.open(db,root);",
			"try { const result = await store.build({sessionsDir,blobsDir,roots:[root]});",
			"await Bun.write(Bun.stdout,JSON.stringify(result));",
			"if(result.warnings.length) process.exitCode=1;",
			"} finally { store.close(); }",
		].join("\n"),
	);
}, 30000);

afterEach(async () => {
	for (const child of children) if (child.exitCode === null) child.kill();
	await Promise.all(children.map(child => child.exited));
	reader.close();
	expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
	expect(path.basename(directory).startsWith("ompk-memory-lifecycle-")).toBe(true);
	await fs.rm(directory, { recursive: true, force: true });
}, 30000);

async function fixture(count: number): Promise<string> {
	const lines = [
		JSON.stringify({ type: "session", id: "lifecycle", cwd: project, timestamp: "2026-10-14T00:00:00Z" }),
	];
	for (let i = 0; i < count; i++)
		lines.push(
			JSON.stringify({
				type: "message",
				id: `entry${i}`,
				parentId: i ? `entry${i - 1}` : null,
				timestamp: "2026-10-14T00:00:00Z",
				message: {
					role: i % 2 ? "assistant" : "user",
					content: [{ type: "text", text: `recoverytoken evidence row ${i}` }],
				},
			}),
		);
	const raw = `${lines.join("\n")}\n`;
	await Bun.write(file, raw);
	return raw;
}

function spawnBuilder(): Builder {
	const child = Bun.spawn([process.execPath, driver, database, project, sessions, blobs], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	return child;
}

async function waitForBatch(child: Builder): Promise<void> {
	const db = new Database(database, { readonly: true });
	const count = db.query<{ n: number }, []>("SELECT count(*) n FROM records");
	try {
		const deadline = Date.now() + 30000;
		while ((count.get()?.n ?? 0) < 128) {
			if (child.exitCode !== null)
				throw new Error(
					`Builder exited before the first durable batch: ${await new Response(child.stderr).text()}`,
				);
			if (Date.now() > deadline) throw new Error("No durable import batch within 30 seconds.");
			await Bun.sleep(10);
		}
	} finally {
		count.finalize();
		db.close();
	}
}

async function complete(child: Builder): Promise<{ indexed: number; unstable: number; warnings: string[] }> {
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(stderr).toBe("");
	expect(code, stdout || stderr).toBe(0);
	const receipt = JSON.parse(stdout);
	expect(receipt.warnings).toEqual([]);
	return receipt;
}

describe("session memory real process lifecycle", () => {
	test("a killed partial import resumes without exposing incomplete sessions or changing its source", async () => {
		const original = await fixture(50000);
		const child = spawnBuilder();
		await waitForBatch(child);
		expect(reader.status().archives).toBe(0);
		expect(reader.search("recoverytoken")).toEqual([]);
		child.kill();
		await child.exited;
		expect(sha256(await Bun.file(file).bytes())).toBe(sha256(original));
		expect((await complete(spawnBuilder())).indexed).toBe(1);
		expect(reader.status()).toMatchObject({ archives: 1, records: 50001 });
		expect(await reader.verify()).toMatchObject({ archives: 1, records: 50001, faults: [] });
		const restored = await reader.restore(reader.wake()[0].id, path.join(directory, "restored"));
		expect(restored.sha).toBe(sha256(original));
		expect(sha256(await Bun.file(file).bytes())).toBe(sha256(original));
	}, 120000);

	test("two builders and a persistent reader converge on one complete revision", async () => {
		const original = await fixture(8000);
		const first = spawnBuilder();
		const second = spawnBuilder();
		await waitForBatch(first);
		const matches = reader.search("recoverytoken");
		expect(matches.length === 0 || matches.length === 10).toBe(true);
		await Promise.all([complete(first), complete(second)]);
		expect(reader.status()).toMatchObject({ archives: 1, records: 8001 });
		expect(reader.search("recoverytoken")).toHaveLength(10);
		expect(await reader.verify()).toMatchObject({ faults: [] });
		expect(sha256(await Bun.file(file).bytes())).toBe(sha256(original));
	}, 120000);

	test("an active append preserves the bounded snapshot and is captured on the next refresh", async () => {
		const original = await fixture(50000);
		const child = spawnBuilder();
		await waitForBatch(child);
		const appended = `${JSON.stringify({ type: "message", id: "late", parentId: "entry49999", message: { role: "user", content: "lateappendtoken" } })}\n`;
		await fs.appendFile(file, appended);
		expect((await complete(child)).unstable).toBe(1);
		const firstArchive = reader.wake()[0].id;
		expect((await reader.restore(firstArchive, path.join(directory, "before-append"))).sha).toBe(sha256(original));
		expect(reader.search("lateappendtoken")).toEqual([]);
		await complete(spawnBuilder());
		expect(reader.status()).toMatchObject({ archives: 2, records: 50002 });
		expect(reader.search("lateappendtoken")).toHaveLength(1);
		expect(await reader.verify()).toMatchObject({ faults: [] });
		expect(sha256(await Bun.file(file).bytes())).toBe(sha256(original + appended));
	}, 120000);
});
