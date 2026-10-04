import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeContentAddressedFile } from "@pk-nerdsaver-ai/pi-coding-agent/utils/content-addressed-file";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

describe("writeContentAddressedFile", () => {
	let dir: TempDir | undefined;

	afterEach(() => {
		dir?.removeSync();
		dir = undefined;
	});

	it("creates missing parent directories and writes the content", async () => {
		dir = TempDir.createSync("@content-addressed-");
		const filePath = path.join(dir.path(), "nested", "deeper", "record.txt");
		await writeContentAddressedFile(filePath, "hello");
		expect(await Bun.file(filePath).text()).toBe("hello");
	});

	it("leaves an existing record untouched", async () => {
		dir = TempDir.createSync("@content-addressed-");
		const filePath = path.join(dir.path(), "record.txt");
		await Bun.write(filePath, "first");
		// The name is the content's address, so an existing file already holds
		// these bytes; it is never rewritten (and never truncated mid-read).
		await writeContentAddressedFile(filePath, "second");
		expect(await Bun.file(filePath).text()).toBe("first");
	});

	it("never exposes a partial file to concurrent readers", async () => {
		dir = TempDir.createSync("@content-addressed-");
		const content = "x".repeat(256 * 1024);
		for (let round = 0; round < 8; round++) {
			const filePath = path.join(dir.path(), `record-${round}.txt`);
			const observed: number[] = [];
			const reads = Array.from({ length: 8 }, async () => {
				for (let attempt = 0; attempt < 20; attempt++) {
					const file = Bun.file(filePath);
					if (await file.exists()) observed.push((await file.text()).length);
					await Bun.sleep(0);
				}
			});
			const writes = Array.from({ length: 4 }, () => writeContentAddressedFile(filePath, content));
			await Promise.all([...writes, ...reads]);
			for (const length of observed) expect(length).toBe(content.length);
			expect(await Bun.file(filePath).text()).toBe(content);
		}
		// No temp files are left behind once the writers settle.
		expect((await fs.readdir(dir.path())).filter(name => name.endsWith(".tmp"))).toEqual([]);
	}, 20_000);
});
