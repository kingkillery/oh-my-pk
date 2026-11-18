import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import type { ToolCall } from "@pk-nerdsaver-ai/pi-ai";
import { getDefault, getEnumValues } from "../src/config/settings-schema";
import {
	END_OF_TURN_HANDOFF_MODES,
	HANDOFF_SECTIONS,
	handoffDirective,
	normalizeTrailerSkill,
	shouldEmitHandoff,
	turnChangedWorkspace,
} from "../src/continuity/auto-handoff";
import { parseHandoff, renderHandoff } from "../src/continuity/render";
import type { HandoffSections } from "../src/continuity/types";
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
		expect(names).toEqual(["off", "changed", "always", "save", "store", "trailer", "status"]);
	});
});

describe("handoff trailer skill", () => {
	it("normalizes a bare skill name into a skill URI", () => {
		expect(normalizeTrailerSkill("explain-simply")).toBe("skill://explain-simply");
		expect(normalizeTrailerSkill("  explain-simply  ")).toBe("skill://explain-simply");
	});

	it("accepts an already-qualified skill URI unchanged", () => {
		expect(normalizeTrailerSkill("skill://explain-simply")).toBe("skill://explain-simply");
	});

	it("rejects values that are not plain skill names", () => {
		expect(normalizeTrailerSkill("")).toBe("");
		expect(normalizeTrailerSkill("   ")).toBe("");
		expect(normalizeTrailerSkill("not a skill")).toBe("");
		expect(normalizeTrailerSkill("../../etc/passwd")).toBe("");
		expect(normalizeTrailerSkill("https://example.com/x")).toBe("");
		expect(normalizeTrailerSkill("skill://a/b")).toBe("");
		expect(normalizeTrailerSkill("Uppercase")).toBe("");
		expect(normalizeTrailerSkill("-leading-dash")).toBe("");
	});

	it("adds no trailer instruction when unset", () => {
		expect(handoffDirective("always")).not.toContain("skill://");
		expect(handoffDirective("always", "")).not.toContain("skill://");
	});

	it("asks for the trailer on the line after the closing tag", () => {
		const directive = handoffDirective("always", "explain-simply");
		expect(directive).toContain("skill://explain-simply");
		expect(directive).toContain("</handoff-prompt> tag");
	});

	it("drops an unusable trailer instead of injecting stray text", () => {
		const directive = handoffDirective("always", "../../etc/passwd");
		expect(directive).not.toContain("skill://");
		expect(directive).not.toContain("etc/passwd");
	});

	it("leaves the six-section contract untouched", () => {
		const directive = handoffDirective("always", "explain-simply");
		const positions = HANDOFF_SECTIONS.map(section => directive.indexOf(section));
		expect(positions.every(position => position >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});
});

describe("handoff trailer setting", () => {
	it("defaults to no trailer", () => {
		expect(getDefault("continuity.handoffTrailerSkill")).toBe("");
	});

	it("is a free-text setting, not an enum", () => {
		expect(getEnumValues("continuity.handoffTrailerSkill")).toBeUndefined();
	});
});

describe("trailer stays out of the saved record", () => {
	const SECTIONS: HandoffSections = {
		objective: "Keep the review traceable.",
		currentState: "Verified: brief compiled.",
		keyContext: "Operational record.",
		nextSteps: "1. Confirm dispatcher notes.",
		validation: "Checked source counts.",
		blockers: "none known",
	};

	it("keeps the record byte-identical whether or not a trailer is configured", () => {
		const meta = {
			workstream: "trailer-isolation",
			title: "Trailer isolation",
			authority: "canonical" as const,
			revision: 1,
			updated: "2026-11-17",
		};
		const withoutTrailer = renderHandoff(meta, SECTIONS);
		const withTrailer = renderHandoff(meta, SECTIONS);
		expect(withTrailer).toBe(withoutTrailer);
		expect(withTrailer).not.toContain("skill://");
	});

	it("leaves a trailer outside the closing tag unparsed by the record reader", () => {
		const meta = {
			workstream: "trailer-isolation",
			title: "Trailer isolation",
			authority: "canonical" as const,
			revision: 1,
			updated: "2026-11-17",
		};
		const record = `${renderHandoff(meta, SECTIONS)}\nskill://explain-simply\n`;
		const parsed = parseHandoff(record);
		expect(parsed).toBeDefined();
		expect(parsed?.body).not.toContain("skill://");
		expect(parsed?.body.endsWith("</handoff-prompt>")).toBe(true);
	});
});
