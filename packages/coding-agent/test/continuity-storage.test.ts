import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { registerWorkstream, resumeHandoff, saveHandoff } from "../src/continuity/service";
import { indexPath, readIndex, sha256, withFileLock } from "../src/continuity/store";
import type { HandoffSections, WorkstreamIndex } from "../src/continuity/types";
import * as vaultProtocol from "../src/internal-urls/vault-protocol";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../src/slash-commands/types";
import { ContinuityTool } from "../src/tools/continuity";

const sections: HandoffSections = {
	objective: "Portable notebook contract",
	currentState: "Verified in scratch directories only",
	keyContext: "No real vault or persistent settings are used",
	nextSteps: "Resume the registered record",
	validation: "Exercise real read and write paths",
	blockers: "None",
};
let temporary: string;
let repo: string;
let vault: string;
const id = "portable-notebook";
const uri = "vault://Scratch%20Vault/Notes/portable-notebook.md";

beforeEach(async () => {
	temporary = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-storage-"));
	repo = path.join(temporary, "project");
	vault = path.join(temporary, "vault");
	await fs.mkdir(repo);
	await fs.mkdir(vault);
	vaultProtocol.VaultProtocolHandler.resetForTests();
	vaultProtocol.VaultProtocolHandler.setVaultDirectoryForTests({ "Scratch Vault": vault });
	vi.spyOn(vaultProtocol, "isVaultEnabled").mockReturnValue(true);
});
afterEach(async () => {
	vi.restoreAllMocks();
	vaultProtocol.VaultProtocolHandler.resetForTests();
	await fs.rm(temporary, { recursive: true, force: true });
});

describe("portable repository records", () => {
	test("registration defaults to a relative repo note and resumes from a different clone path", async () => {
		const registration = await registerWorkstream({ root: repo, workstreamId: id });
		expect(registration.status).toBe("registered");
		const saved = await saveHandoff({ root: repo, workstreamId: id, sections });
		expect(saved.status).toBe("saved");
		const pointer = await fs.readFile(indexPath(repo), "utf-8");
		expect(pointer).toContain(`.agents/continuity/notes/${id}.md`);
		expect(pointer).not.toContain(temporary);
		const clone = path.join(temporary, "clone-with-another-name");
		await fs.cp(repo, clone, { recursive: true });
		await fs.rename(repo, `${repo}-offline`);
		const resumed = await resumeHandoff({ root: clone, workstreamId: id });
		expect(resumed.status).toBe("resumed");
		if (resumed.status !== "resumed") throw new Error("Resume failed");
		expect(resumed.sections).toEqual(sections);
		expect(resumed.path).toBe(path.join(clone, ".agents", "continuity", "notes", `${id}.md`));
	});

	test("corrupt registration never resets an existing registry", async () => {
		await fs.mkdir(path.dirname(indexPath(repo)), { recursive: true });
		await fs.writeFile(indexPath(repo), "{broken");
		expect((await registerWorkstream({ root: repo, workstreamId: id })).status).toBe("backend_unavailable");
		expect(await fs.readFile(indexPath(repo), "utf-8")).toBe("{broken");
	});

	test("read-only resume never invents storage", async () => {
		expect((await resumeHandoff({ root: repo, workstreamId: id })).status).toBe("backend_unavailable");
		expect(await fs.readdir(repo)).toEqual([]);
	});
});

