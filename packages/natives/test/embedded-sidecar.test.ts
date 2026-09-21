import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractEmbeddedAddonArchive } from "../native/loader-state.js";

/**
 * Contract for the embedded sidecar payload — the `ompk-collector` executable
 * that rides inside `embedded-addons.<platform>.tar.gz` alongside the N-API
 * addon, and an `EmbeddedAddon.files`-shaped descriptor so `loadNative()` can
 * stage it on first launch.
 *
 * These assertions pin the extraction loop's observable behavior, because the
 * sidecar shares it with the addon: staged bytes must survive a round trip,
 * re-extraction must be size-idempotent (the cache path re-runs on every
 * start), and a mismatched descriptor must fail loudly instead of writing
 * truncated bytes that later fail as a corrupt executable.
 */

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a gzip'd tar holding one regular-file entry. */
async function writeArchive(name: string, content: Buffer): Promise<string> {
	const archivePath = path.join(tmpDir, `${name}.tar.gz`);
	await Bun.write(archivePath, await new Bun.Archive({ [name]: content }, { compress: "gzip", level: 9 }).bytes());
	return archivePath;
}

const sidecarName = process.platform === "win32" ? "ompk-collector.exe" : "ompk-collector";

describe("embedded sidecar extraction", () => {
	it("stages the sidecar next to the addon and is size-idempotent", async () => {
		const content = Buffer.from("collector-binary-bytes");
		const archivePath = await writeArchive(sidecarName, content);
		const targetDir = path.join(tmpDir, "natives", "9.9.9");
		fs.mkdirSync(targetDir, { recursive: true });
		const files = [{ filename: sidecarName, size: content.byteLength }];

		const written = extractEmbeddedAddonArchive({ archivePath, files, targetDir });
		expect(written).toEqual([path.join(targetDir, sidecarName)]);
		expect(fs.readFileSync(path.join(targetDir, sidecarName))).toEqual(content);

		// The per-version cache re-runs extraction on every launch — an
		// unchanged file must not be rewritten.
		expect(extractEmbeddedAddonArchive({ archivePath, files, targetDir })).toEqual([]);
	});

	it("rewrites when the staged file size no longer matches", async () => {
		const content = Buffer.from("collector-binary-bytes");
		const archivePath = await writeArchive(sidecarName, content);
		const targetDir = path.join(tmpDir, "natives", "9.9.9");
		fs.mkdirSync(targetDir, { recursive: true });
		fs.writeFileSync(path.join(targetDir, sidecarName), "stale");

		const written = extractEmbeddedAddonArchive({
			archivePath,
			files: [{ filename: sidecarName, size: content.byteLength }],
			targetDir,
		});
		expect(written).toEqual([path.join(targetDir, sidecarName)]);
		expect(fs.readFileSync(path.join(targetDir, sidecarName))).toEqual(content);
	});

	it("rejects a size mismatch instead of writing truncated bytes", async () => {
		const content = Buffer.from("collector-binary-bytes");
		const archivePath = await writeArchive(sidecarName, content);

		expect(() =>
			extractEmbeddedAddonArchive({
				archivePath,
				files: [{ filename: sidecarName, size: content.byteLength + 1 }],
				targetDir: path.join(tmpDir, "out"),
			}),
		).toThrow(/size mismatch/);
	});

	it("rejects an archive entry that escapes the target directory", async () => {
		const archivePath = await writeArchive("..\\evil.exe", Buffer.from("nope"));

		expect(() =>
			extractEmbeddedAddonArchive({
				archivePath,
				files: [{ filename: "..\\evil.exe", size: 4 }],
				targetDir: path.join(tmpDir, "out"),
			}),
		).toThrow(/Unsafe embedded addon/);
	});
});
