import { describe, expect, test } from "bun:test";
import { CombinedAutocompleteProvider } from "@pk-nerdsaver-ai/pi-tui";
import { Settings } from "../src/config/settings";
import { BUILTIN_SLASH_COMMANDS, BUILTIN_SLASH_COMMANDS_INTERNAL } from "../src/slash-commands/builtin-registry";
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

describe("/auto-handoffs explain-simply slash command menu", () => {
	const autoHandoffs = BUILTIN_SLASH_COMMANDS.find(command => command.name === "auto-handoffs");

	test("registers singular /auto-handoff alias alongside /notebook", () => {
		expect(autoHandoffs?.aliases).toEqual(["auto-handoff", "notebook"]);
	});

	test("shows explain-simply in the initial 5-row /auto-handoffs menu without scrolling", async () => {
		const items = await autoHandoffs?.getArgumentCompletions?.("");
		expect(items?.map(item => item.label)).toEqual([
			"off",
			"changed",
			"always",
			"explain-simply",
			"save",
			"store",
			"trailer",
			"status",
		]);
		const direct = items?.find(item => item.label === "explain-simply");
		expect(direct?.value).toBe("trailer explain-simply ");
	});

	test("inserts valid trailer explain-simply command from both /auto-handoffs and /auto-handoff", async () => {
		const provider = new CombinedAutocompleteProvider([autoHandoffs!]);
		for (const line of ["/auto-handoffs ", "/auto-handoff "]) {
			const suggestions = await provider.getSuggestions([line], 0, line.length);
			expect(suggestions).not.toBeNull();
			const direct = suggestions!.items.find(item => item.label === "explain-simply");
			expect(direct).toBeDefined();
			const applied = provider.applyCompletion([line], 0, line.length, direct!, suggestions!.prefix);
			expect(applied.lines[0]).toBe(`${line}trailer explain-simply `);
		}
	});

	test("completes explain-simply and off under /auto-handoffs trailer ", async () => {
		const provider = new CombinedAutocompleteProvider([autoHandoffs!]);
		const line = "/auto-handoffs trailer ";
		const suggestions = await provider.getSuggestions([line], 0, line.length);
		expect(suggestions?.items.map(item => item.label)).toEqual(["explain-simply", "off"]);

		const explainItem = suggestions!.items[0]!;
		const applied = provider.applyCompletion([line], 0, line.length, explainItem, suggestions!.prefix);
		expect(applied.lines[0]).toBe("/auto-handoffs trailer explain-simply ");

		const filtered = await autoHandoffs?.getArgumentCompletions?.("trailer ex");
		expect(filtered?.map(item => item.label)).toEqual(["explain-simply"]);
	});

	test("accepts direct /auto-handoffs explain-simply shorthand", async () => {
		const settings = Settings.isolated({});
		const output: string[] = [];
		await handler()(
			{ name: "auto-handoffs", args: "explain-simply", text: "/auto-handoffs explain-simply" },
			runtimeFor(settings, output),
		);
		expect(settings.get("continuity.handoffTrailerSkill")).toBe("skill://explain-simply");
		expect(output.join("\n")).toContain("Handoff trailer: skill://explain-simply");
	});
});
