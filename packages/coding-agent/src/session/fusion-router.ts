/**
 * Fusion dynamic mid-session routing (Devin-Fusion style).
 *
 * At each compaction boundary the messages-segment cache is already
 * invalidated by the history rewrite, so switching the main model there is
 * marginal-cost (only the tools/system segment re-prefills). A lightweight
 * classifier reads the
 * compaction summary and picks the tier for the next stretch:
 *
 * - Binary mode (no pool): `cheap` (the configured `fusion.compactModel`) for
 *   settled mechanical work, `frontier` (the session's original model) when the
 *   work needs strong reasoning.
 * - Pool mode (`fusion.modelPool` has 2+ entries): the classifier picks a tier
 *   number from the pool, where tier 1 = most powerful … 5 = least intelligent.
 */
import { type Api, completeSimple, type Model, type ServiceTier } from "@pk-nerdsaver-ai/pi-ai";
import { modelsAreEqual } from "@pk-nerdsaver-ai/pi-catalog/models";
import { logger, prompt } from "@pk-nerdsaver-ai/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { systemOne, type TypeSafeAnswer, type TypeSafeChoiceQuestion } from "../lib/typesafe-http";
import decisionRoutePrompt from "../prompts/fusion/decision-route.md" with { type: "text" };
import routeClassifierPrompt from "../prompts/fusion/route-classifier.md" with { type: "text" };
import routeClassifierPoolPrompt from "../prompts/fusion/route-classifier-pool.md" with { type: "text" };

export type FusionRoute = "cheap" | "frontier" | number;

/** Whether the given mode string indicates explicit token savings mode. */
export function isTokenSavingsFusionMode(mode: string | undefined): boolean {
	return mode === "token-savings" || mode === "savings";
}

/** Whether fusion token savings mode is active on the given settings. */
export function isTokenSavingsFusionActive(settings: { get(key: string): unknown }): boolean {
	return (
		settings.get("fusion.enabled") === true &&
		isTokenSavingsFusionMode(settings.get("fusion.mode") as string | undefined)
	);
}

export interface FusionAutoRouteState {
	routingDisabled: boolean;
	baseModel: Model | undefined;
	lastAutoModel: Model | undefined;
	currentModel: Model | undefined;
}

/**
 * Whether the main session is on the cheaper route Fusion selected itself.
 * Only failures in that stretch count toward failure-streak escalation; on the
 * frontier model or a manual choice they would pre-load a later streak.
 */
export function isFusionAutoDowngradedRoute(state: FusionAutoRouteState): boolean {
	const { routingDisabled, baseModel, lastAutoModel, currentModel } = state;
	if (routingDisabled || !baseModel || !lastAutoModel || !currentModel) return false;
	return !modelsAreEqual(baseModel, currentModel) && modelsAreEqual(lastAutoModel, currentModel);
}

/**
 * Tools that only inspect, search, edit files, or update session bookkeeping.
 * When one of these tools succeeds (`isError === false`) in the middle of a
 * failure streak (e.g. `bash` test fails -> `read` -> `edit` -> `bash` test fails),
 * it does not prove that the prior verification failure was resolved and must
 * not reset `#fusionToolFailureStreak`. Only a passing verification/execution
 * tool (`bash`, `eval`, etc.) or clean turn completion resets the streak.
 */
const FUSION_STREAK_NEUTRAL_SUCCESS_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"glob",
	"ast_grep",
	"lsp",
	"search_tool_bm25",
	"context_oracle",
	"work_context",
	"edit",
	"write",
	"ast_edit",
	"notebook_edit",
	"resolve",
	"todo",
	"goal",
	"recall",
	"retain",
	"reflect",
	"session_memory",
	"memory_edit",
	"continuity",
	"activity",
]);

/**
 * Whether a successful (`isError: false`) tool result is streak-neutral —
 * i.e. an intermediate inspection, edit, or bookkeeping step that preserves
 * an active failure streak rather than resetting it to zero.
 * Pure — exported for tests.
 */
export function isFusionStreakNeutralToolSuccess(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return FUSION_STREAK_NEUTRAL_SUCCESS_TOOLS.has(toolName);
}