describe("explicit Obsidian pointers", () => {
	test("keeps bodies and revisions in the vault, and only the pointer in the repo", async () => {
		expect((await registerWorkstream({ root: repo, workstreamId: id, canonical: uri })).status).toBe("registered");
		expect((await saveHandoff({ root: repo, workstreamId: id, sections })).status).toBe("saved");
		const note = path.join(vault, "Notes", `${id}.md`);
		const first = await fs.readFile(note, "utf-8");
		expect(
			(
				await saveHandoff({
					root: repo,
					workstreamId: id,
					sections: { ...sections, nextSteps: "Updated next steps" },
				})
			).status,
		).toBe("saved");
		expect(await fs.readFile(path.join(vault, "Notes", ".ompk-continuity", `${id}.md`, "r1.md"), "utf-8")).toBe(
			first,
		);
		const pointer = await fs.readFile(indexPath(repo), "utf-8");
		expect(pointer).toContain(uri);
		expect(pointer).not.toContain(vault);
		expect(pointer).not.toContain(sections.objective);
		expect(await fs.readdir(path.dirname(indexPath(repo)))).toEqual(["workstreams.json"]);
		const resumed = await resumeHandoff({ root: repo, workstreamId: id });
		expect(resumed.status).toBe("resumed");
		if (resumed.status !== "resumed") throw new Error("Resume failed");
		expect(resumed.path).toBe(uri);
		expect(resumed.revision).toBe(2);
	});

	test("resolves the same pointer after both repo and vault move on a new machine", async () => {
		await registerWorkstream({ root: repo, workstreamId: id, canonical: uri });
		await saveHandoff({ root: repo, workstreamId: id, sections });
		const clone = path.join(temporary, "new-repo");
		const relocatedVault = path.join(temporary, "new-vault");
		await fs.cp(repo, clone, { recursive: true });
		await fs.rename(vault, relocatedVault);
		vaultProtocol.VaultProtocolHandler.setVaultDirectoryForTests({ "Scratch Vault": relocatedVault });
		const result = await resumeHandoff({ root: clone, workstreamId: id });
		expect(result.status).toBe("resumed");
		if (result.status !== "resumed") throw new Error("Resume failed");
		expect(result.sections).toEqual(sections);
	});

	test("missing or disabled vault never creates a local fallback or changes the pointer", async () => {
		await registerWorkstream({ root: repo, workstreamId: id, canonical: uri });
		await saveHandoff({ root: repo, workstreamId: id, sections });
		const pointer = await fs.readFile(indexPath(repo), "utf-8");
		const before = await fs.readFile(path.join(vault, "Notes", `${id}.md`), "utf-8");
		vaultProtocol.VaultProtocolHandler.setVaultDirectoryForTests({});
		expect((await resumeHandoff({ root: repo, workstreamId: id })).status).toBe("backend_unavailable");
		expect((await saveHandoff({ root: repo, workstreamId: id, sections })).status).toBe("backend_unavailable");
		vi.spyOn(vaultProtocol, "isVaultEnabled").mockReturnValue(false);
		expect(
			(
				await registerWorkstream({
					root: repo,
					workstreamId: "another",
					canonical: "vault://Scratch%20Vault/another.md",
				})
			).status,
		).toBe("backend_unavailable");
		expect(await fs.readFile(indexPath(repo), "utf-8")).toBe(pointer);
		expect(await fs.readFile(path.join(vault, "Notes", `${id}.md`), "utf-8")).toBe(before);
		expect(await fs.readdir(path.dirname(indexPath(repo)))).toEqual(["workstreams.json"]);
	});

	test("switching a pointer requires explicit consent and leaves both records untouched", async () => {
		await registerWorkstream({ root: repo, workstreamId: id });
		await saveHandoff({ root: repo, workstreamId: id, sections });
		const original = path.join(repo, ".agents", "continuity", "notes", `${id}.md`);
		const content = await fs.readFile(original, "utf-8");
		await fs.mkdir(path.join(vault, "Notes"));
		await fs.writeFile(path.join(vault, "Notes", `${id}.md`), content);
		const rejected = await registerWorkstream({ root: repo, workstreamId: id, canonical: uri });
		expect(rejected.status).toBe("rejected");
		const result = await registerWorkstream({ root: repo, workstreamId: id, canonical: uri, replace: true });
		expect(result.status).toBe("registered");
		expect(await fs.readFile(original, "utf-8")).toBe(content);
		expect(await fs.readFile(path.join(vault, "Notes", `${id}.md`), "utf-8")).toBe(content);
		const read = await readIndex(repo);
		expect(read.kind).toBe("ok");
		if (read.kind !== "ok") throw new Error("Index unreadable");
		expect(read.index.workstreams).toHaveLength(1);
		expect(read.index.workstreams[0]?.canonical).toBe(uri);
	});

	test("does not adopt arbitrary existing vault notes", async () => {
		await fs.mkdir(path.join(vault, "Notes"));
		const target = path.join(vault, "Notes", `${id}.md`);
		await fs.writeFile(target, "Important existing wiki note");
		expect((await registerWorkstream({ root: repo, workstreamId: id, canonical: uri })).status).toBe("rejected");
		expect(await fs.readFile(target, "utf-8")).toBe("Important existing wiki note");
		expect(await Bun.file(indexPath(repo)).exists()).toBe(false);
	});

	test("rejects active vault aliases, traversal, and symlink or junction escapes", async () => {
		for (const canonical of [
			"vault://_/note.md",
			"vault://Scratch%20Vault/%2e%2e/note.md",
			"vault://Scratch%20Vault/note.md?op=outline",
			"../outside.md",
		]) {
			expect((await registerWorkstream({ root: repo, workstreamId: id, canonical })).status).not.toBe("registered");
		}
		const outside = path.join(temporary, "outside");
		await fs.mkdir(outside);
		await fs.symlink(outside, path.join(repo, "linked"), process.platform === "win32" ? "junction" : "dir");
		await fs.symlink(outside, path.join(vault, "linked"), process.platform === "win32" ? "junction" : "dir");
		for (const canonical of ["linked/note.md", "vault://Scratch%20Vault/linked/note.md"]) {
			expect((await registerWorkstream({ root: repo, workstreamId: id, canonical })).status).not.toBe("registered");
		}
		expect(await fs.readdir(outside)).toEqual([]);
	});
});

