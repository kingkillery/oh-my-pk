// TypeSafe (Jev) is a judgment API, not a chat provider — POST /v1/systemone
// returns typed answers to caller-defined questions and never generates text.
// It is intentionally NOT registered in the shared ModelRegistry/AuthStorage
// catalog: every `KnownApi` transport in pi-catalog is a message/streaming
// shape, and a judgment endpoint behind a chat role would imply conversation,
// streaming, and tool-call support it does not have. Remote credentials remain
// environment-only; a live tailnet decision endpoint can also be auto-discovered
// without a credential. Nothing is written to a synced provider config file.
//
// Intended seam: bounded semantic judgments behind existing lanes — e.g. a
// `noul` gate ("does this DOM state satisfy the goal?") verifying browser-lane
// work, or a `choice` over candidate actions — with low-confidence results
// escalated to a reasoning model rather than acted on. `state` is data, not
// instructions: Jev has no adversarial resistance, so never feed it page text
// or tool output as trusted directives.

import { $env, APP_NAME } from "@pk-nerdsaver-ai/pi-utils";
import {
	discoverDecisionEndpoint,
	invalidateDecisionEndpoint,
	type DecisionEndpoint,
} from "./decision-endpoint-discovery";

export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
export const TYPESAFE_DEFAULT_MODEL_ID = "jev-1.13.0";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// OpenRouter serves the same /v1/systemone route but names the model without the patch version.
export const OPENROUTER_MODEL_ID = "jev-1.13";
export const TYPESAFE_USER_AGENT = `${APP_NAME}/typesafe`;

const RETRYABLE_STATUSES: Record<number, true> = { 429: true, 529: true };
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;

/** One question's instructions or a single criteria/level entry — the API accepts a string, object, or array. */
export type TypeSafeContent = string | Record<string, unknown> | readonly unknown[];

/** The `state` field: a string, a JSON object, or an array of strings. */
export type TypeSafeState = string | Record<string, unknown> | readonly string[];

export interface TypeSafeNoulQuestion {
	type: "noul";
	instructions: TypeSafeContent;
	criteria?: { true: TypeSafeContent; false: TypeSafeContent };
}

export interface TypeSafeChoiceQuestion {
	type: "choice";
	instructions: TypeSafeContent;
	/** Option name → description; the API returns the winning name as `choice` (max 255 options). */
	criteria: Record<string, TypeSafeContent>;
}

export interface TypeSafeScoreQuestion {
	type: "score";
	instructions: TypeSafeContent;
	/** Ordered level descriptions, low to high; 2–10 entries. */
	criteria: readonly TypeSafeContent[];
}

export type TypeSafeQuestion = TypeSafeNoulQuestion | TypeSafeChoiceQuestion | TypeSafeScoreQuestion;

export interface TypeSafeNoulAnswer {
	type: "noul";
	noul: number;
}

export interface TypeSafeChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface TypeSafeScoreAnswer {
	type: "score";
	score: number;
	probabilities: Record<string, number>;
	legend: Record<string, string>;
	confidence: number;
}

export type TypeSafeAnswer = TypeSafeNoulAnswer | TypeSafeChoiceAnswer | TypeSafeScoreAnswer;

export interface TypeSafeResponse {
	model: string;
	answers: Record<string, TypeSafeAnswer>;
	usage: { input_tokens: number; output_tokens: number };
}

export class TypeSafeApiError extends Error {
	readonly status: number;
	readonly retryable: boolean;

	constructor(status: number, body: string) {
		super(`TypeSafe API error ${status}: ${body}`);
		this.name = "TypeSafeApiError";
		this.status = status;
		this.retryable = RETRYABLE_STATUSES[status] === true;
	}
}

/**
 * Resolve the judgment API key from the environment: `TYPESAFE_API_KEY` first,
 * else `OPENROUTER_API_KEY` (OpenRouter proxies /v1/systemone). Returns
 * `undefined` when neither is set — callers should treat that as "TypeSafe
 * unavailable" and fall back.
 */
export function resolveTypeSafeApiKey(): string | undefined {
	return $env.TYPESAFE_API_KEY || $env.OPENROUTER_API_KEY || undefined;
}

/** True when only an OpenRouter key is available, so requests go through OpenRouter. */
function usesOpenRouter(): boolean {
	return !$env.TYPESAFE_API_KEY && !!$env.OPENROUTER_API_KEY;
}

export function resolveTypeSafeBaseUrl(): string {
	return $env.TYPESAFE_BASE_URL || (usesOpenRouter() ? OPENROUTER_BASE_URL : TYPESAFE_DEFAULT_BASE_URL);
}

