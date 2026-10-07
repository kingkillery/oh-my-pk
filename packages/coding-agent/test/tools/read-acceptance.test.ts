import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { ReadTool } from "../../src/tools/read";
import { WriteTool } from "../../src/tools/write";

function session(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "fetch.enabled": true, "images.autoResize": false }),
	};
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => block.text ?? "").join("\n");
}

it("refreshes full URL reads while range continuations retain the last snapshot", async () => {
	using directory = TempDir.createSync("read-freshness-");
	let version = "first-deployment";
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			requests++;
			return new Response(version, { headers: { "Content-Type": "text/plain" } });
		},
	});
	try {
		const tool = new ReadTool(session(directory.path()));
		const url = `${server.url}source.txt`;
		expect(text(await tool.execute("first", { path: url }))).toContain("first-deployment");
		version = "second-deployment";
		expect(text(await tool.execute("continuation", { path: `${url}:1-20` }))).toContain("first-deployment");
		expect(requests).toBe(1);
		expect(text(await tool.execute("refresh", { path: url }))).toContain("second-deployment");
		expect(requests).toBe(2);
		expect(text(await tool.execute("new-continuation", { path: `${url}:1-20` }))).toContain("second-deployment");
	} finally {
		await server.stop(true);
	}
});

it("releases SQLite files immediately after successful and rejected reads and writes", async () => {
	using directory = TempDir.createSync("read-sqlite-release-");
	const db = new Database(":memory:");
	db.run("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES (1, 'sentinel')");
	const bytes = db.serialize();
	db.close(true);
	const file = path.join(directory.path(), "fixture.sqlite");
	const toolSession = session(directory.path());
	const read = new ReadTool(toolSession);
	for (const selector of ["", ":items", ":items:1", "?q=SELECT * FROM items", ":missing"]) {
		await Bun.write(file, bytes);
		if (selector === ":missing") await expect(read.execute("missing", { path: file + selector })).rejects.toThrow();
		else
			expect(text(await read.execute("read", { path: file + selector }))).toContain(selector ? "sentinel" : "items");
		await fs.unlink(file);
		expect(await Bun.file(file).exists()).toBe(false);
	}
	await Bun.write(file, bytes);
	await new WriteTool(toolSession).execute("write", { path: `${file}:items:1`, content: '{"name":"updated"}' });
	expect(text(await read.execute("updated", { path: `${file}:items:1` }))).toContain("updated");
	await fs.unlink(file);
	expect(await Bun.file(file).exists()).toBe(false);
	await Bun.write(file, bytes);
	await expect(
		new WriteTool(toolSession).execute("invalid-write", { path: `${file}:items:1`, content: '{"missing":1}' }),
	).rejects.toThrow();
	await fs.unlink(file);
	expect(await Bun.file(file).exists()).toBe(false);
});

it("keeps concurrent file and directory sentinels associated and advances beyond oversized lines", async () => {
	using directory = TempDir.createSync("read-attribution-");
	const read = new ReadTool(session(directory.path()));
	const paths = await Promise.all(
		Array.from({ length: 12 }, async (_, index) => {
			const folder = path.join(directory.path(), `request-${index}`);
			await fs.mkdir(folder);
			const file = path.join(folder, `sentinel-${index}.txt`);
			await Bun.write(file, `payload-${index}-end`);
			return { folder, file, index };
		}),
	);
	await Promise.all(
		paths.map(async ({ folder, file, index }) => {
			expect(text(await read.execute(`file-${index}`, { path: file }))).toContain(`payload-${index}-end`);
			expect(text(await read.execute(`folder-${index}`, { path: folder }))).toContain(`sentinel-${index}.txt`);
		}),
	);
	const longFile = path.join(directory.path(), "long.txt");
	await Bun.write(longFile, `${"x".repeat(100_000)}\nafter-long-line\n`);
	expect(text(await read.execute("after-long", { path: `${longFile}:2` }))).toContain("after-long-line");
	const binary = path.join(directory.path(), "unsupported.xlsb");
	await Bun.write(binary, new Uint8Array([80, 75, 3, 4, 0, 0, 1, 2]));
	expect(text(await read.execute("unsupported", { path: binary }))).toContain("Cannot read binary");
});