/**
 * Compute the next `#fusionToolFailureStreak` value after a `toolResult`
 * message completes.
 * - Outside an auto-downgraded Fusion route, the streak is always `0`.
 * - On an auto-downgraded route:
 *   - Any tool error (`isError === true`) increments the streak.
 *   - A passing verification/execution tool (`!isFusionStreakNeutralToolSuccess(toolName)`)
 *     resets the streak to `0`.
 *   - A passing inspection/edit/bookkeeping tool (`read`, `grep`, `edit`, etc.)
 *     preserves the current streak so `bash (fail) -> read (ok) -> edit (ok) -> bash (fail)`
 *     accumulates across failed verification cycles.
 * Pure — exported for tests.
 */
export function nextFusionToolFailureStreak(options: {
	currentStreak: number;
	isError: boolean;
	toolName?: string;
	autoDowngradedRoute: boolean;
}): number {
	if (!options.autoDowngradedRoute) return 0;
	if (options.isError) return options.currentStreak + 1;
	if (isFusionStreakNeutralToolSuccess(options.toolName)) return options.currentStreak;
	return 0;
}

/** One tier of the routing pool. Tier 1 = most powerful … 5 = least intelligent. */
export interface FusionPoolTier {
	tier: number;
	selector: string;
}

export const FUSION_POOL_MIN_TIER = 1;
export const FUSION_POOL_MAX_TIER = 5;

const ROUTE_SYSTEM_PROMPT = prompt.render(routeClassifierPrompt);
const ROUTE_MARKER_RE = /<route>\s*(cheap|frontier|[1-5])\s*<\/route>/i;
const ROUTE_MAX_TOKENS = 16;
const ROUTE_REASONING_SAFE_MAX_TOKENS = 1024;
const ROUTE_SUMMARY_LIMIT = 8_000;

/** Parse the classifier's `<route>…</route>` marker. Exported for tests. */
export function parseFusionRoute(text: string): FusionRoute | null {
	const match = ROUTE_MARKER_RE.exec(text);
	if (!match) return null;
	const value = match[1].toLowerCase();
	if (value === "cheap" || value === "frontier") return value;
	return Number.parseInt(value, 10);
}

/**
 * Parse `fusion.modelPool` entries of the form `"<tier>=<selector>"`.
 * Invalid entries are dropped; duplicate tiers keep the last assignment.
 * Result is sorted by tier ascending (strongest first).
 */
export function parseFusionPoolEntries(entries: readonly string[]): FusionPoolTier[] {
	const byTier = new Map<number, string>();
	for (const entry of entries) {
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		const tier = Number.parseInt(entry.slice(0, eq).trim(), 10);
		const selector = entry.slice(eq + 1).trim();
		if (!Number.isInteger(tier) || tier < FUSION_POOL_MIN_TIER || tier > FUSION_POOL_MAX_TIER) continue;
		if (!selector) continue;
		byTier.set(tier, selector);
	}
	return Array.from(byTier.entries(), ([tier, selector]) => ({ tier, selector })).sort((a, b) => a.tier - b.tier);
}

/** Serialize pool tiers back to `fusion.modelPool` entries. */
export function formatFusionPoolEntries(pool: readonly FusionPoolTier[]): string[] {
	return [...pool].sort((a, b) => a.tier - b.tier).map(({ tier, selector }) => `${tier}=${selector}`);
}

/**
 * Map the main-model route to a sidekick tier: `strong` when the classifier
 * judged the next stretch hard (`frontier`, or the strongest configured pool
 * tier), `base` otherwise. Pure — exported for tests.
 */
export function resolveSidekickRoute(route: FusionRoute, pool: readonly FusionPoolTier[]): "strong" | "base" {
	if (route === "frontier") return "strong";
	if (typeof route === "number" && pool.length > 0 && route === pool[0].tier) return "strong";
	return "base";
}

/**
 * Predicate: does the compaction switch path have *any* work to do this
 * compaction — main-model target, dynamic main routing, or independent sidekick
 * re-tiering? Extracted as a pure helper so the early-return contract is
 * unit-testable in isolation from `AgentSession`.
 */
export function shouldRunFusionCompactionSwitch(options: {
	hasCompactSelector: boolean;
	poolMode: boolean;
	dynamicRouting: boolean;
	hasSidekickStrongSelector: boolean;
	pool: readonly FusionPoolTier[];
}): boolean {
	if (options.hasCompactSelector) return true;
	if (options.poolMode) return true;
	if (options.dynamicRouting && options.pool.length >= 2) return true;
	if (options.dynamicRouting && options.hasSidekickStrongSelector) return true;
	return false;
}

