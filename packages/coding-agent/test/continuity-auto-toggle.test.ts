import { describe, expect, it } from "bun:test";
import type { Settings } from "../src/config/settings";
import {
	autoContinuityIndicator,
	automaticContinuityActive,
	describeAutoContinuity,
	readAutoContinuity,
} from "../src/continuity/auto-toggle";

function settings(values: { mode?: "off" | "changed" | "always"; autoSave?: boolean; simple?: boolean }): Settings {
	const stored = {
		"continuity.endOfTurnHandoff": values.mode ?? "off",
		"continuity.autoSave": values.autoSave ?? false,
		"task.simpleMode": values.simple ?? false,
	};
	return {
		get(path: keyof typeof stored) {
			return stored[path];
		},
	} as unknown as Settings;
}

describe("automatic continuity toggle", () => {
	it("is off by default and shows no indicator", () => {
		const current = settings({});
		expect(automaticContinuityActive(current)).toBe(false);
		expect(autoContinuityIndicator(current)).toBeUndefined();
		expect(describeAutoContinuity(current)).toContain("will not inject");
	});

	it("shows a visible indicator only while automatic injection is on", () => {
		const changed = settings({ mode: "changed" });
		expect(automaticContinuityActive(changed)).toBe(true);
		expect(autoContinuityIndicator(changed)).toBe("continuity auto on (after edits)");

		const always = settings({ mode: "always", autoSave: true });
		expect(autoContinuityIndicator(always)).toBe("continuity auto on (every turn, saving)");
	});

	it("forces the layer off in simple mode and says so", () => {
		const current = settings({ mode: "always", autoSave: true, simple: true });
		const state = readAutoContinuity(current);
		expect(state.effective).toBe("off");
		expect(state.autoSave).toBe(false);
		expect(state.suppressedBySimpleMode).toBe(true);
		expect(automaticContinuityActive(current)).toBe(false);
		expect(autoContinuityIndicator(current)).toBe("continuity auto off (simple mode)");
		expect(describeAutoContinuity(current)).toContain("simple mode injects nothing");
	});

	it("keeps an off simple session quiet", () => {
		const current = settings({ simple: true });
		expect(readAutoContinuity(current).suppressedBySimpleMode).toBe(false);
		expect(autoContinuityIndicator(current)).toBeUndefined();
	});
});
