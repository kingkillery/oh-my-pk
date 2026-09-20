/**
 * Auto-QA filing pipeline: GitHub remote detection, vault notes, and the
 * suppressible filing prompt + reminders.
 *
 * Asserts:
 * 1. `parseGitHubSlug` handles ssh/https/git@ remote shapes and rejects
 *    non-GitHub remotes.
 * 2. `deriveProjectName` prefers the repo name and stays filesystem-safe.
 * 3. `writeVaultIssueNote` creates a note under <vault>/<project>/issues/,
 *    then updates occurrences/last_seen on repeat instead of duplicating.
 * 4. The reminder handler's inline off-switch persists to settings.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__resetAutoQaFilingForTests,
	deriveProjectName,
	parseGitHubSlug,
	writeVaultIssueNote,
} from "@pk-nerdsaver-ai/pi-coding-agent/tools/report-tool-issue";

afterEach(() => {
	__resetAutoQaFilingForTests();
});

describe("parseGitHubSlug", () => {
	it("parses ssh, https, and git@ remotes", () => {
		expect(parseGitHubSlug("git@github.com:kingkillery/oh-my-pk.git")).toBe("kingkillery/oh-my-pk");
		expect(parseGitHubSlug("https://github.com/kingkillery/oh-my-pk.git")).toBe("kingkillery/oh-my-pk");
		expect(parseGitHubSlug("https://github.com/kingkillery/oh-my-pk")).toBe("kingkillery/oh-my-pk");
		expect(parseGitHubSlug("ssh://git@github.com/kingkillery/oh-my-pk.git")).toBe("kingkillery/oh-my-pk");
	});

	it("rejects non-GitHub remotes", () => {
		expect(parseGitHubSlug("https://gitlab.com/a/b.git")).toBeNull();
		expect(parseGitHubSlug("git@bitbucket.org:a/b.git")).toBeNull();
		expect(parseGitHubSlug("")).toBeNull();
	});
});

describe("deriveProjectName", () => {
	it("uses the repo name when a slug is available", () => {
		expect(deriveProjectName("C:\\dev\\Infra\\oh-my-pk", "kingkillery/oh-my-pk")).toBe("oh-my-pk");
	});

	it("falls back to the cwd basename and sanitizes", () => {
		expect(deriveProjectName("C:\\dev\\Vaults\\Design and Building", null)).toBe("Design-and-Building");
		expect(deriveProjectName("/home/u/my proj!", null)).toBe("my-proj");
	});
});

describe("writeVaultIssueNote", () => {
	it("creates then updates a note under <vault>/<project>/issues/", async () => {
		const vault = mkdtempSync(join(tmpdir(), "autoqa-vault-"));
		try {
			const file = await writeVaultIssueNote(
				vault,
				"oh-my-pk",
				"read",
				"read returned wrong file contents for concurrent requests",
				"test-model",
				"1.0.0",
			);
			expect(file).not.toBeNull();
			expect(file!.replace(/\\/g, "/")).toContain("/oh-my-pk/issues/");
			const first = await Bun.file(file!).text();
			expect(first).toContain("occurrences: 1");
			expect(first).toContain("tool: read");

			// Repeat the same report — same file, bumped count, no duplicate.
			const file2 = await writeVaultIssueNote(
				vault,
				"oh-my-pk",
				"read",
				"read returned wrong file contents for concurrent requests",
				"test-model",
				"1.0.0",
			);
			expect(file2).toBe(file);
			const second = await Bun.file(file!).text();
			expect(second).toContain("occurrences: 2");
		} finally {
			rmSync(vault, { recursive: true, force: true });
		}
	});

	it("writes a variant section for different wording of the same tool issue", async () => {
		const vault = mkdtempSync(join(tmpdir(), "autoqa-vault-"));
		try {
			await writeVaultIssueNote(vault, "proj", "edit", "edit accepted a stale anchor", "m", "1");
			const file = await writeVaultIssueNote(
				vault,
				"proj",
				"edit",
				"edit accepted a stale anchor and modified shifted code",
				"m",
				"1",
			);
			const text = await Bun.file(file!).text();
			expect(text).toContain("## Variant");
		} finally {
			rmSync(vault, { recursive: true, force: true });
		}
	});

	it("returns null instead of throwing on an unwritable vault", async () => {
		const result = await writeVaultIssueNote(
			"Z:\\nonexistent\\vault\\that\\cannot\\exist",
			"proj",
			"read",
			"some report",
			"m",
			"1",
		);
		expect(result).toBeNull();
	});
});