/**
 * Fallback used when the classifier is unavailable or unparseable.
 * Binary mode: preserve the static one-shot ramp-down to `fusion.compactModel`
 * (never let a broken classifier disable the configured downgrade), once per
 * session. Pool mode: no fallback — the pool is classifier-driven, and silently
 * dropping to the weakest tier would be an unrequested quality cut.
 * Pure — exported for tests.
 */
export function resolveEffectiveFusionRoute(
	route: FusionRoute | null,
	options: { alreadySwitched: boolean; pool?: readonly FusionPoolTier[] },
): FusionRoute | undefined {
	if (route !== null) return route;
	if (options.alreadySwitched) return undefined;
	if ((options.pool?.length ?? 0) >= 2) return undefined;
	return "cheap";
}

function getRouteModel(
	registry: ModelRegistry,
	settings: Settings,
): { model: Model<Api>; serviceTier?: ServiceTier } | undefined {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return undefined;
	const resolved = resolveRoleSelection(["smol", "title", "commit"], settings, availableModels, registry);
	return resolved?.model ? { model: resolved.model, serviceTier: resolved.serviceTier } : undefined;
}

/** Render the pool-mode classifier system prompt. Exported for tests. */
export function renderPoolClassifierPrompt(pool: readonly FusionPoolTier[]): string {
	return prompt.render(routeClassifierPoolPrompt, {
		tiers: pool.map(({ tier, selector }) => ({ tier, descriptor: selector })),
	});
}

/**
 * Classify which tier should drive the post-compaction stretch.
 * With a `pool` (2+ tiers) the classifier picks a tier number from it;
 * otherwise it makes the binary cheap/frontier call.
 * Returns `null` when no classifier model is available or the call fails —
 * callers fall back to their static behavior (see {@link resolveEffectiveFusionRoute}).
 */
