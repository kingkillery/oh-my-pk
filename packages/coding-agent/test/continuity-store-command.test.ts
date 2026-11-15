import { describe, expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../src/slash-commands/types";

describe("/auto-handoffs store command", () => {
	test("rejects a zero-width vault name without changing settings and accepts Scratch Vault", async () => {
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
			cwd: process.cwd(),
			output: text => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};
		const handler = BUILTIN_SLASH_COMMANDS_INTERNAL.find(command => command.name === "auto-handoffs")?.handle;
		if (!handler) throw new Error("Missing handler");

		await handler(
			{ name: "auto-handoffs", args: "store vault \u200b", text: "/auto-handoffs store vault \u200b" },
			runtime,
		);
		expect(output.join("\n")).toContain("Settings were not changed.");
		expect(settings.get("continuity.store")).toBe("repo");
		expect(settings.get("continuity.vault")).toBe("");

		await handler(
			{ name: "auto-handoffs", args: "store vault Scratch Vault", text: "/auto-handoffs store vault Scratch Vault" },
			runtime,
		);
		expect(settings.get("continuity.store")).toBe("vault");
		expect(settings.get("continuity.vault")).toBe("Scratch Vault");
	});
});
