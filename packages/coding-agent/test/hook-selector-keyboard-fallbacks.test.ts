import { beforeAll, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@pk-nerdsaver-ai/pi-coding-agent/config/keybindings";
import { HookSelectorComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/hook-selector";
import { getThemeByName, setThemeInstance } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { setKeybindings } from "@pk-nerdsaver-ai/pi-tui";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\n";
const CR = "\r";
const ESC = "\x1b";
const CTRL_P = "\x10";
const CTRL_N = "\x0e";

const REMINDER_OPTIONS = ["Keep as-is", "Stop these reminders", "Stop collecting reports entirely"];

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(theme);
	setKeybindings(KeybindingsManager.inMemory());
});

function trackSelection(
	options: string[],
	extra?: { initialIndex?: number; disabledIndices?: number[] },
): {
	component: HookSelectorComponent;
	selected: Array<string | undefined>;
	cancelled: () => boolean;
} {
	const selected: Array<string | undefined> = [];
	let cancelCount = 0;
	const component = new HookSelectorComponent(
		"Auto-QA tool-issue collection is on.",
		options,
		option => {
			selected.push(option);
		},
		() => {
			cancelCount += 1;
		},
		{
			initialIndex: extra?.initialIndex ?? 0,
			disabledIndices: extra?.disabledIndices,
		},
	);
	return { component, selected, cancelled: () => cancelCount > 0 };
}

describe("HookSelectorComponent keyboard fallbacks", () => {
	it("selects the nth option on single-digit input when search is off", () => {
		const { component, selected } = trackSelection(REMINDER_OPTIONS);
		component.handleInput("3");
		expect(selected).toEqual(["Stop collecting reports entirely"]);
	});

	it("ignores out-of-range digits", () => {
		const { component, selected } = trackSelection(REMINDER_OPTIONS);
		component.handleInput("9");
		expect(selected).toEqual([]);
	});

	it("ignores digits targeting disabled options", () => {
		const { component, selected } = trackSelection(REMINDER_OPTIONS, {
			disabledIndices: [1],
		});
		component.handleInput("2");
		expect(selected).toEqual([]);
		component.handleInput("1");
		expect(selected).toEqual(["Keep as-is"]);
	});

	it("moves selection with ctrl+p / ctrl+n", () => {
		const { component, selected } = trackSelection(REMINDER_OPTIONS, {
			initialIndex: 1,
		});
		component.handleInput(CTRL_P);
		component.handleInput(ENTER);
		expect(selected).toEqual(["Keep as-is"]);

		const moved = trackSelection(REMINDER_OPTIONS, { initialIndex: 0 });
		moved.component.handleInput(CTRL_N);
		moved.component.handleInput(ENTER);
		expect(moved.selected).toEqual(["Stop these reminders"]);
	});

	it("keeps arrow navigation working", () => {
		const { component, selected } = trackSelection(REMINDER_OPTIONS);
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(UP);
		component.handleInput(ENTER);
		expect(selected).toEqual(["Stop these reminders"]);
	});

	it("confirms with carriage return", () => {
		const { component, selected } = trackSelection(REMINDER_OPTIONS);
		component.handleInput(CR);
		expect(selected).toEqual(["Keep as-is"]);
	});

	it("cancels on raw escape", () => {
		const { component, selected, cancelled } = trackSelection(REMINDER_OPTIONS);
		component.handleInput(ESC);
		expect(cancelled()).toBe(true);
		expect(selected).toEqual([]);
	});

	it("treats digits as search filter text when search is on", () => {
		const options = Array.from({ length: 15 }, (_, index) => `Option ${String(index + 1).padStart(2, "0")}`);
		const { component, selected } = trackSelection(options);
		component.handleInput("1");
		expect(selected).toEqual([]);
	});
});