export async function classifyFusionRoute(
	summary: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	pool?: readonly FusionPoolTier[],
): Promise<FusionRoute | null> {
	const trimmed = summary.trim();
	if (!trimmed) return null;
	const poolMode = (pool?.length ?? 0) >= 2;
	const routeSelection = getRouteModel(registry, settings);
	const model = routeSelection?.model;
	if (!model) {
		logger.debug("fusion-router: no classifier model available");
		return null;
	}
	try {
		const maxTokens = model.reasoning ? ROUTE_REASONING_SAFE_MAX_TOKENS : ROUTE_MAX_TOKENS;
		const systemPrompt = poolMode && pool ? renderPoolClassifierPrompt(pool) : ROUTE_SYSTEM_PROMPT;
		const response = await completeSimple(
			model,
			{
				systemPrompt: [systemPrompt],
				messages: [
					{
						role: "user",
						content: trimmed.slice(0, ROUTE_SUMMARY_LIMIT),
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: registry.resolver(model, sessionId),
				maxTokens,
				disableReasoning: true,
				serviceTier: routeSelection?.serviceTier,
			},
		);
		if (response.stopReason === "error") {
			logger.warn("fusion-router: classifier response error", { errorMessage: response.errorMessage });
			return null;
		}
		const text = response.content.map(block => (block.type === "text" ? block.text : "")).join(" ");
		const route = parseFusionRoute(text);
		if (route === null) {
			logger.debug("fusion-router: unparseable classifier output", { text: text.slice(0, 200) });
			return null;
		}
		// Cross-mode answers are invalid: a tier number without a pool, a listed
		// tier that isn't in the pool, or cheap/frontier while in pool mode.
		if (typeof route === "number") {
			if (!poolMode || !pool?.some(t => t.tier === route)) return null;
		} else if (poolMode) {
			return null;
		}
		return route;
	} catch (err) {
		logger.warn("fusion-router: classifier failed", { error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}

/** Below this the decision model is treated as unsure and the classifier runs instead. */
export const DECISION_ROUTE_MIN_CONFIDENCE = 0.6;

/** Cap on the decision-model state so a long window cannot dominate the request. */
const DECISION_ROUTE_STATE_LIMIT = 12_000;

const DECISION_ROUTE_INSTRUCTIONS = prompt.render(decisionRoutePrompt);

export interface DecisionRouteMessage {
	role?: string;
	content?: unknown;
}

/** Text of one message, ignoring non-text blocks. Exported for tests. */
export function decisionRouteMessageText(message: DecisionRouteMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if ("text" in part && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

/**
 * State for a decision-model route judgment: the compaction summary, then the
 * trailing `windowPercent` of the conversation the summary does not yet cover.
 * Pure — exported for tests.
 */
export function buildDecisionRouteState(
	summary: string,
	messages: readonly DecisionRouteMessage[],
	windowPercent: number,
): string {
	const rendered = messages
		.map(message => {
			const text = decisionRouteMessageText(message).trim();
			if (!text) return "";
			const role = typeof message.role === "string" ? message.role : "message";
			return `${role}: ${text}`;
		})
		.filter(line => line.length > 0);
	const percent = Number.isFinite(windowPercent) ? Math.min(100, Math.max(0, windowPercent)) : 0;
	const windowCount =
		percent === 0 || rendered.length === 0 ? 0 : Math.max(1, Math.ceil((rendered.length * percent) / 100));
	const window = windowCount === 0 ? "" : rendered.slice(-windowCount).join("\n\n");
	const state = window
		? `Summary:\n${summary.trim()}\n\nRecent conversation:\n${window}`
		: `Summary:\n${summary.trim()}`;
	return state.length <= DECISION_ROUTE_STATE_LIMIT ? state : state.slice(-DECISION_ROUTE_STATE_LIMIT);
}

/** Choice question over the pool tiers. Exported for tests. */
export function decisionRouteQuestion(pool: readonly FusionPoolTier[]): TypeSafeChoiceQuestion {
	const criteria: Record<string, string> = {};
	for (const { tier, selector } of pool) {
		criteria[String(tier)] =
			`Tier ${tier} (${selector}): ${tier} = most powerful, higher numbers are cheaper and less capable.`;
	}
	return { type: "choice", instructions: DECISION_ROUTE_INSTRUCTIONS, criteria };
}

/**
 * Map a decision-model answer to a pool tier. Anything other than a confident
 * choice of a listed tier is `null`, which tells the caller to fall back to the
 * classifier. Pure — exported for tests.
 */
export function parseDecisionRouteAnswer(
	answer: TypeSafeAnswer | undefined,
	pool: readonly FusionPoolTier[],
	minConfidence = DECISION_ROUTE_MIN_CONFIDENCE,
): number | null {
	if (answer?.type !== "choice") return null;
	if (answer.confidence < minConfidence) return null;
	const tier = Number.parseInt(answer.choice, 10);
	if (!pool.some(entry => entry.tier === tier)) return null;
	return tier;
}

export interface DecisionRouteClient {
	judge(state: string, question: TypeSafeChoiceQuestion, signal?: AbortSignal): Promise<TypeSafeAnswer | undefined>;
}

/** The live decision model. Separated so tests can substitute a stub. */
export function liveDecisionRouteClient(): DecisionRouteClient {
	return {
		async judge(state, question, signal) {
			const response = await systemOne(state, { route: question }, { signal });
			return response.answers.route;
		},
	};
}

/**
 * Pick a fusion-pool tier through the decision model. Returns `null` when the
 * decision model is unavailable, fails, or is not confident enough — callers
 * then run the chat classifier, so a missing endpoint never disables routing.
 */
export async function classifyFusionRouteViaDecision(
	summary: string,
	messages: readonly DecisionRouteMessage[],
	pool: readonly FusionPoolTier[],
	windowPercent: number,
	options: { client?: DecisionRouteClient; signal?: AbortSignal } = {},
): Promise<number | null> {
	if (pool.length < 2 || !summary.trim()) return null;
	const client = options.client ?? liveDecisionRouteClient();
	try {
		const state = buildDecisionRouteState(summary, messages, windowPercent);
		const answer = await client.judge(state, decisionRouteQuestion(pool), options.signal);
		const tier = parseDecisionRouteAnswer(answer, pool);
		if (tier === null) logger.debug("fusion-router: decision model declined to route");
		return tier;
	} catch (err) {
		logger.warn("fusion-router: decision model unavailable", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
export const DEFAULT_FUSION_TOKEN_SAVINGS_MIN_CACHE_CONTEXT_TOKENS = 16_000;
export const DEFAULT_FUSION_TOKEN_SAVINGS_CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_FUSION_TOKEN_SAVINGS_AMORTIZATION_CALLS = 2;
export const DEFAULT_FUSION_TOKEN_SAVINGS_STICKY_MAX_CALLS = 2;

/**
 * Per-model prompt prefix watermark used to estimate warm vs. uncached delta
 * tokens across intra-turn and inter-turn `token-savings` transitions.
 */
export interface FusionModelPrefixWatermark {
	cachedTokens: number;
	lastUsedAt: number;
}

export interface FusionWarmPrefixEstimate {
	withinTtl: boolean;
	warmTokens: number;
	uncachedDeltaTokens: number;
}

export interface FusionTokenSavingsSwitchDecision {
	shouldSwitch: boolean;
	reason: "small-context" | "zero-cost-fallback" | "cache-break-even-met" | "cache-break-even-not-met";
	horizonCalls: number;
	defaultHorizonCostUsd?: number;
	taskHorizonCostUsd?: number;
	defaultUncachedDeltaTokens: number;
	taskUncachedDeltaTokens: number;
}

export interface FusionTokenSavingsTurnStartDecision {
	action: "noop" | "manual-override" | "already-default" | "restore-default" | "keep-sticky-task";
	reason:
		| "not-switched"
		| "routing-disabled"
		| "manual-override"
		| "escalated-or-already-default"
		| "mode-inactive"
		| "ttl-expired"
		| "small-context"
		| "sticky-short-tail"
		| "tail-amortized"
		| "sticky-default-cold";
}

export function getFusionModelWatermarkKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Compute how many tokens of `currentContextTokens` are still warm in a
 * model's provider prefix cache vs. must be cold-prefilled as an unseen delta.
 * Pure — exported for tests.
 */
export function computeFusionWarmPrefixTokens(options: {
	currentContextTokens: number;
	watermark?: FusionModelPrefixWatermark;
	now: number;
	cacheTtlMs?: number;
}): FusionWarmPrefixEstimate {
	const total = Math.max(0, Math.floor(options.currentContextTokens));
	const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_FUSION_TOKEN_SAVINGS_CACHE_TTL_MS;
	const watermark = options.watermark;
	const withinTtl =
		watermark !== undefined &&
		cacheTtlMs > 0 &&
		options.now >= watermark.lastUsedAt &&
		options.now - watermark.lastUsedAt < cacheTtlMs;
	const warmTokens = withinTtl ? Math.min(total, Math.max(0, Math.floor(watermark.cachedTokens))) : 0;
	return {
		withinTtl,
		warmTokens,
		uncachedDeltaTokens: Math.max(0, total - warmTokens),
	};
}

/**
 * Estimate input + prompt-cache USD cost across `horizonCalls` steps starting
 * at `currentContextTokens` when `warmTokens` are already cached:
 * - Call 1 pays `cacheRead` on `warmTokens` and `cacheWrite` (if > 0, else
 *   `input`) on the unseen `uncachedDeltaTokens`.
 * - Calls `2..horizonCalls` pay `cacheRead` (if prompt caching is supported,
 *   else `input`) on `currentContextTokens`.
 * Pure — exported for tests.
 */
export function estimateFusionPrefixHorizonCostUsd(options: {
	cost: Model<Api>["cost"];
	currentContextTokens: number;
	warmTokens: number;
	horizonCalls: number;
}): number {
	const total = Math.max(0, Math.floor(options.currentContextTokens));
	const warm = Math.min(total, Math.max(0, Math.floor(options.warmTokens)));
	const uncachedDelta = Math.max(0, total - warm);
	const calls = Math.max(1, Math.floor(options.horizonCalls));
	const { input, cacheRead, cacheWrite } = options.cost;
	const supportsPromptCache = cacheRead > 0 || cacheWrite > 0;
	const warmReadRate = supportsPromptCache ? (cacheRead > 0 ? cacheRead : input) : input;
	const uncachedPrefillRate = cacheWrite > 0 ? cacheWrite : input;

	const firstCallCostPerMillion = warm * warmReadRate + uncachedDelta * uncachedPrefillRate;
	const subsequentCallsCostPerMillion = (calls - 1) * total * warmReadRate;
	return (firstCallCostPerMillion + subsequentCallsCostPerMillion) / 1_000_000;
}

/**
 * Decide whether `token-savings` should switch from `defaultModel` to
 * `taskModel` once `tokenSavingsDefaultCallLimit` is reached.
 * - Below `minCacheContextTokens`, switches immediately (`small-context`).
 * - When either model reports `cost.input <= 0` (subscription/OAuth/local),
 *   avoids `0 < 0` disabling savings (`zero-cost-fallback`).
 * - On deep contexts with paid catalog pricing, compares expected prefix cost
 *   over `max(amortizationCalls, openTodoCount)` steps using each model's
 *   cached prefix watermark and TTL.
 * Pure — exported for tests.
 */
export function decideFusionTokenSavingsSwitch(options: {
	defaultModel: Pick<Model<Api>, "provider" | "id" | "cost">;
	taskModel: Pick<Model<Api>, "provider" | "id" | "cost">;
	currentContextTokens: number;
	defaultWatermark?: FusionModelPrefixWatermark;
	taskWatermark?: FusionModelPrefixWatermark;
	openTodoCount?: number;
	amortizationCalls?: number;
	minCacheContextTokens?: number;
	cacheTtlMs?: number;
	now: number;
}): FusionTokenSavingsSwitchDecision {
	const minCacheContextTokens = options.minCacheContextTokens ?? DEFAULT_FUSION_TOKEN_SAVINGS_MIN_CACHE_CONTEXT_TOKENS;
	const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_FUSION_TOKEN_SAVINGS_CACHE_TTL_MS;
	const baseAmortization = Math.max(
		1,
		Math.floor(options.amortizationCalls ?? DEFAULT_FUSION_TOKEN_SAVINGS_AMORTIZATION_CALLS),
	);
	const openTodoCount = Math.max(0, Math.floor(options.openTodoCount ?? 0));
	const horizonCalls = Math.max(1, baseAmortization, openTodoCount);

	const defaultPrefix = computeFusionWarmPrefixTokens({
		currentContextTokens: options.currentContextTokens,
		watermark: options.defaultWatermark,
		now: options.now,
		cacheTtlMs,
	});
	const taskPrefix = computeFusionWarmPrefixTokens({
		currentContextTokens: options.currentContextTokens,
		watermark: options.taskWatermark,
		now: options.now,
		cacheTtlMs,
	});

	if (minCacheContextTokens > 0 && options.currentContextTokens < minCacheContextTokens) {
		return {
			shouldSwitch: true,
			reason: "small-context",
			horizonCalls,
			defaultUncachedDeltaTokens: defaultPrefix.uncachedDeltaTokens,
			taskUncachedDeltaTokens: taskPrefix.uncachedDeltaTokens,
		};
	}

	if (options.defaultModel.cost.input <= 0 || options.taskModel.cost.input <= 0) {
		return {
			shouldSwitch: true,
			reason: "zero-cost-fallback",
			horizonCalls,
			defaultUncachedDeltaTokens: defaultPrefix.uncachedDeltaTokens,
			taskUncachedDeltaTokens: taskPrefix.uncachedDeltaTokens,
		};
	}

	const defaultHorizonCostUsd = estimateFusionPrefixHorizonCostUsd({
		cost: options.defaultModel.cost,
		currentContextTokens: options.currentContextTokens,
		warmTokens: defaultPrefix.warmTokens,
		horizonCalls,
	});
	const taskHorizonCostUsd = estimateFusionPrefixHorizonCostUsd({
		cost: options.taskModel.cost,
		currentContextTokens: options.currentContextTokens,
		warmTokens: taskPrefix.warmTokens,
		horizonCalls,
	});
	const shouldSwitch = taskHorizonCostUsd < defaultHorizonCostUsd;
	return {
		shouldSwitch,
		reason: shouldSwitch ? "cache-break-even-met" : "cache-break-even-not-met",
		horizonCalls,
		defaultHorizonCostUsd,
		taskHorizonCostUsd,
		defaultUncachedDeltaTokens: defaultPrefix.uncachedDeltaTokens,
		taskUncachedDeltaTokens: taskPrefix.uncachedDeltaTokens,
	};
}

/**
 * Policy decision at the start of a new user prompt in `token-savings` mode:
 * decides whether to restore `baseModel` (`default`) or keep `pi/task` sticky
 * across rapid follow-up turns on deep contexts within the cache TTL window.
 * Pure — exported for tests.
 */
export function decideFusionTokenSavingsTurnStart(options: {
	fusionEnabled: boolean;
	fusionMode?: string;
	routingDisabled: boolean;
	switchedInPriorTurn: boolean;
	baseModel?: Model<Api>;
	lastAutoModel?: Model<Api>;
	currentModel?: Model<Api>;
	currentContextTokens: number;
	taskCallsSinceSwitch: number;
	stickyMaxCalls?: number;
	amortizationCalls?: number;
	minCacheContextTokens?: number;
	defaultWatermark?: FusionModelPrefixWatermark;
	taskWatermark?: FusionModelPrefixWatermark;
	lastSwitchAt?: number;
	cacheTtlMs?: number;
	now: number;
}): FusionTokenSavingsTurnStartDecision {
	if (!options.switchedInPriorTurn || !options.baseModel) {
		return { action: "noop", reason: "not-switched" };
	}
	if (options.routingDisabled) {
		return { action: "noop", reason: "routing-disabled" };
	}
	if (
		options.lastAutoModel !== undefined &&
		options.currentModel !== undefined &&
		!modelsAreEqual(options.currentModel, options.lastAutoModel)
	) {
		return { action: "manual-override", reason: "manual-override" };
	}
	if (options.currentModel !== undefined && modelsAreEqual(options.currentModel, options.baseModel)) {
		return { action: "already-default", reason: "escalated-or-already-default" };
	}
	if (!options.fusionEnabled || (options.fusionMode !== "token-savings" && options.fusionMode !== "savings")) {
		return { action: "restore-default", reason: "mode-inactive" };
	}

	const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_FUSION_TOKEN_SAVINGS_CACHE_TTL_MS;
	const lastActiveAt = Math.max(
		options.taskWatermark?.lastUsedAt ?? 0,
		options.lastSwitchAt ?? 0,
		options.defaultWatermark?.lastUsedAt ?? 0,
	);
	if (cacheTtlMs <= 0 || lastActiveAt <= 0 || options.now - lastActiveAt >= cacheTtlMs) {
		return { action: "restore-default", reason: "ttl-expired" };
	}

	const minCacheContextTokens = options.minCacheContextTokens ?? DEFAULT_FUSION_TOKEN_SAVINGS_MIN_CACHE_CONTEXT_TOKENS;
	if (minCacheContextTokens > 0 && options.currentContextTokens < minCacheContextTokens) {
		return { action: "restore-default", reason: "small-context" };
	}

	const stickyMaxCalls = Math.max(
		0,
		Math.floor(options.stickyMaxCalls ?? DEFAULT_FUSION_TOKEN_SAVINGS_STICKY_MAX_CALLS),
	);
	if (stickyMaxCalls > 0 && options.taskCallsSinceSwitch <= stickyMaxCalls) {
		return { action: "keep-sticky-task", reason: "sticky-short-tail" };
	}
	if (stickyMaxCalls <= 0) {
		// `0` disables sticky retention outright, including the cold-default gate below.
		return { action: "restore-default", reason: "tail-amortized" };
	}

	const baseModel = options.baseModel;
	const taskModel = options.lastAutoModel;
	if (!baseModel || !taskModel) {
		return { action: "restore-default", reason: "tail-amortized" };
	}
	// Subscription/local models have no dollar cost; prefer frontier quality.
	if (baseModel.cost.input <= 0 || taskModel.cost.input <= 0) {
		return { action: "restore-default", reason: "tail-amortized" };
	}
	const horizonCalls = Math.max(
		1,
		Math.floor(options.amortizationCalls ?? DEFAULT_FUSION_TOKEN_SAVINGS_AMORTIZATION_CALLS),
	);
	const basePrefix = computeFusionWarmPrefixTokens({
		currentContextTokens: options.currentContextTokens,
		watermark: options.defaultWatermark,
		now: options.now,
		cacheTtlMs,
	});
	const taskPrefix = computeFusionWarmPrefixTokens({
		currentContextTokens: options.currentContextTokens,
		watermark: options.taskWatermark,
		now: options.now,
		cacheTtlMs,
	});
	const restoreCostUsd = estimateFusionPrefixHorizonCostUsd({
		cost: baseModel.cost,
		currentContextTokens: options.currentContextTokens,
		warmTokens: basePrefix.warmTokens,
		horizonCalls,
	});
	const stayCostUsd = estimateFusionPrefixHorizonCostUsd({
		cost: taskModel.cost,
		currentContextTokens: options.currentContextTokens,
		warmTokens: taskPrefix.warmTokens,
		horizonCalls,
	});
	if (restoreCostUsd <= stayCostUsd) {
		return { action: "restore-default", reason: "tail-amortized" };
	}
	return { action: "keep-sticky-task", reason: "sticky-default-cold" };
}
