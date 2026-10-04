import { getKeybindings, type KeyId, matchesKey } from "@pk-nerdsaver-ai/pi-tui";

/**
 * Match the coding-agent interrupt key.
 *
 * Interactive mode installs a keybinding manager that exposes `app.interrupt`
 * globally, but some isolated component tests still run with only TUI
 * keybindings registered. In that case, fall back to raw Escape matching.
 */
export function matchesAppInterrupt(data: string): boolean {
	const keybindings = getKeybindings();
	const interruptKeys = keybindings.getKeys("app.interrupt");
	if (interruptKeys.length > 0) {
		return keybindings.matches(data, "app.interrupt");
	}
	return matchesKey(data, "escape") || matchesKey(data, "esc");
}

/** Match the generic selector cancel keybinding. */
export function matchesSelectCancel(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.cancel");
}

/** Match the generic selector up-navigation keybinding. */
export function matchesSelectUp(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.up");
}

/** Match the generic selector down-navigation keybinding. */
export function matchesSelectDown(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.down");
}

/** Match the generic selector page-up keybinding. */
export function matchesSelectPageUp(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.pageUp");
}

/** Match the generic selector page-down keybinding. */
export function matchesSelectPageDown(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.pageDown");
}

export function matchesAppExternalEditor(data: string): boolean {
	const keybindings = getKeybindings();
	const externalEditorKeys = keybindings.getKeys("app.editor.external");
	if (externalEditorKeys.length > 0) {
		return keybindings.matches(data, "app.editor.external");
	}
	return matchesKey(data, "ctrl+g");
}

function matchesEffectiveKey(data: string, key: KeyId): boolean {
	if ((key === "ctrl+enter" || key === "ctrl+return") && data.charCodeAt(0) === 10 && data.length > 1) {
		return true;
	}
	return matchesKey(data, key);
}

function matchesEffectiveKeys(data: string, keys: readonly KeyId[]): boolean {
	for (const key of keys) {
		if (matchesEffectiveKey(data, key)) return true;
	}
	return false;
}

/**
 * Match the follow-up chord (`app.message.followUp`).
 *
 * Ctrl+Enter is never a follow-up. It always inserts a newline, even when a saved
 * binding still lists it. Ctrl+Q remains the default chord.
 */
export function matchesAppFollowUp(data: string): boolean {
	if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+return")) return false;
	const keybindings = getKeybindings();
	const registered = keybindings.getDefinition("app.message.followUp") !== undefined;
	const keys = keybindings
		.getKeys("app.message.followUp")
		.filter(key => key !== "ctrl+enter" && key !== "ctrl+return");
	if (keys.length > 0) return matchesEffectiveKeys(data, keys);
	if (registered) return false;
	return matchesEffectiveKeys(data, ["ctrl+q"]);
}

/**
 * Key ids that must never act as the follow-up chord because they insert a
 * newline instead. Matched against raw input so they are ignored even when a
 * legacy settings file still lists them under `app.message.followUp`.
 */
export function matchesAppFollowUpIgnored(data: string): boolean {
	return matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+return");
}
