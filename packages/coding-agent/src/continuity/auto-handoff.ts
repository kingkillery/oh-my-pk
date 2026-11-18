import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";

/**
 * Automatic end-of-turn "project notebook" handoffs.
 *
 * The agent ends a turn with a six-section handoff only when the operator opts in
 * through `continuity.endOfTurnHandoff` (default `off`, so behavior is unchanged).
 * Emitting a handoff and persisting it canonically are deliberately separate
 * settings: `continuity.autoSave` never turns itself on, and neither setting is
 * consulted by anything that switches sessions or cancels jobs.
 */
export const END_OF_TURN_HANDOFF_MODES = ["off", "changed", "always"] as const;

export type EndOfTurnHandoffMode = (typeof END_OF_TURN_HANDOFF_MODES)[number];

/** Tools whose use counts as meaningful progress for `changed` mode. */
const MUTATING_TOOLS: Readonly<Record<string, true>> = {
	write: true,
	edit: true,
	ast_edit: true,
	apply_patch: true,
	multi_edit: true,
};

/** The six headings every handoff carries, in canonical order. */
export const HANDOFF_SECTIONS = [
	"Objective",
	"Current State",
	"Key Context",
	"Next Steps",
	"Validation",
	"Blockers",
] as const;

/**
 * Skill names accepted as a handoff trailer.
 *
 * The trailer is a bare skill reference emitted as text, so it must not be able
 * to smuggle a URL, a path, or a second directive into the turn.
 */
const TRAILER_SKILL_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Normalize a configured trailer skill into the text the model should emit.
 *
 * Accepts a bare name (`explain-simply`) or a full `skill://` URI, and returns
 * the `skill://<name>` form. Returns an empty string when the value is unusable,
 * so a bad setting degrades to "no trailer" instead of injecting stray text.
 */
export function normalizeTrailerSkill(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const name = trimmed.startsWith("skill://") ? trimmed.slice("skill://".length) : trimmed;
	if (!TRAILER_SKILL_PATTERN.test(name)) return "";
	return `skill://${name}`;
}

export interface HandoffEmissionInput {
	/** Configured mode; `off` disables automatic handoffs entirely. */
	readonly mode: EndOfTurnHandoffMode;
	/** True while executing the continuation turn this policy already requested. */
	readonly stopHookActive: boolean;
	/** Settled turn being considered. */
	readonly turnId: number;
	/** Turn that last received an automatic handoff, if any. */
	readonly lastEmittedTurnId: number | undefined;
	/** Messages of the settled turn. */
	readonly messages: readonly AgentMessage[];
}

/**
 * Decide whether the settled turn should end with an automatic handoff.
 *
 * One continuation turn per settle, never chained: a turn that this policy already
 * extended reports `stopHookActive`, and re-entering there would loop forever.
 */
export function shouldEmitHandoff(input: HandoffEmissionInput): boolean {
	if (input.mode === "off") return false;
	if (input.stopHookActive) return false;
	if (input.lastEmittedTurnId === input.turnId) return false;
	if (input.mode === "always") return true;
	return turnChangedWorkspace(input.messages);
}

/** Whether the settled turn used a tool that plausibly changed durable state. */
export function turnChangedWorkspace(messages: readonly AgentMessage[]): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const content = message.content;
		if (!Array.isArray(content)) return false;
		return content.some(part => part.type === "toolCall" && MUTATING_TOOLS[part.name] === true);
	}
	return false;
}

/**
 * Instruction that makes the model close its turn with a handoff.
 *
 * It is a request for text, not a write: nothing here touches a vault, a session,
 * or a running job.
 */
export function handoffDirective(mode: EndOfTurnHandoffMode, trailerSkill = ""): string {
	const scope =
		mode === "changed"
			? "Focus on what changed since the previous handoff."
			: "Cover the work so far in this session.";
	const lines = [
		"Close this turn with a project-notebook handoff so the work can be resumed without this transcript.",
		scope,
		"Wrap it in exactly one <handoff-prompt> ... </handoff-prompt> block and use these six sections,",
		"in this order, as `## N. Title`:",
		...HANDOFF_SECTIONS.map((section, index) => `${index + 1}. ${section}`),
		'Write "none known" for a section with nothing to report.',
		"Record only what is verifiable now, and label anything recalled from earlier notes as historical.",
		"Do not start new work, do not write to a vault, and do not change settings.",
	];
	const trailer = normalizeTrailerSkill(trailerSkill);
	if (trailer) {
		lines.push(
			`After the closing </handoff-prompt> tag, emit the line \`${trailer}\` and nothing else on it.`,
			"The trailer sits outside the handoff block and is not part of the record.",
		);
	}
	return lines.join("\n");
}