describe("guarded saves", () => {
	test("detects non-OMPK edits without a revision change, and accepts a fresh observed hash", async () => {
		await registerWorkstream({ root: repo, workstreamId: id });
		await saveHandoff({ root: repo, workstreamId: id, sections });
		const note = path.join(repo, ".agents", "continuity", "notes", `${id}.md`);
		const edited = (await fs.readFile(note, "utf-8")).replace(sections.blockers, "A newly recorded question");
		await fs.writeFile(note, edited);
		const stale = await saveHandoff({ root: repo, workstreamId: id, sections });
		expect(stale.status).toBe("rejected");
		expect(await fs.readFile(note, "utf-8")).toBe(edited);
		const resumed = await resumeHandoff({ root: repo, workstreamId: id });
		if (resumed.status !== "resumed") throw new Error("Resume failed");
		expect(resumed.sha256).toBe(sha256(edited));
		expect(
			(
				await saveHandoff({
					root: repo,
					workstreamId: id,
					sections,
					expectedSha256: resumed.sha256,
					expectedRevision: resumed.revision,
				})
			).status,
		).toBe("saved");
	});

	test("two repository clones share the vault record lock and reject a stale revision", async () => {
		await registerWorkstream({ root: repo, workstreamId: id, canonical: uri });
		await saveHandoff({ root: repo, workstreamId: id, sections });
		const clone = path.join(temporary, "other-clone");
		await fs.cp(repo, clone, { recursive: true });
		const results = await Promise.all(
			[repo, clone].map((root, n) =>
				saveHandoff({
					root,
					workstreamId: id,
					expectedRevision: 1,
					sections: { ...sections, nextSteps: `Writer ${n}` },
				}),
			),
		);
		expect(results.map(result => result.status).sort()).toEqual(["saved", "stale"]);
	});

	test("never steals an aged lock or retries a critical-section EEXIST error", async () => {
		const lock = path.join(repo, "owned.lock");
		await fs.writeFile(lock, "live-owner");
		await fs.utimes(lock, new Date(0), new Date(0));
		await expect(withFileLock(lock, async () => "unreachable", 0)).rejects.toThrow("lock busy");
		expect(await fs.readFile(lock, "utf-8")).toBe("live-owner");
		await fs.rm(lock);
		let calls = 0;
		await expect(
			withFileLock(lock, async () => {
				calls++;
				throw Object.assign(new Error("body failure"), { code: "EEXIST" });
			}),
		).rejects.toThrow("body failure");
		expect(calls).toBe(1);
		expect(await Bun.file(lock).exists()).toBe(false);
	});

	test("repointed notes with reused revision numbers keep both histories and remain writable", async () => {
		await registerWorkstream({ root: repo, workstreamId: id });
		await saveHandoff({ root: repo, workstreamId: id, sections });
		await saveHandoff({ root: repo, workstreamId: id, sections: { ...sections, blockers: "Second revision" } });
		const history = path.join(repo, ".agents", "continuity", "revisions", id);
		const oldRevision = await fs.readFile(path.join(history, "r1.md"), "utf-8");
		expect(
			(await registerWorkstream({ root: repo, workstreamId: id, canonical: "notes/new.md", replace: true })).status,
		).toBe("registered");
		const replacement = { ...sections, objective: "Replacement record" };
		expect((await saveHandoff({ root: repo, workstreamId: id, sections: replacement })).status).toBe("saved");
		const newRevision = await fs.readFile(path.join(repo, "notes", "new.md"), "utf-8");
		expect(
			(
				await saveHandoff({
					root: repo,
					workstreamId: id,
					sections: { ...replacement, blockers: "Further progress" },
				})
			).status,
		).toBe("saved");
		expect(await fs.readFile(path.join(history, "r1.md"), "utf-8")).toBe(oldRevision);
		expect(await fs.readFile(path.join(history, `r1.${sha256(newRevision)}.md`), "utf-8")).toBe(newRevision);
	});

	test("repeated real concurrent saves survive Windows delete-pending lock files", async () => {
		await registerWorkstream({ root: repo, workstreamId: id });
		for (let n = 0; n < 12; n++) {
			const results = await Promise.all(
				[0, 1].map(writer =>
					saveHandoff({
						root: repo,
						workstreamId: id,
						sections: { ...sections, nextSteps: `Round ${n}, writer ${writer}` },
					}),
				),
			);
			expect(results.map(result => ("reason" in result ? result.reason : result.status))).toEqual([
				"saved",
				"saved",
			]);
		}
	}, 15_000);
});

