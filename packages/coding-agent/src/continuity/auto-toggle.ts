import type { Settings } from "../config/settings";

/**
 * The automatic continuity layer is a harness injection: it asks the model to
 * close a turn with a handoff the operator did not request. It is off unless
 * the operator turns it on, and simple mode never leaves it on.
 *
 * Explicit save and resume are unaffected. They run only when asked.
 */

export type AutoContinuityMode = "off" | "changed" | "always";

export interface AutoContinuityState {
	/** What the operator asked for. */
	configured: AutoContinuityMode;
	/** What will actually inject. Simple mode forces this to `off`. */
	effective: AutoContinuityMode;
	/** Persist an emitted handoff. Also forced off in simple mode. */
	autoSave: boolean;
	simpleMode: boolean;
	/** True when simple mode is suppressing a configured automatic mode. */
	suppressedBySimpleMode: boolean;
}

export function readAutoContinuity(settings: Settings): AutoContinuityState {
	const configured = settings.get("continuity.endOfTurnHandoff");
	const simpleMode = settings.get("task.simpleMode");
	const autoSave = settings.get("continuity.autoSave") && !simpleMode;
	return {
		configured,
		effective: simpleMode ? "off" : configured,
		autoSave,
		simpleMode,
		suppressedBySimpleMode: simpleMode && (configured !== "off" || settings.get("continuity.autoSave")),
	};
}

/** Whether this session will inject an automatic handoff without being asked. */
export function automaticContinuityActive(settings: Settings): boolean {
	return readAutoContinuity(settings).effective !== "off";
}

/**
 * Footer text while automatic injection is possible. Absent when the harness
 * behaves as it did before this layer, so an off state adds no chrome.
 */
export function autoContinuityIndicator(settings: Settings): string | undefined {
	const state = readAutoContinuity(settings);
	if (state.effective === "off" && !state.suppressedBySimpleMode) return undefined;
	if (state.suppressedBySimpleMode) return "continuity auto off (simple mode)";
	const cadence = state.effective === "always" ? "every turn" : "after edits";
	const save = state.autoSave ? ", saving" : "";
	return `continuity auto on (${cadence}${save})`;
}

export function describeAutoContinuity(settings: Settings): string {
	const state = readAutoContinuity(settings);
	if (state.suppressedBySimpleMode) {
		return [
			"Automatic continuity is off because simple mode is on.",
			`Configured mode is '${state.configured}', but simple mode injects nothing.`,
			"Explicit save and resume still work when you ask.",
			"Turn simple mode off, then /continuity on, to restore automatic handoffs.",
		].join(" ");
	}
	if (state.effective === "off") {
		return "Automatic continuity is off. The harness will not inject a handoff unless you ask. /continuity on enables it after edits; /continuity always enables it every turn.";
	}
	const cadence = state.effective === "always" ? "after every completed turn" : "after a turn that edits files";
	const save = state.autoSave
		? "Emitted handoffs are also saved automatically."
		: "Showing a handoff does not save it.";
	return `Automatic continuity is on (${cadence}). ${save} /continuity off restores the previous behavior.`;
}
