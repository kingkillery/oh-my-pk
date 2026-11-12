import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deriveProjectName, writeVaultIssueNote } from "@pk-nerdsaver-ai/pi-coding-agent/tools/report-tool-issue";

describe("autoqa vault issue notes", () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "autoqa-vault-"));
	});

	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	it("writes the note under <vault>/<project>/issues for an absolute vault root", async () => {
		const file = await writeVaultIssueNote(
			tmp,
			"demo-project",
			"ix_bridge",
			"the tool did not respond",
			"model-x",
			"1.2.3",
		);

		expect(file).not.toBeNull();
		const expected = path.join(tmp, "demo-project", "issues", "ix_bridge-the-tool-did.md");
		expect(file).toBe(expected);
		const note = await fs.readFile(expected, "utf8");
		expect(note).toContain("tool: ix_bridge");
		expect(note).toContain("project: demo-project");
		expect(note).toContain("occurrences: 1");
	});

	it("refuses a relative vault root instead of writing into the current directory", async () => {
		// A mangled Windows drive ("C;/dev/vaults" instead of "C:/dev/vaults")
		// is a relative path. Writing it as-is drops the note into whatever
		// repository happens to be the session cwd.
		const relativeRoot = path.join("C;", "dev", "vaults", "design-and-building");

		const file = await writeVaultIssueNote(
			relativeRoot,
			"demo-project",
			"ix_bridge",
			"the tool did not respond",
			"model-x",
			"1.2.3",
		);

		expect(file).toBeNull();
		// Nothing may be created in the process cwd either.
		await expect(fs.stat(path.join(relativeRoot, "demo-project"))).rejects.toThrow();
	});

	it("bumps occurrences and last_seen when the same report repeats", async () => {
		await writeVaultIssueNote(tmp, "demo-project", "ix_bridge", "the tool did not respond", "model-x", "1.2.3");
		await writeVaultIssueNote(tmp, "demo-project", "ix_bridge", "the tool did not respond", "model-x", "1.2.3");

		const note = await fs.readFile(path.join(tmp, "demo-project", "issues", "ix_bridge-the-tool-did.md"), "utf8");
		expect(note).toContain("occurrences: 2");
	});

	it("derives a filesystem-safe project name from a repo slug or cwd", () => {
		expect(deriveProjectName("/repo", "kingkillery/pk-web-navi")).toBe("pk-web-navi");
		expect(deriveProjectName("/repo", null)).toBe("repo");
	});
});
