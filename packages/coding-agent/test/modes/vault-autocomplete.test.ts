import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls/router";
import * as vaultProtocol from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls/vault-protocol";
import {
	applyInternalUrlCompletion,
	extractInternalUrlContext,
	getInternalUrlSuggestions,
} from "@pk-nerdsaver-ai/pi-coding-agent/modes/internal-url-autocomplete";
import { PromptActionAutocompleteProvider } from "@pk-nerdsaver-ai/pi-coding-agent/modes/prompt-action-autocomplete";
import { Editor } from "@pk-nerdsaver-ai/pi-tui/components/editor";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";
import { defaultEditorTheme } from "../../../tui/test/test-themes";

const { VaultProtocolHandler } = vaultProtocol;

describe("vault link autocomplete", () => {
	let temp: string;
	let root: string;
	let registry: string;
	let handler: vaultProtocol.VaultProtocolHandler;

	beforeEach(async () => {
		VaultProtocolHandler.resetForTests();
		InternalUrlRouter.resetForTests();
		vi.spyOn(vaultProtocol, "isVaultEnabled").mockReturnValue(true);
		temp = await fs.mkdtemp(path.join(os.tmpdir(), "vault-completion-"));
		root = path.join(temp, "Work Notes");
		registry = path.join(temp, "obsidian.json");
		await fs.mkdir(path.join(root, "Design Plans"), { recursive: true });
		await fs.mkdir(path.join(root, ".obsidian"));
		await Bun.write(path.join(root, "Design Plans", "Today's plan (v2).md"), "# Actual note\nDesign context.");
		await Bun.write(path.join(root, "README.md"), "Vault root note");
		await Bun.write(registry, JSON.stringify({ vaults: { work: { path: root, open: true } } }));
		handler = new VaultProtocolHandler({ obsidianConfigPath: registry, resolveObsidianBinary: () => null });
		InternalUrlRouter.instance().register(handler);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		VaultProtocolHandler.resetForTests();
		InternalUrlRouter.resetForTests();
		await removeWithRetries(temp);
	});

	for (const prefix of ["vault:/", "vault://", "vaults:/", "vaults://", "vauts:/", "vauts://", "VAULT://"]) {
		it(`offers canonical vault links from ${prefix}`, async () => {
			expect(extractInternalUrlContext(`discuss ${prefix}`)).toEqual({ scheme: "vault", query: "", token: prefix });
			const result = await getInternalUrlSuggestions(`discuss ${prefix}`);
			expect(result?.items).toEqual([
				{ value: "vault://Work%20Notes/", label: "Work Notes/", description: "Obsidian vault" },
			]);
			expect(result?.prefix).toBe(prefix);
		});
	}

	it("filters vaults and browses immediate folders/files with encoded paths", async () => {
		expect((await getInternalUrlSuggestions("vault://wn"))?.items[0]?.value).toBe("vault://Work%20Notes/");
		const entries = await getInternalUrlSuggestions("vault://Work%20Notes/");
		expect(entries?.items.map(item => item.label)).toEqual(["Design Plans/", "README.md"]);
		const nested = await getInternalUrlSuggestions("vault://Work%20Notes/Design%20Plans/Tod");
		expect(nested?.items[0]).toMatchObject({
			value: "vault://Work%20Notes/Design%20Plans/Today%27s%20plan%20%28v2%29.md",
			label: "Today's plan (v2).md",
		});
		const resource = await InternalUrlRouter.instance().resolve(nested!.items[0]!.value);
		expect(resource.content).toBe("# Actual note\nDesign context.");
		expect(resource.sourcePath).toBe(await fs.realpath(path.join(root, "Design Plans", "Today's plan (v2).md")));
	});

	it("keeps folder references open but terminates a selected note without disturbing surrounding prose", async () => {
		const line = "discuss vaults:/ and compare";
		const prefix = "vaults:/";
		const cursor = "discuss vaults:/".length;
		const result = await getInternalUrlSuggestions(line.slice(0, cursor));
		const selected = applyInternalUrlCompletion([line], 0, cursor, result!.items[0]!, prefix);
		expect(selected.lines).toEqual(["discuss vault://Work%20Notes/ and compare"]);
		expect(selected.cursorCol).toBe("discuss vault://Work%20Notes/".length);
		const notePrefix = "vault://Work%20Notes/REA";
		const notes = await getInternalUrlSuggestions(notePrefix);
		const applied = applyInternalUrlCompletion([notePrefix], 0, notePrefix.length, notes!.items[0]!, notePrefix);
		expect(applied.lines).toEqual(["vault://Work%20Notes/README.md "]);
	});

	it("does not discover vaults when disabled and recovers after enabling", async () => {
		vi.spyOn(vaultProtocol, "isVaultEnabled").mockReturnValue(false);
		expect(await getInternalUrlSuggestions("vault://")).toBeNull();
		vi.spyOn(vaultProtocol, "isVaultEnabled").mockReturnValue(true);
		expect((await getInternalUrlSuggestions("vault://"))?.items).toHaveLength(1);
	});

	it("fails quietly for unavailable registries and recovers when a registry appears", async () => {
		await fs.unlink(registry);
		expect(await handler.complete()).toEqual([]);
		await Bun.write(registry, "not json");
		expect(await handler.complete()).toEqual([]);
		await Bun.write(registry, JSON.stringify({ vaults: { work: { path: root } } }));
		expect(await handler.complete()).toHaveLength(1);
	});

	it("does not launch the CLI, even for missing vaults, query operations or incomplete paths", async () => {
		for (const query of ["Missing/", "Work%20Notes/%", "Work%20Notes/?op=search", "Work%20Notes/no-such-folder/"]) {
			expect(await handler.complete(query)).toEqual([]);
		}
		expect(await handler.complete("", { signal: AbortSignal.abort() })).toEqual([]);
	});

	it("rejects traversal and realpath escapes, including Windows junctions", async () => {
		const outside = path.join(temp, "outside");
		await fs.mkdir(outside);
		await Bun.write(path.join(outside, "secret.md"), "not vault context");
		await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
		for (const query of ["Work%20Notes/../", "Work%20Notes/%2e%2e/", "Work%20Notes/escape/"]) {
			expect(await handler.complete(query)).toEqual([]);
		}
	});

	for (const key of ["\t", "\r"]) {
		it(`drills from vault to folder to readable note in the real editor with ${key === "\t" ? "Tab" : "Enter"}`, async () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setAutocompleteProvider(new PromptActionAutocompleteProvider([], temp, []));
			let submissions = 0;
			editor.onSubmit = () => {
				submissions += 1;
			};
			function nextSuggestions(): Promise<void> {
				const ready = Promise.withResolvers<void>();
				editor.onAutocompleteUpdate = () => {
					if (editor.isShowingAutocomplete()) ready.resolve();
				};
				return ready.promise;
			}
			const vaultsReady = nextSuggestions();
			editor.handleInput("discuss vaults://");
			await vaultsReady;
			const foldersReady = nextSuggestions();
			editor.handleInput(key);
			expect(editor.getText()).toBe("discuss vault://Work%20Notes/");
			await foldersReady;
			const notesReady = nextSuggestions();
			editor.handleInput(key);
			expect(editor.getText()).toBe("discuss vault://Work%20Notes/Design%20Plans/");
			await notesReady;
			editor.handleInput(key);
			expect(editor.getText()).toBe("discuss vault://Work%20Notes/Design%20Plans/Today%27s%20plan%20%28v2%29.md ");
			expect(editor.isShowingAutocomplete()).toBe(false);
			expect(submissions).toBe(0);
			const url = editor.getText().slice("discuss ".length).trim();
			expect((await InternalUrlRouter.instance().resolve(url)).content).toContain("Design context.");
		});
	}
});
