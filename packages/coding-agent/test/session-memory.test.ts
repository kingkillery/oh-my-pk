import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readSessionMemory } from "../src/session-memory/project";
import { canonicalPath, inProject, sha256 } from "../src/session-memory/records";
import { SessionMemoryStore } from "../src/session-memory/store";
import { isToolCapabilityAllowed, resolveToolProfile } from "../src/tools/tool-profiles";

let directory: string;
let store: SessionMemoryStore;
let sessionsDir: string;
let blobsDir: string;
let projectRoot: string;
let filePath: string;
let dbPath: string;
const message = (id: string, role: string, text: string, parentId: string | null = null) =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-14T01:00:00Z",
		message: { role, content: [{ type: "text", text }] },
	});
const header = () =>
	JSON.stringify({ type: "session", version: 3, id: "pilot", cwd: projectRoot, timestamp: "2026-10-14T00:00:00Z" });
const build = () => store.build({ sessionsDir, blobsDir, roots: [projectRoot] });

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "ompk-session-memory-test-"));
	sessionsDir = path.join(directory, "sessions");
	blobsDir = path.join(directory, "blobs");
	projectRoot = path.join(directory, "oh-my-pk");
	await Promise.all([fs.mkdir(sessionsDir), fs.mkdir(blobsDir), fs.mkdir(projectRoot)]);
	filePath = path.join(sessionsDir, "pilot.jsonl");
	dbPath = path.join(directory, "memory.sqlite");
	store = await SessionMemoryStore.open(dbPath, projectRoot);
});
afterEach(async () => {
	store.close();
	await fs.rm(directory, { recursive: true, force: true });
});

