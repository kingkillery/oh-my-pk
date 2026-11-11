/**
 * Fast Decision Client
 *
 * Calls a super-fast decision model (or Cloudflare /v1/route endpoint) on incoming requests
 * to select the optimal model from our preferred pool for maximum token savings and speed.
 */

import { PREFERRED_ROUTER_MODELS } from "./defaults.js";

export interface DecisionRequestOptions {
	endpoint?: string;
	apiKey?: string;
	preference?: "speed" | "quality" | "cost" | "safety" | "balanced";
	userTier?: string;
	signal?: AbortSignal;
}

export interface DecisionResult {
	selectedModel: string;
	lane: string;
	reason: string;
	confidence: number;
	estimatedCostPerM: number;
	baselineFrontierCostPerM: number;
	tokenSavingsUsdPerM: number;
	tokenSavingsPercent: number;
	estimatedLatencyMs: number;
	decisionLatencyMs: number;
	fallbackChain: string[];
	source: "remote_decision_endpoint" | "local_heuristic_classifier";
}

const BASELINE_FRONTIER_COST_PER_M = 3.0; // Benchmark: GPT-6.1 Terra / Frontier flagship ($3.00/M tokens)

export const DEFAULT_ROUTER_ENDPOINT = "https://oh-my-pk.pkking.computer/v1/route";

/**
 * Super-fast decision dispatcher.
 * Selects the optimal model from our preferred pool for token savings and speed.
 */
