import { describe, expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../src/slash-commands/types";

function runtimeFor(settings: Settings, output: string[]): SlashCommandRuntime {
	return {
		get session(): never {
			throw new Error("Trailer controls must not touch a session");
		},
		get sessionManager(): never {
			throw new Error("Trailer controls must not touch session storage");
		},
		settings,
		cwd: process.cwd(),
		output: text => {
			output.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
}

function handler(): (
	command: { name: string; args: string; text: string },
	runtime: SlashCommandRuntime,
) => Promise<unknown> {
	const found = BUILTIN_SLASH_COMMANDS_INTERNAL.find(command => command.name === "auto-handoffs")?.handle;
	if (!found) throw new Error("Missing /auto-handoffs handler");
	return found as never;
}

describe("/auto-handoffs trailer command", () => {
	test("stores a normalized skill URI for a bare skill name", async () => {
		const settings = Settings.isolated({});
		const output: string[] = [];
		await handler()(
			{ name: "auto-handoffs", args: "trailer explain-simply", text: "" },
			runtimeFor(settings, output),
		);

		expect(settings.get("continuity.handoffTrailerSkill")).toBe("skill://explain-simply");
		expect(output.join("\n")).toContain("skill://explain-simply");
	});

	test("accepts an already-qualified skill URI", async () => {
		const settings = Settings.isolated({});
		await handler()(
			{ name: "auto-handoffs", args: "trailer skill://explain-simply", text: "" },
			runtimeFor(settings, []),
		);

		expect(settings.get("continuity.handoffTrailerSkill")).toBe("skill://explain-simply");
	});

	test("clears the trailer when asked for off", async () => {
		const settings = Settings.isolated({ "continuity.handoffTrailerSkill": "skill://explain-simply" });
		await handler()({ name: "auto-handoffs", args: "trailer off", text: "" }, runtimeFor(settings, []));

		expect(settings.get("continuity.handoffTrailerSkill")).toBe("");
	});

	test("clears the trailer when no argument is given", async () => {
		const settings = Settings.isolated({ "continuity.handoffTrailerSkill": "skill://explain-simply" });
		await handler()({ name: "auto-handoffs", args: "trailer", text: "" }, runtimeFor(settings, []));

		expect(settings.get("continuity.handoffTrailerSkill")).toBe("");
	});

	test("rejects a value that is not a plain skill name and changes nothing", async () => {
		const settings = Settings.isolated({});
		const output: string[] = [];
		await handler()(
			{ name: "auto-handoffs", args: "trailer ../../etc/passwd", text: "" },
			runtimeFor(settings, output),
		);

		expect(settings.get("continuity.handoffTrailerSkill")).toBe("");
		expect(output.join("\n")).toContain("Settings were not changed.");
	});

	test("reports the configured trailer in status output", async () => {
		const settings = Settings.isolated({ "continuity.handoffTrailerSkill": "skill://explain-simply" });
		const output: string[] = [];
		await handler()({ name: "auto-handoffs", args: "status", text: "" }, runtimeFor(settings, output));

		expect(output.join("\n")).toContain("Handoff trailer: skill://explain-simply");
	});

	test("reports no trailer when none is configured", async () => {
		const settings = Settings.isolated({});
		const output: string[] = [];
		await handler()({ name: "auto-handoffs", args: "status", text: "" }, runtimeFor(settings, output));

		expect(output.join("\n")).toContain("Handoff trailer: none.");
	});
});
