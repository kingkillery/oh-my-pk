/**
 * System 1 Watchdog Types
 *
 * Types for out-of-band telemetry capture, System 1 Jev evaluation,
 * and deterministic arbitration policies.
 */

export interface ToolActionRecord {
	readonly tool: string;
	readonly target?: string;
	readonly status: "success" | "error";
	readonly errorMessage?: string;
	readonly durationMs: number;
}

export type BlockerType =
	| "none"
	| "syntax_or_tag_mismatch"
	| "command_failure_loop"
	| "missing_dependency_or_path"
	| "semantic_confusion"
	| (string & {});

export interface WatchdogEvaluation {
	readonly isThrashing: number; // Noul: probability 0.00 - 1.00
	readonly stallSeverity: number; // Score: 0.0 - 3.0
	readonly blockerType: BlockerType; // Choice
	readonly confidence: number;
	readonly latencyMs: number;
	readonly provider?: string;
}

export type WatchdogAction =
	| { readonly action: "pass" }
	| {
			readonly action: "inject_hint";
			readonly hint: string;
			readonly blockerType: BlockerType;
			readonly severity: number;
			readonly thrashing: number;
	  }
	| {
			readonly action: "tripwire_abort";
			readonly reason: string;
			readonly severity: number;
			readonly thrashing: number;
			readonly blockerType: BlockerType;
	  };

export interface WatchdogConfig {
	readonly enabled?: boolean;
	readonly provider?: "auto" | "openrouter" | "typesafe" | "mock";
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly abortSeverityThreshold?: number; // default: 2.5
	readonly abortThrashThreshold?: number; // default: 0.85
	readonly hintSeverityThreshold?: number; // default: 1.6
	readonly hintThrashThreshold?: number; // default: 0.60
	readonly timeoutMs?: number; // default: 2500
}
