import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isFsMissing } from "@pk-nerdsaver-ai/pi-utils";
import type { FsError } from "../src/fs-error";

/**
 * Regression: Bun's Windows file layer reports `EUNKNOWN` (not ENOENT) when
 * opening a path through a dangling symlink/junction. Callers that guarded on
 * `isEnoent` alone rethrew and crashed startup when a `plugins/node_modules`
 * entry outlived its link target (fixed across the plugin loaders).
 * `isFsMissing` treats any fs failure on a path that no longer resolves as
 * "missing", while still surfacing errors on paths that do exist.
 */

function fsError(code: string): FsError {
	const err = new Error(`${code} simulated`) as FsError;
	err.code = code;
	return err;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fs-error-test-"));
const existing = path.join(tmpRoot, "exists.txt");
fs.writeFileSync(existing, "x");
const missing = path.join(tmpRoot, "gone.txt");

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

describe("isFsMissing", () => {
	it("is true for ENOENT", () => {
		expect(isFsMissing(fsError("ENOENT"), existing)).toBe(true);
	});

	it("is true for ENOTDIR", () => {
		expect(isFsMissing(fsError("ENOTDIR"), existing)).toBe(true);
	});

	it("is true for EUNKNOWN when the path no longer resolves (dangling link)", () => {
		expect(isFsMissing(fsError("EUNKNOWN"), missing)).toBe(true);
	});

	it("is false for EUNKNOWN when the path still exists", () => {
		expect(isFsMissing(fsError("EUNKNOWN"), existing)).toBe(false);
	});

	it("is false for non-fs errors", () => {
		expect(isFsMissing(new SyntaxError("bad json"), missing)).toBe(false);
		expect(isFsMissing("nope", missing)).toBe(false);
	});

	it("is true for a real dangling symlink on this platform", () => {
		const link = path.join(tmpRoot, "dead-link");
		const target = path.join(tmpRoot, "no-such-target");
		try {
			fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
		} catch {
			return; // no symlink privilege — the synthetic cases above cover the logic
		}
		let caught: unknown;
		try {
			fs.readFileSync(link);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		expect(isFsMissing(caught, link)).toBe(true);
	});
});
