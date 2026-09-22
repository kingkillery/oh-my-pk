/**
 * Deterministic Arbitrator
 *
 * Code owns the action: evaluates calibrated System 1 measurements (probabilities, scores)
 * against deterministic policy thresholds.
 *
 * - Level 0 (< 1.6): Silent pass. Agent continues completely uninterrupted.
 * - Level 1 (1.6 - 2.49): Injects a targeted non-interrupting hint for the next turn boundary.
 * - Level 2 (>= 2.5 or thrashing >= 0.85): Tripwire circuit breaker trips.
 */

import type { BlockerType, WatchdogAction, WatchdogConfig, WatchdogEvaluation } from "./types";

export interface TargetContext {
	readonly tool?: string;
	readonly target?: string;
}

export function buildSyntheticHint(blockerType: BlockerType, context?: TargetContext): string {
	const targetPart = context?.target ? ` on "${context.target}"` : "";

	switch (blockerType) {
		case "syntax_or_tag_mismatch":
			return `[Watchdog Notice]: Consecutive edit tag mismatches or syntax failures detected${targetPart}. Use the read tool on the exact line range to refresh the snapshot tag before editing again.`;
		case "command_failure_loop":
			return `[Watchdog Notice]: Repeated command failure detected${targetPart}. Re-verify arguments, directory path, and prerequisites instead of re-running the same command.`;
		case "missing_dependency_or_path":
			return `[Watchdog Notice]: Repeated missing path or dependency errors detected${targetPart}. Inspect the workspace using glob or read before assuming existence.`;
		case "semantic_confusion":
			return `[Watchdog Notice]: Repetitive non-productive tool cycling detected. Re-read the assignment instructions and ground on existing files before taking further actions.`;
		default:
			return `[Watchdog Notice]: High failure repetition detected${targetPart}. Re-evaluate assumptions before repeating the action.`;
	}
}

export function arbitrateHealth(
	evaluation: WatchdogEvaluation | undefined,
	config: WatchdogConfig = {},
	context?: TargetContext,
): WatchdogAction {
	if (!evaluation) {
		return { action: "pass" };
	}

	const abortSeverity = config.abortSeverityThreshold ?? 2.5;
	const abortThrash = config.abortThrashThreshold ?? 0.85;
	const hintSeverity = config.hintSeverityThreshold ?? 1.6;
	const hintThrash = config.hintThrashThreshold ?? 0.6;

	const { stallSeverity, isThrashing, blockerType } = evaluation;

	// Level 2: Hard Circuit Breaker (Tripwire Abort)
	if (stallSeverity >= abortSeverity || isThrashing >= abortThrash) {
		const thrashPercent = Math.round(isThrashing * 100);
		const targetDesc = context?.target ? ` on ${context.target}` : "";
		return {
			action: "tripwire_abort",
			blockerType,
			severity: stallSeverity,
			thrashing: isThrashing,
			reason: `System 1 Watchdog: Agent wedged (${blockerType}${targetDesc}, severity: ${stallSeverity.toFixed(1)}, thrash: ${thrashPercent}%)`,
		};
	}

	// Level 1: Progressive Guidance (Inject Hint)
	if (stallSeverity >= hintSeverity || isThrashing >= hintThrash) {
		return {
			action: "inject_hint",
			hint: buildSyntheticHint(blockerType, context),
			blockerType,
			severity: stallSeverity,
			thrashing: isThrashing,
		};
	}

	// Level 0: Silent Pass
	return { action: "pass" };
}
