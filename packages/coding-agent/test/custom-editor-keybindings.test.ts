import { beforeAll, describe, expect, it, vi } from "bun:test";
import { CustomEditor } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";

describe("CustomEditor keybindings", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("inserts a newline for Ctrl, Alt, and Shift Enter and submits only with plain Enter", () => {
		const editor = new CustomEditor(getEditorTheme());
		const submitted: string[] = [];
		editor.onSubmit = text => {
			submitted.push(text);
		};
		for (const sequence of [
			"\x1b[13;5u", // Ctrl+Enter
			"\x1b[13;3u", // Alt+Enter
			"\x1b[13;2u", // Shift+Enter
			"\x1b[27;5;13~", // xterm modifyOtherKeys Ctrl+Enter
			"\x1b[27;3;13~", // xterm modifyOtherKeys Alt+Enter
			"\x1b[27;2;13~", // xterm modifyOtherKeys Shift+Enter
			"\x1b\r", // Legacy Alt+Enter
		]) {
			editor.setText("first line");
			editor.handleInput(sequence);
			expect(editor.getText()).toBe("first line\n");
		}
		expect(submitted).toEqual([]);
		editor.handleInput("\r");
		expect(submitted).toEqual(["first line"]);
	});

	it("routes the configured retry chord through handleInput", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();

		editor.setActionKeys("app.retry", ["alt+shift+r"]);
		editor.onRetry = onRetry;
		editor.handleInput("\x1bR");

		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("lets custom handlers keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const customHandler = vi.fn();

		editor.onRetry = onRetry;
		editor.setCustomKeyHandler("alt+r", customHandler);
		editor.handleInput("\x1br");

		expect(customHandler).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("lets copy-prompt remaps keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const onCopyPrompt = vi.fn();

		editor.onRetry = onRetry;
		editor.onCopyPrompt = onCopyPrompt;
		editor.setActionKeys("app.clipboard.copyPrompt", ["alt+r"]);
		editor.handleInput("\x1br");

		expect(onCopyPrompt).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});
});
