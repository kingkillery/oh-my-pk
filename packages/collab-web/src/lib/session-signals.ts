/**
 * What the Android shell reads off the session root.
 *
 * These flags are derived from the guest snapshot the relay already delivers.
 * `ask` and `resolve` stay in the active-tool map until the host finishes them,
 * which is the existing signal that the agent is waiting on a person.
 */

const INPUT_TOOLS: ReadonlySet<string> = new Set(["ask", "resolve"]);

export interface SessionSignalInput {
	working: boolean;
	streaming: boolean;
	activeToolNames: readonly string[];
}

export interface SessionSignals {
	working: boolean;
	needsInput: boolean;
}

export function sessionSignals(input: SessionSignalInput): SessionSignals {
	const needsInput = input.activeToolNames.some(name => INPUT_TOOLS.has(name));
	return {
		needsInput,
		working: (input.working || input.streaming) && !needsInput,
	};
}