export function resolveTypeSafeModelId(): string {
	return usesOpenRouter() ? OPENROUTER_MODEL_ID : TYPESAFE_DEFAULT_MODEL_ID;
}

async function waitForRetry(signal: AbortSignal, milliseconds: number): Promise<void> {
	signal.throwIfAborted();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onAbort = (): void => reject(signal.reason);
	const timer = setTimeout(resolve, milliseconds);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await promise;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Run one TypeSafe request with a bounded lifetime. The explicit timer is
 * cleared on every exit path; Bun's AbortSignal.timeout/any combination can
 * otherwise leave stalled requests (and test processes) alive.
 */
export async function withTypeSafeRequestTimeout<T>(
	parentSignal: AbortSignal | undefined,
	timeoutMs: number,
	request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const abortFromParent = (): void => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) abortFromParent();
	else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
	const timeout = setTimeout(
		() => controller.abort(new Error(`TypeSafe request timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);

	try {
		controller.signal.throwIfAborted();
		return await request(controller.signal);
	} finally {
		clearTimeout(timeout);
		parentSignal?.removeEventListener("abort", abortFromParent);
	}
}

export interface TypeSafeRequestOptions {
	/** Defaults to `TYPESAFE_DEFAULT_MODEL_ID`. Pin a versioned id before tuning thresholds. */
	model?: string;
	/** Overall deadline, including retries, backoff, and response-body parsing. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * Evaluate a batch of questions against one `state` via POST /v1/systemone.
 * All questions run in parallel against the same state and cannot see each
 * other's answers; question ids are caller-chosen and not sent to the model.
 * Retries 429/529 and network failures with backoff; throws TypeSafeApiError
 * for other statuses.
 */
interface SystemOneTarget {
	readonly apiKey?: string;
	readonly baseUrl: string;
	readonly decisionEndpoint?: DecisionEndpoint;
	readonly model: string;
}

function canFailOverDecisionEndpoint(error: unknown): boolean {
	if (!(error instanceof TypeSafeApiError)) return true;
	return error.status === 404 || error.status === 408 || error.status === 429 || error.status >= 500;
}

async function requestSystemOneTarget(
	target: SystemOneTarget,
	state: TypeSafeState,
	questions: Record<string, TypeSafeQuestion>,
	model: string,
	signal: AbortSignal,
): Promise<TypeSafeResponse> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"User-Agent": TYPESAFE_USER_AGENT,
	};
	if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
	const response = await fetch(`${target.baseUrl}/systemone`, {
		method: "POST",
		headers,
		body: JSON.stringify({ state, model, questions }),
		signal,
	});
	if (!response.ok) throw new TypeSafeApiError(response.status, await response.text());
	return (await response.json()) as TypeSafeResponse;
}

export async function systemOne(
	state: TypeSafeState,
	questions: Record<string, TypeSafeQuestion>,
	options: TypeSafeRequestOptions = {},
): Promise<TypeSafeResponse> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	return withTypeSafeRequestTimeout(options.signal, timeoutMs, async signal => {
		const decisionEndpoint = options.model ? undefined : await discoverDecisionEndpoint({ signal });
		const apiKey = resolveTypeSafeApiKey();
		const targets: SystemOneTarget[] = [];
		if (decisionEndpoint) {
			targets.push({
				baseUrl: decisionEndpoint.baseUrl,
				decisionEndpoint,
				model: decisionEndpoint.model,
			});
		}
		if (apiKey) {
			targets.push({
				apiKey,
				baseUrl: resolveTypeSafeBaseUrl(),
				model: options.model ?? resolveTypeSafeModelId(),
			});
		}
		if (targets.length === 0) {
			throw new Error(
				"TYPESAFE_API_KEY (or OPENROUTER_API_KEY) is not set and no live OMP decision endpoint was discovered",
			);
		}

		let lastError: unknown;
		for (const target of targets) {
			const attempts = target.decisionEndpoint ? 1 : MAX_ATTEMPTS;
			for (let attempt = 0; attempt < attempts; attempt++) {
				if (attempt > 0) await waitForRetry(signal, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
				signal.throwIfAborted();
				try {
					return await requestSystemOneTarget(target, state, questions, target.model, signal);
				} catch (error) {
					if (signal.aborted) throw signal.reason;
					lastError = error;
					const retryable = !(error instanceof TypeSafeApiError) || error.retryable;
					if (target.decisionEndpoint) {
						invalidateDecisionEndpoint(target.decisionEndpoint);
						if (!canFailOverDecisionEndpoint(error)) throw error;
						break;
					}
					if (!retryable) throw error;
				}
			}
		}
		throw lastError;
	});
}
