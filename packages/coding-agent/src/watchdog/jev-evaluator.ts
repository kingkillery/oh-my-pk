/**
 * System 1 Jev Evaluator
 *
 * Sends a compact state snapshot to TypeSafe Jev (direct, OpenRouter, or AI Gateway)
 * with 3 parallel typed questions (noul, score, choice) in a single forward pass.
 *
 * Critical requirement: If unconfigured, disabled, or if the network/API fails,
 * this function MUST return undefined gracefully without throwing or blocking.
 */

import { $env, logger } from "@pk-nerdsaver-ai/pi-utils";
import { systemOne, type TypeSafeQuestion } from "../lib/typesafe-http";
import type { BlockerType, WatchdogConfig, WatchdogEvaluation } from "./types";

interface JevApiResponse {
	readonly answers?: {
		readonly is_thrashing?: {
			readonly type?: string;
			readonly noul?: number;
			readonly probability?: number;
		};
		readonly stall_severity?: {
			readonly type?: string;
			readonly score?: number;
			readonly confidence?: number;
		};
		readonly blocker_type?: {
			readonly type?: string;
			readonly choice?: string;
			readonly confidence?: number;
		};
	};
	readonly provider?: string;
	readonly model?: string;
}

const WATCHDOG_QUESTIONS = {
	is_thrashing: {
		type: "noul",
		instructions:
			"The agent is repeating failed actions, cycling between the same files or errors, or making no observable progress towards the objective.",
	},
	stall_severity: {
		type: "score",
		instructions: "Assess the severity of the agent stalling or wedging.",
		criteria: [
			"nominal: normal forward progress or standard exploration",
			"hesitant: single error recovery or small exploratory detour",
			"looping: repeated failures on the same target or syntax/tag thrashing for 2-3 actions",
			"fatal: completely wedged in an infinite loop, repeating identical failed commands, or unrecoverable error",
		],
	},
	blocker_type: {
		type: "choice",
		instructions: "Primary failure mode if the agent is struggling.",
		criteria: {
			none: "Agent is progressing normally",
			syntax_or_tag_mismatch: "Repeated edit snapshot tag mismatches or syntax parse failures",
			command_failure_loop: "Bash command failing repeatedly with the same exit code or error output",
			missing_dependency_or_path: "Attempting to access non-existent files or uninstalled packages repeatedly",
			semantic_confusion: "Drifting off task or misunderstanding tool expectations",
		},
	},
} satisfies Record<string, TypeSafeQuestion>;

export async function evaluateAgentTelemetry(
	state: string,
	config: WatchdogConfig = {},
): Promise<WatchdogEvaluation | undefined> {
	// 1. Check if explicitly disabled
	if (config.enabled === false) {
		return undefined;
	}

	// 2. Check for mock provider (used for zero-network testing)
	if (config.provider === "mock") {
		return undefined;
	}

	const timeoutMs = config.timeoutMs ?? 2500;
	const startMs = performance.now();

	// Prefer the shared SystemOne client when no explicit watchdog transport was
	// requested. It auto-discovers a live Clef decision endpoint on Tailscale,
	// then falls back to TypeSafe/OpenRouter when configured.
	if (!config.baseUrl && !config.apiKey && !config.provider) {
		try {
			const data = await systemOne(state, WATCHDOG_QUESTIONS, { timeoutMs });
			const thrashing = data.answers.is_thrashing;
			const severity = data.answers.stall_severity;
			const blocker = data.answers.blocker_type;
			return {
				isThrashing: thrashing?.type === "noul" ? thrashing.noul : 0,
				stallSeverity: severity?.type === "score" ? severity.score : 0,
				blockerType: (blocker?.type === "choice" ? blocker.choice : "none") as BlockerType,
				confidence:
					severity?.type === "score" ? severity.confidence : blocker?.type === "choice" ? blocker.confidence : 1,
				latencyMs: Math.round(performance.now() - startMs),
				provider: /(^|\/)clef(?:-|$)/i.test(data.model)
					? "clef"
					: $env.OPENROUTER_API_KEY && !$env.TYPESAFE_API_KEY
						? "openrouter"
						: "typesafe",
			};
		} catch (error) {
			logger.debug(
				`[Watchdog] Shared SystemOne path unavailable: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (!$env.AI_GATEWAY_API_KEY) return undefined;
		}
	}

	// 3. Resolve API key and endpoint
	const apiKey = config.apiKey || $env.TYPESAFE_API_KEY || $env.OPENROUTER_API_KEY || $env.AI_GATEWAY_API_KEY;

	// If no API key or endpoint configured, fail silent immediately
	if (!apiKey && !config.baseUrl) {
		return undefined;
	}

	const isExplicitOpenRouter =
		config.provider === "openrouter" || Boolean($env.OPENROUTER_API_KEY && !$env.TYPESAFE_API_KEY);

	const isVercelGateway = Boolean($env.AI_GATEWAY_API_KEY) && !$env.TYPESAFE_API_KEY && !$env.OPENROUTER_API_KEY;

	let endpoint = config.baseUrl;
	let model = "jev-latest";

	if (!endpoint) {
		if (isVercelGateway) {
			endpoint = "https://ai-gateway.vercel.sh/v1/evaluate";
			model = "typesafe-ai/jev";
		} else if (isExplicitOpenRouter) {
			endpoint = "https://openrouter.ai/api/alpha/decisions";
			model = "typesafe/jev-1.13";
		} else {
			endpoint = "https://api.typesafe.ai/v1/systemone";
			model = "jev-latest";
		}
	}

	const requestBody = {
		model,
		state,
		questions: WATCHDOG_QUESTIONS,
	};

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		const response = await fetch(endpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: controller.signal,
		});

		if (!response.ok) {
			logger.debug(`[Watchdog] Jev evaluation non-200: ${response.status} ${response.statusText}`);
			return undefined;
		}

		const data = (await response.json()) as JevApiResponse;
		const latencyMs = Math.round(performance.now() - startMs);

		const answers = data.answers ?? {};
		const isThrashing = answers.is_thrashing?.noul ?? answers.is_thrashing?.probability ?? 0;
		const stallSeverity = answers.stall_severity?.score ?? 0;
		const blockerType = (answers.blocker_type?.choice ?? "none") as BlockerType;
		const confidence = answers.stall_severity?.confidence ?? answers.blocker_type?.confidence ?? 1.0;

		return {
			isThrashing,
			stallSeverity,
			blockerType,
			confidence,
			latencyMs,
			provider: data.provider ?? (isExplicitOpenRouter ? "openrouter" : "typesafe"),
		};
	} catch (error) {
		// Never let a network or evaluation error leak to the caller
		logger.debug(
			`[Watchdog] Evaluation aborted or failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