export async function decideOptimalModel(
	promptOrMessages: string | Array<{ role: string; content: unknown }>,
	options: DecisionRequestOptions = {},
): Promise<DecisionResult> {
	const start = Date.now();
	const endpoint = options.endpoint || DEFAULT_ROUTER_ENDPOINT;

	const messages =
		typeof promptOrMessages === "string"
			? [{ role: "user", content: promptOrMessages }]
			: promptOrMessages;

	// Try remote fast decision endpoint first
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 2000); // Strict 2s decision ceiling
		const onAbort = () => controller.abort();
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const res = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
			},
			body: JSON.stringify({
				messages,
				preference: options.preference || "balanced",
				userTier: options.userTier,
			}),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);
		options.signal?.removeEventListener("abort", onAbort);

		if (res.ok) {
			const json = (await res.json()) as {
				selectedModel: string;
				lane: string;
				reason: string;
				confidence: number;
				estimatedCostPerM: number;
				estimatedLatencyMs: number;
				fallbackChain: string[];
			};

			const decisionLatencyMs = Date.now() - start;
			const estimatedCost = json.estimatedCostPerM ?? 0.25;
			const savingsUsd = Math.max(0, BASELINE_FRONTIER_COST_PER_M - estimatedCost);
			const savingsPercent = Math.round((savingsUsd / BASELINE_FRONTIER_COST_PER_M) * 100);

			return {
				selectedModel: json.selectedModel,
				lane: json.lane,
				reason: json.reason,
				confidence: json.confidence,
				estimatedCostPerM: estimatedCost,
				baselineFrontierCostPerM: BASELINE_FRONTIER_COST_PER_M,
				tokenSavingsUsdPerM: Number(savingsUsd.toFixed(3)),
				tokenSavingsPercent: savingsPercent,
				estimatedLatencyMs: json.estimatedLatencyMs ?? 1000,
				decisionLatencyMs,
				fallbackChain: json.fallbackChain ?? [],
				source: "remote_decision_endpoint",
			};
		}
	} catch {
		// Fallback to local ultra-fast classifier on network timeout/failure
	}

	// Local ultra-fast heuristic classifier (<1ms)
	const fullText = messages
		.map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")))
		.join("\n");
	const lower = fullText.toLowerCase();
	const estTokens = Math.ceil(fullText.length / 4);
	const preference: string = options.preference || "balanced";

	let selected: string = PREFERRED_ROUTER_MODELS.minimaxM31Flash.selector;
	let lane: string = "balanced";
	let reason: string = "General balanced request routed to Minimax M3.1 Flash";
	let cost: number = PREFERRED_ROUTER_MODELS.minimaxM31Flash.costPerMillionTokens;
	let latency: number = PREFERRED_ROUTER_MODELS.minimaxM31Flash.latencyMsP95;
	let confidence: number = 0.88;
	let fallback: string[] = [
		PREFERRED_ROUTER_MODELS.deepseekV41Flash.selector,
		PREFERRED_ROUTER_MODELS.kimiK31Pro.selector,
	];
	if (
		lower.includes("vulnerability") ||
		lower.includes("exploit") ||
		lower.includes("cryptograph") ||
		lower.includes("security audit") ||
		preference === "safety"
	) {
		selected = PREFERRED_ROUTER_MODELS.gpt61Terra.selector;
		lane = "quality";
		reason = "High-security audit routed to GPT-6.1 Terra frontier safety";
		cost = PREFERRED_ROUTER_MODELS.gpt61Terra.costPerMillionTokens;
		latency = PREFERRED_ROUTER_MODELS.gpt61Terra.latencyMsP95;
		confidence = 0.95;
		fallback = [PREFERRED_ROUTER_MODELS.gpt6Luna.selector, PREFERRED_ROUTER_MODELS.kimiK31Pro.selector];
	} else if (estTokens > 48000) {
		selected = PREFERRED_ROUTER_MODELS.minimaxM31Flash.selector;
		lane = "long_context";
		reason = `Large prompt context (${estTokens} tokens) routed to Minimax 1M context`;
		cost = PREFERRED_ROUTER_MODELS.minimaxM31Flash.costPerMillionTokens;
		latency = PREFERRED_ROUTER_MODELS.minimaxM31Flash.latencyMsP95;
		confidence = 0.94;
		fallback = [PREFERRED_ROUTER_MODELS.gemini38FlashTiered.selector, PREFERRED_ROUTER_MODELS.gpt61Terra.selector];
	} else if (
		lower.includes("refactor") ||
		lower.includes("implement") ||
		lower.includes("function") ||
		lower.includes("```") ||
		lower.includes("class ") ||
		lower.includes("algorithm") ||
		lower.includes("bugfix") ||
		lower.includes("fix ") ||
		lower.includes("leak") ||
		lower.includes("code")
	) {
		selected = PREFERRED_ROUTER_MODELS.kimiK31Pro.selector;
		lane = "coding";
		reason = "Coding and architecture request routed to Kimi K3.1 Pro specialist";
		cost = PREFERRED_ROUTER_MODELS.kimiK31Pro.costPerMillionTokens;
		latency = PREFERRED_ROUTER_MODELS.kimiK31Pro.latencyMsP95;
		confidence = 0.92;
		fallback = [PREFERRED_ROUTER_MODELS.gpt6Luna.selector, PREFERRED_ROUTER_MODELS.minimaxM31Flash.selector];
	} else if (preference === "speed") {
		selected = PREFERRED_ROUTER_MODELS.deepseekV41Flash.selector;
		lane = "fast";
		reason = "Speed preference routed to DeepSeek V4.1 Flash";
		cost = PREFERRED_ROUTER_MODELS.deepseekV41Flash.costPerMillionTokens;
		latency = PREFERRED_ROUTER_MODELS.deepseekV41Flash.latencyMsP95;
		confidence = 0.9;
		fallback = [PREFERRED_ROUTER_MODELS.flintFree.selector, PREFERRED_ROUTER_MODELS.minimaxM31Flash.selector];
	} else if (preference === "cost" || preference === "free") {
		selected = PREFERRED_ROUTER_MODELS.nemotronUltraFree.selector;
		lane = "free";
		reason = "Zero-cost preference routed to Nemotron Ultra Free";
		cost = PREFERRED_ROUTER_MODELS.nemotronUltraFree.costPerMillionTokens;
		latency = PREFERRED_ROUTER_MODELS.nemotronUltraFree.latencyMsP95;
		confidence = 0.92;
		fallback = [PREFERRED_ROUTER_MODELS.flintFree.selector, PREFERRED_ROUTER_MODELS.dots3NoteFree.selector];
	}

	const decisionLatencyMs = Date.now() - start;
	const savingsUsd = Math.max(0, BASELINE_FRONTIER_COST_PER_M - cost);
	const savingsPercent = Math.round((savingsUsd / BASELINE_FRONTIER_COST_PER_M) * 100);

	return {
		selectedModel: selected,
		lane,
		reason,
		confidence,
		estimatedCostPerM: cost,
		baselineFrontierCostPerM: BASELINE_FRONTIER_COST_PER_M,
		tokenSavingsUsdPerM: Number(savingsUsd.toFixed(3)),
		tokenSavingsPercent: savingsPercent,
		estimatedLatencyMs: latency,
		decisionLatencyMs,
		fallbackChain: fallback,
		source: "local_heuristic_classifier",
	};
}
