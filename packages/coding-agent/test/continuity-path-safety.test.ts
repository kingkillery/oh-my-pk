import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assertWithinRoot, assertWorkstreamId, resolveWithinRoot } from "../src/continuity/store";
import { parseVaultUrl } from "../src/internal-urls/vault-protocol";

let temporary: string;
let repo: string;
let root: string;

beforeEach(async () => {
	temporary = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-storage-"));
	repo = path.join(temporary, "project");
	root = repo;
	await fs.mkdir(repo);
});

afterEach(async () => {
	await fs.rm(temporary, { recursive: true, force: true });
});

describe("continuity path safety", () => {
	test("accepts a direct child and rejects the root itself", () => {
		expect(() => assertWithinRoot(root, path.join(root, "note.md"))).not.toThrow();
		expect(() => assertWithinRoot(root, root)).toThrow(/Refusing to use/);
	});

	test("rejects a sibling directory whose name shares the root prefix", () => {
		const target = path.join(path.dirname(root), `${path.basename(root)}-sibling`, "x.md");
		expect(() => assertWithinRoot(root, target)).toThrow(/Refusing to use/);
	});

	test("rejects a parent traversal", () => {
		expect(() => assertWithinRoot(root, path.join(root, "..", "escape.md"))).toThrow(/Refusing to use/);
	});

	test("rejects a junction that resolves outside the root", async () => {
		const outside = path.join(temporary, "outside");
		await fs.mkdir(outside);
		let linked = false;
		try {
			await fs.symlink(outside, path.join(root, "link"), "junction");
			linked = true;
		} catch (error) {
			expect(
				(error as NodeJS.ErrnoException).code,
				"rejects a junction that resolves outside the root (link creation denied on this host)",
			).toBe("EPERM");
		}
		if (linked) {
			await expect(resolveWithinRoot(root, path.join(root, "link", "escape.md"))).rejects.toThrow(/Refusing to use/);
		}
	});

	test("rejects workstream ids that are not a portable single segment", () => {
		for (const value of ["con", "nul.txt", "trailing.", "a/b", "a\\b", "..", "-leading"]) {
			expect(() => assertWorkstreamId(value)).toThrow(/Invalid workstream id/);
		}
		expect(() => assertWorkstreamId("portable.notebook-2")).not.toThrow();
	});

	test("rejects a vault path that traverses out of the vault root", () => {
		expect(() => parseVaultUrl("vault://Scratch%20Vault/../escape.md")).toThrow(/Path traversal/);
	});
});
