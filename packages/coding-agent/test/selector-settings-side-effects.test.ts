import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { SelectorController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/selector-controller";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("selector setting side effects", () => {
	it("refreshes the status line when git integration changes at runtime", () => {
		const updateSettings = vi.fn();
		const updateEditorTopBorder = vi.fn();
		const requestRender = vi.fn();
		const controller = new SelectorController({
			statusLine: { updateSettings },
			updateEditorTopBorder,
			ui: { requestRender },
		} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		Settings.instance.override("git.enabled", false);
		controller.handleSettingChange("git.enabled", false);

		expect(updateSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				preset: Settings.instance.get("statusLine.preset"),
				leftSegments: Settings.instance.get("statusLine.leftSegments"),
				rightSegments: Settings.instance.get("statusLine.rightSegments"),
			}),
		);
		expect(updateEditorTopBorder).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("invalidates UI and updates editor top border when tui.tight changes", () => {
		const invalidate = vi.fn();
		const updateEditorTopBorder = vi.fn();
		const requestRender = vi.fn();
		const controller = new SelectorController({
			ui: { invalidate, requestRender },
			updateEditorTopBorder,
		} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange("tui.tight", true);

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(updateEditorTopBorder).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
	it("refreshes the system prompt when terminal routing changes", () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const showError = vi.fn();
		const controller = new SelectorController({
			session: { refreshBaseSystemPrompt },
			showError,
		} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange("terminal.launchBackend", "system");

		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(showError).not.toHaveBeenCalled();
	});
});
