import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Write a content-addressed file once, atomically.
 *
 * The caller names the file after a digest of `content`, so an existing file
 * already holds these bytes and is left alone. A new file is written to a
 * unique temp name and renamed into place, so a concurrent reader (another
 * request, or another process) never observes a truncated or partial file.
 */
export async function writeContentAddressedFile(filePath: string, content: string): Promise<void> {
	if (await Bun.file(filePath).exists()) return;
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}-${crypto.randomUUID()}.tmp`;
	await Bun.write(tmpPath, content);
	try {
		await fs.rename(tmpPath, filePath);
	} catch (error) {
		await fs.rm(tmpPath, { force: true });
		// Another writer may have placed the same content first (Windows refuses
		// to rename onto an existing file); that is the outcome we wanted.
		if (await Bun.file(filePath).exists()) return;
		throw error;
	}
}