describe("session memory preservation and retrieval", () => {
	test("restores all bytes including CRLF, Unicode, blank lines, invalid JSON and a partial tail", async () => {
		const raw =
			header() +
			"\r\n" +
			message("u", "user", "Fix paste: café 🦊") +
			"\r\n\nnot-json\n" +
			message("a", "assistant", "Paste repaired", "u") +
			"\n" +
			'{"unfinished":';
		await Bun.write(filePath, raw);
		const receipt = await build();
		expect(receipt.indexed).toBe(1);
		expect(receipt.warnings).toEqual([]);
		expect(await Bun.file(filePath).text()).toBe(raw);
		const archive = store.wake()[0];
		const restored = await store.restore(archive.id, path.join(directory, "restored"));
		expect(restored.sha).toBe(sha256(raw));
		expect(await Bun.file(path.join(directory, "restored", "session.jsonl")).bytes()).toEqual(
			new TextEncoder().encode(raw),
		);
		expect(store.status().records).toBe(6);
		await expect(store.restore(archive.id, path.join(directory, "restored"))).rejects.toThrow();
	});

	test("summary citations expand through segments to exact evidence and parent links", async () => {
		await Bun.write(
			filePath,
			[
				header(),
				message("u", "user", "Fix steering paste"),
				message("a", "assistant", "Validated multiline paste", "u"),
				"",
			].join("\n"),
		);
		await build();
		const archive = store.wake()[0];
		const summary = JSON.parse(archive.summary) as { recordId: string; text: string }[];
		expect(summary).toHaveLength(2);
		const expanded = store.expand(archive.id) as { children: { id: string }[] };
		const records = store.expand(expanded.children[0].id) as { children: { id: string }[] };
		expect(records.children.map(item => item.id)).toContain(summary[1].recordId);
		const source = store.source(summary[1].recordId);
		expect(Buffer.from(source.base64, "base64").toString()).toBe(
			`${message("a", "assistant", "Validated multiline paste", "u")}\n`,
		);
		expect(store.expand(summary[1].recordId)).toMatchObject({ parents: [{ id: summary[0].recordId }] });
		expect(store.expand(summary[0].recordId)).toMatchObject({ children: [{ id: summary[1].recordId }] });
		expect(store.search("multiline paste")).toHaveLength(1);
		expect(store.search('""" OR (')).toEqual([]);
		expect(store.search("*")).toEqual([]);
	});

	test("unchanged refresh skips work, appends reuse records, and rewritten sessions retain old evidence", async () => {
		const original = `${header()}\n${message("u", "user", "old evidence")}\n`;
		await Bun.write(filePath, original);
		await build();
		const oldId = store.wake()[0].id;
		expect((await build()).skipped).toBe(1);
		await fs.appendFile(filePath, `${message("a", "assistant", "new result", "u")}\n`);
		expect((await build()).records).toBe(1);
		await Bun.write(filePath, `${header()}\n${message("replacement", "user", "replacement evidence")}\n`);
		await build();
		expect(store.status().archives).toBe(3);
		await store.restore(oldId, path.join(directory, "old"));
		expect(await Bun.file(path.join(directory, "old", "session.jsonl")).text()).toBe(original);
		expect(store.search("old evidence")).toHaveLength(1);
	});

	test("large records page without losing UTF-8 bytes and index text beyond the preview", async () => {
		const raw = message("u", "user", `${"α".repeat(300000)} distinctivequartz`);
		await Bun.write(filePath, `${header()}\n${raw}`);
		await build();
		const hit = store.search("distinctivequartz")[0] as { id: string };
		const pages: Buffer[] = [];
		let offset = 0;
		do {
			const source = store.source(hit.id, offset, 65535);
			pages.push(Buffer.from(source.base64, "base64"));
			offset = source.nextOffset ?? -1;
		} while (offset >= 0);
		expect(Buffer.concat(pages).toString()).toBe(raw);
	});

	test("archives referenced image blobs and reports already missing dependencies", async () => {
		const binary = new Uint8Array([0, 255, 10, 42]);
		const hash = sha256(binary);
		await Bun.write(path.join(blobsDir, hash), binary);
		const missingBytes = new Uint8Array([7, 8, 9]);
		const missing = sha256(missingBytes);
		const raw = `${header()}\n${message("u", "user", `blob:sha256:${hash} blob:sha256:${missing}`)}\n`;
		const imageRecord = JSON.stringify({
			type: "message",
			id: "u",
			message: {
				role: "user",
				content: [
					{ type: "text", text: raw },
					{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" },
					{ type: "image", data: `blob:sha256:${missing}`, mimeType: "image/png" },
				],
			},
		});
		await Bun.write(filePath, `${header()}\n${imageRecord}\n`);
		await build();
		expect(store.status()).toMatchObject({ blobs: 1, missingBlobs: 1 });
		expect(Buffer.from(store.source(`b:${hash}`).base64, "base64")).toEqual(Buffer.from(binary));
		await fs.unlink(path.join(blobsDir, hash));
		const restored = await store.restore(store.wake()[0].id, path.join(directory, "restored"));
		expect(restored.missingBlobs).toEqual([missing]);
		expect(await Bun.file(path.join(directory, "restored", "blobs", hash)).bytes()).toEqual(binary);
		await Bun.write(path.join(blobsDir, missing), missingBytes);
		expect((await build()).skipped).toBe(1);
		expect(store.status().missingBlobs).toBe(0);
	});

	test("search retains custom and tool data while excluding encoded image payloads", async () => {
		const rows = [
			header(),
			JSON.stringify({ type: "custom", customType: "evidence", data: "customdatatoken" }),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "yield", arguments: { result: { data: "tooldatatoken" } } }],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "image", data: "encodedimagetoken" },
						{ mimeType: "IMAGE/PNG", data: "uppercaseimagetoken" },
					],
				},
			}),
		];
		await Bun.write(filePath, rows.join("\n"));
		await build();
		expect(store.search("customdatatoken")).toHaveLength(1);
		expect(store.search("tooldatatoken")).toHaveLength(1);
		expect(store.search("encodedimagetoken")).toEqual([]);
		expect(store.search("uppercaseimagetoken")).toEqual([]);
	});

	test("archives case-insensitive image MIME payloads without a type field", async () => {
		const bytes = new Uint8Array([12, 34, 56]);
		const hash = sha256(bytes);
		await Bun.write(path.join(blobsDir, hash), bytes);
		await Bun.write(
			filePath,
			[
				header(),
				JSON.stringify({
					type: "custom",
					data: { images: [{ mimeType: "IMAGE/PNG", data: `blob:sha256:${hash}` }] },
				}),
			].join("\n"),
		);
		await build();
		expect(store.status()).toMatchObject({ blobs: 1, missingBlobs: 0 });
		await fs.unlink(path.join(blobsDir, hash));
		const result = await store.restore(store.wake()[0].id, path.join(directory, "mime-restored"));
		expect(result.missingBlobs).toEqual([]);
		expect(await Bun.file(path.join(directory, "mime-restored", "blobs", hash)).bytes()).toEqual(bytes);
		expect((await store.verify()).faults).toEqual([]);
	});

	test("quoted blob examples do not create false missing dependencies", async () => {
		await Bun.write(filePath, `${header()}\n${message("u", "user", `blob:sha256:${"a".repeat(64)}`)}\n`);
		await build();
		expect(store.status()).toMatchObject({ blobs: 0, missingBlobs: 0 });
		expect((await store.restore(store.wake()[0].id, path.join(directory, "quoted"))).missingBlobs).toEqual([]);
	});

	test("scope excludes sibling projects and nested independent repositories", async () => {
		await Bun.write(filePath, `${header()}\n`);
		await Bun.write(
			path.join(sessionsDir, "other.jsonl"),
			`${JSON.stringify({ type: "session", cwd: `${projectRoot}-other` })}\n`,
		);
		const nested = path.join(projectRoot, "fixture");
		await fs.mkdir(nested);
		await fs.mkdir(path.join(nested, ".git"));
		await Bun.write(path.join(sessionsDir, "nested.jsonl"), `${JSON.stringify({ type: "session", cwd: nested })}\n`);
		expect(await build()).toMatchObject({ indexed: 1, excluded: 2 });
		expect(inProject(`${projectRoot}-other`, [projectRoot])).toBe(false);
		await expect(SessionMemoryStore.open(dbPath, directory, true)).rejects.toThrow("another repository");
		expect(canonicalPath(projectRoot)).toBe(canonicalPath(projectRoot + path.sep));
	});

	test("read-only retrieval opens no absent index and cancellation publishes no partial archive", async () => {
		const absent = path.join(directory, "absent.sqlite");
		expect(
			await readSessionMemory(
				{ root: projectRoot, roots: [projectRoot], dbPath: absent, sessionsDir, blobsDir },
				"status",
			),
		).toMatchObject({ status: "not-built" });
		expect(await Bun.file(absent).exists()).toBe(false);
		await Bun.write(filePath, `${header()}\n`);
		const signal = AbortSignal.abort();
		await expect(store.build({ sessionsDir, blobsDir, roots: [projectRoot], signal })).rejects.toThrow();
		expect(store.status().archives).toBe(0);
	});

	test("imports a fork in another project's folder using its actual session header", async () => {
		const forkDirectory = path.join(sessionsDir, "unrelated-project");
		await fs.mkdir(forkDirectory);
		await Bun.write(
			path.join(forkDirectory, "fork.jsonl"),
			`${header()}\n${message("u", "user", "misfiledforktoken")}\n`,
		);
		expect(await build()).toMatchObject({ indexed: 1, excluded: 0, warnings: [] });
		expect(store.search("misfiledforktoken")).toHaveLength(1);
	});

	test("integrity verification detects corrupted snapshots and restore refuses them", async () => {
		await Bun.write(filePath, `${header()}\n${message("u", "user", "integrity evidence")}\n`);
		await build();
		expect(await store.verify()).toMatchObject({ archives: 1, records: 2, faults: [] });
		const hit = store.search("integrity")[0] as { id: string };
		const db = new Database(dbPath);
		db.run("UPDATE records SET compressed=? WHERE id=?", [Bun.gzipSync(new TextEncoder().encode("changed")), hit.id]);
		db.close();
		expect((await store.verify()).faults).toContain(hit.id);
		expect(() => store.source(hit.id)).toThrow("corruption");
		await expect(store.restore(store.wake()[0].id, path.join(directory, "corrupted"))).rejects.toThrow("corruption");
	});

	test("real source commands and agent tool share the same scoped archive without API calls", async () => {
		const git = Bun.spawn(["git", "-c", "init.defaultBranch=main", "init", "--quiet", projectRoot], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await git.exited).toBe(0);
		await Bun.write(filePath, `${header()}\n${message("u", "user", "uniqueintegrationtoken exact evidence")}\n`);
		const commandModule = path.resolve(import.meta.dir, "../src/slash-commands/builtin/session-memory.ts");
		const toolModule = path.resolve(import.meta.dir, "../src/tools/session-memory.ts");
		const driver = path.join(directory, "integration.ts");
		await Bun.write(
			driver,
			[
				`import { runSessionMemoryCommand } from ${JSON.stringify(commandModule)};`,
				`import { SessionMemoryTool } from ${JSON.stringify(toolModule)};`,
				"const cwd = Bun.argv[2];",
				"const before = JSON.parse(await runSessionMemoryCommand('status', cwd));",
				"const built = JSON.parse(await runSessionMemoryCommand('build', cwd));",
				"const tool = new SessionMemoryTool({cwd});",
				"const found = await tool.execute('search', {action:'search',value:'uniqueintegrationtoken'});",
				"const parsed = JSON.parse(found.content[0].text);",
				"const evidence = await tool.execute('source', {action:'source',value:parsed.matches[0].id});",
				"await Bun.write(Bun.stdout, JSON.stringify({before,built,parsed,evidence}));",
			].join("\n"),
		);
		const env: Record<string, string | undefined> = { ...process.env, PI_CODING_AGENT_DIR: directory };
		delete env.OMP_PROFILE;
		delete env.PI_PROFILE;
		const child = Bun.spawn([process.execPath, driver, projectRoot], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(stderr).toBe("");
		expect(code).toBe(0);
		const receipt = JSON.parse(stdout);
		expect(receipt.before.status).toBe("not-built");
		expect(receipt.built.indexed).toBe(1);
		expect(receipt.parsed.matches).toHaveLength(1);
		const evidence = JSON.parse(receipt.evidence.content[0].text);
		expect(Buffer.from(evidence.base64, "base64").toString()).toBe(
			`${message("u", "user", "uniqueintegrationtoken exact evidence")}\n`,
		);
	}, 60000);

	test("deeply nested evidence remains searchable and recoverable", async () => {
		const raw = `{"type":"custom","payload":${'{"nested":'.repeat(2000)}"deepuniquetoken"${"}".repeat(2000)}}\n`;
		await Bun.write(filePath, `${header()}\n${raw}`);
		expect((await build()).warnings).toEqual([]);
		const hit = store.search("deepuniquetoken")[0] as { id: string };
		expect(Buffer.from(store.source(hit.id, 0, 65536).base64, "base64").toString()).toBe(raw);
	});

	test("session memory stays available as a read tool without widening explicit allowlists", () => {
		const capability = { source: "builtin" as const, name: "session_memory" };
		expect(isToolCapabilityAllowed(resolveToolProfile({ tier: "light", autonomy: "bound" }), capability)).toBe(true);
		expect(
			isToolCapabilityAllowed(resolveToolProfile({ tier: "light", autonomy: "bound", agentTools: [] }), capability),
		).toBe(false);
	});
});