describe("tool and user controls", () => {
	test("register and save work through the tool using repo defaults", async () => {
		const settings = Settings.isolated({});
		const tool = new ContinuityTool({
			cwd: repo,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings,
		});
		expect(tool.approval({ action: "register" })).toBe("write");
		expect(tool.approval({ action: "resume" })).toBe("read");
		await tool.execute("register", { action: "register", workstreamId: id });
		await tool.execute("save", { action: "save", workstreamId: id, sections, evidenceObservedAt: "2026-11-14" });
		const resumed = await resumeHandoff({ root: repo, workstreamId: id });
		expect(resumed.status).toBe("resumed");
		if (resumed.status !== "resumed") throw new Error("Resume failed");
		expect(resumed.evidenceObservedAt).toBe("2026-11-14");
		expect(settings.get("continuity.store")).toBe("repo");
	});

	test("vault defaults affect registration, never re-route an existing repo record", async () => {
		const settings = Settings.isolated({ "continuity.store": "vault", "continuity.vault": "Scratch Vault" });
		const tool = new ContinuityTool({
			cwd: repo,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings,
		});
		await tool.execute("register", { action: "register", workstreamId: id });
		expect(await fs.readFile(indexPath(repo), "utf-8")).toContain("vault://Scratch%20Vault/Continuity/project/");
		settings.set("continuity.store", "repo");
		await tool.execute("save", { action: "save", workstreamId: id, sections });
		expect(await Bun.file(path.join(vault, "Continuity", "project", `${id}.md`)).exists()).toBe(true);
		expect(await Bun.file(path.join(repo, ".agents", "continuity", "notes", `${id}.md`)).exists()).toBe(false);
	});

	test("storage slash commands preserve vault case and spaces without enabling autosave or vault access", async () => {
		const settings = Settings.isolated({});
		const output: string[] = [];
		const runtime: SlashCommandRuntime = {
			get session(): never {
				throw new Error("Storage controls must not touch a session");
			},
			get sessionManager(): never {
				throw new Error("Storage controls must not touch session storage");
			},
			settings,
			cwd: repo,
			output: text => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};
		const handler = BUILTIN_SLASH_COMMANDS_INTERNAL.find(command => command.name === "auto-handoffs")?.handle;
		if (!handler) throw new Error("Missing handler");
		await handler(
			{ name: "auto-handoffs", args: "store vault Scratch Vault", text: "/auto-handoffs store vault Scratch Vault" },
			runtime,
		);
		expect(settings.get("continuity.vault")).toBe("Scratch Vault");
		expect(settings.get("continuity.store")).toBe("vault");
		expect(settings.get("continuity.autoSave")).toBe(false);
		expect(settings.get("vault.enabled")).toBe(false);
		await handler({ name: "auto-handoffs", args: "store vault", text: "/auto-handoffs store vault" }, runtime);
		expect(settings.get("continuity.vault")).toBe("Scratch Vault");
		await handler({ name: "auto-handoffs", args: "store repo", text: "/auto-handoffs store repo" }, runtime);
		expect(settings.get("continuity.store")).toBe("repo");
		expect(output.join("\n")).toContain("Existing notes and pointers are unchanged");
		expect(await fs.readdir(repo)).toEqual([]);
	});
});

describe("malformed pointers", () => {
	test("malformed vault pointers surface a typed location error instead of a generic failure", async () => {
		expect((await registerWorkstream({ root: repo, workstreamId: id, canonical: uri })).status).toBe("registered");
		const index = JSON.parse(await fs.readFile(indexPath(repo), "utf-8")) as WorkstreamIndex;
		const entry = index.workstreams.find(candidate => candidate.id === id);
		if (!entry) throw new Error("Registered workstream is missing from the index");
		const malformed = "vault://Scratch%20Vault/../escape.md";
		entry.canonical = malformed;
		await fs.writeFile(indexPath(repo), JSON.stringify(index));
		const resumed = await resumeHandoff({ root: repo, workstreamId: id });
		expect(resumed.status).toBe("backend_unavailable");
		if (resumed.status !== "backend_unavailable") throw new Error("Resume did not report a typed backend failure");
		expect(resumed.reason).toBe("invalid-vault-pointer");
		expect(resumed.detail.length).toBeGreaterThan(0);
		const saved = await saveHandoff({ root: repo, workstreamId: id, sections });
		expect(saved.status).toBe("backend_unavailable");
		if (saved.status !== "backend_unavailable") throw new Error("Save did not report a typed backend failure");
		expect(saved.reason).toBe("invalid-vault-pointer");
		expect(saved.detail.length).toBeGreaterThan(0);
		// An untyped escape reports write_failed/canonical-write-failed with an empty path; the typed
		// ContinuityLocationError branch above is what keeps malformed pointers classified.
	});
});
