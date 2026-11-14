import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import type { ToolCall } from "@pk-nerdsaver-ai/pi-ai";
import { getDefault, getEnumValues } from "../src/config/settings-schema";
import {
	END_OF_TURN_HANDOFF_MODES,
	HANDOFF_SECTIONS,
	handoffDirective,
	shouldEmitHandoff,
	turnChangedWorkspace,
} from "../src/continuity/auto-handoff";
import {
	BUILTIN_SLASH_COMMAND_RESERVED_NAMES,
	BUILTIN_SLASH_COMMANDS,
	BUILTIN_SLASH_COMMANDS_INTERNAL,
} from "../src/slash-commands/builtin-registry";

function toolTurn(name: string): AgentMessage {
	const call: ToolCall = { type: "toolCall", id: "t1", name, arguments: {} };
	return { role: "assistant", content: [call] } as AgentMessage;
}

function textTurn(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;
}

const base = {
	stopHookActive: false,
	turnId: 3,
	lastEmittedTurnId: undefined,
	messages: [toolTurn("write")] as readonly AgentMessage[],
};

describe("end-of-turn handoff mode", () => {
	it("offers exactly the three documented modes", () => {
		expect(END_OF_TURN_HANDOFF_MODES).toEqual(["off", "changed", "always"]);
	});

	it("never emits while the mode is off, even after a write", () => {
		expect(shouldEmitHandoff({ ...base, mode: "off" })).toBe(false);
	});

	it("emits after a turn that changed files in changed mode", () => {
		expect(shouldEmitHandoff({ ...base, mode: "changed" })).toBe(true);
	});

	it("stays silent in changed mode for a read-only turn", () => {
		expect(shouldEmitHandoff({ ...base, mode: "changed", messages: [textTurn("explained")] })).toBe(false);
	});

	it("emits on every settled turn in always mode", () => {
		expect(shouldEmitHandoff({ ...base, mode: "always", messages: [textTurn("read-only")] })).toBe(true);
	});

	it("does not chain a second handoff onto its own continuation turn", () => {
		expect(shouldEmitHandoff({ ...base, mode: "always", stopHookActive: true })).toBe(false);
	});

	it("does not repeat a handoff for the same turn", () => {
		expect(shouldEmitHandoff({ ...base, mode: "always", lastEmittedTurnId: 3 })).toBe(false);
		expect(shouldEmitHandoff({ ...base, mode: "always", lastEmittedTurnId: 2 })).toBe(true);
	});

	it("counts only mutating tools as meaningful progress", () => {
		expect(turnChangedWorkspace([toolTurn("write")])).toBe(true);
		expect(turnChangedWorkspace([toolTurn("edit")])).toBe(true);
		expect(turnChangedWorkspace([toolTurn("read")])).toBe(false);
		expect(turnChangedWorkspace([textTurn("no tools")])).toBe(false);
		expect(turnChangedWorkspace([])).toBe(false);
	});
});

describe("handoff directive", () => {
	it("asks for one tagged block with all six sections in order", () => {
		const directive = handoffDirective("changed");
		expect(directive).toContain("<handoff-prompt>");
		expect(directive).toContain("</handoff-prompt>");
		const positions = HANDOFF_SECTIONS.map(section => directive.indexOf(section));
		expect(positions.every(position => position >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		expect(HANDOFF_SECTIONS).toHaveLength(6);
	});

	it("scopes changed mode to progress since the previous handoff", () => {
		expect(handoffDirective("changed")).toContain("since the previous handoff");
		expect(handoffDirective("always")).toContain("work so far in this session");
	});

	it("forbids side effects so displaying a handoff stays display-only", () => {
		const directive = handoffDirective("always");
		expect(directive).toContain("do not write to a vault");
		expect(directive).toContain("do not change settings");
	});
});

describe("continuity settings", () => {
	it("defaults to generating nothing and saving nothing", () => {
		expect(getDefault("continuity.endOfTurnHandoff")).toBe("off");
		expect(getDefault("continuity.autoSave")).toBe(false);
	});

	it("accepts only the three handoff modes", () => {
		expect(getEnumValues("continuity.endOfTurnHandoff")).toEqual(["off", "changed", "always"]);
	});

	it("keeps generation and persistence as independent keys", () => {
		expect(getEnumValues("continuity.autoSave")).toBeUndefined();
		expect(getDefault("continuity.autoSave")).toBe(false);
	});
});

describe("/auto-handoffs command", () => {
	const command = BUILTIN_SLASH_COMMANDS.find(entry => entry.name === "auto-handoffs");
	const internal = BUILTIN_SLASH_COMMANDS_INTERNAL.find(entry => entry.name === "auto-handoffs");

	it("is registered as a reserved built-in with a handler", () => {
		expect(command).toBeDefined();
		expect(typeof internal?.handle).toBe("function");
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("auto-handoffs")).toBe(true);
	});

	it("exposes the documented modes plus a separate save toggle", () => {
		const names = command?.subcommands?.map(subcommand => subcommand.name) ?? [];
		expect(names).toEqual(["off", "changed", "always", "save", "status"]);
	});
});
