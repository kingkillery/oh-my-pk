/**
 * Oh-My-PK Cloudflare LLM Router & Dispatcher
 *
 * Hosts preferred models behind an OpenAI-compatible /v1 endpoint on Cloudflare:
 * - /v1/models: lists available preferred models and router meta-models
 * - /v1/chat/completions: routes to upstream provider (with auto-routing or explicit model)
 * - /v1/route: lightweight decision route returning selected model & metadata
 */

export const PREFERRED_MODELS = [
	{
		id: "router/auto",
		object: "model",
		owned_by: "oh-my-pk-router",
		label: "Intelligent Auto-Router (fast decision dispatch)",
		lane: "auto",
	},
	{
		id: "router/decision",
		object: "model",
		owned_by: "oh-my-pk-router",
		label: "Fast Router Decision Classifier",
		lane: "decision",
	},
	{
		id: "kimi-code/k3.1-pro",
		object: "model",
		owned_by: "kimi-code",
		label: "Kimi K3.1 Pro Coding Specialist",
		lane: "coding",
		contextWindow: 131072,
	},
	{
		id: "minimax-code/MiniMax-M3.1-Flash",
		object: "model",
		owned_by: "minimax-code",
		label: "Minimax M3.1 Flash (1M Balanced)",
		lane: "balanced",
		contextWindow: 1000000,
	},
	{
		id: "openrouter/deepseek/deepseek-v4.1-flash-1017",
		object: "model",
		owned_by: "openrouter",
		label: "DeepSeek V4.1 Flash Fast Lane",
		lane: "fast",
		contextWindow: 128000,
	},
	{
		id: "openrouter/recursive/flint-v1.0:free",
		object: "model",
		owned_by: "openrouter",
		label: "Flint Free High-Speed Lane",
		lane: "free",
		contextWindow: 64000,
	},
	{
		id: "openrouter/baidu/ernie-5.5-flash-preview:free",
		object: "model",
		owned_by: "openrouter",
		label: "Baidu Ernie 5.5 Flash Free Lane",
		lane: "free",
		contextWindow: 32000,
	},
	{
		id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
		object: "model",
		owned_by: "openrouter",
		label: "Nvidia Nemotron 3 Ultra Free Lane",
		lane: "free",
		contextWindow: 128000,
	},
	{
		id: "openrouter/dots-studio/dots-3-note-preview:free",
		object: "model",
		owned_by: "openrouter",
		label: "Dots3 Note Preview Free Lane",
		lane: "free",
		contextWindow: 32000,
	},
	{
		id: "google-antigravity/gemini-3.8-flash-tiered",
		object: "model",
		owned_by: "google-antigravity",
		label: "Gemini 3.8 Flash Tiered Multimodal",
		lane: "multimodal",
		contextWindow: 1000000,
	},
	{
		id: "openai-codex/gpt-6-luna",
		object: "model",
		owned_by: "openai-codex",
		label: "GPT-6 Luna Fast Tool & Agent",
		lane: "structured",
		contextWindow: 128000,
	},
	{
		id: "openai-codex/gpt-6.1-terra",
		object: "model",
		owned_by: "openai-codex",
		label: "GPT-6.1 Terra Frontier Quality & Safety",
		lane: "quality",
		contextWindow: 200000,
	},
];

/**
 * Fast heuristic decision evaluator based on prompt features, tokens, and preferences.
 */
export function evaluateFastRoute(input) {
	const messages = Array.isArray(input.messages) ? input.messages : [];
	const fullText = messages
		.map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")))
		.join("\n") + (input.message || "");

	const preference = input.preference || (input.user && input.user.preference) || "balanced";
	const hasVision = messages.some(
		m => Array.isArray(m.content) && m.content.some(c => c.type === "image_url" || c.image_url),
	);
	const estTokens = Math.ceil(fullText.length / 4);

	// 1. Multimodal / Vision
	if (hasVision) {
		return {
			selectedModel: "google-antigravity/gemini-3.8-flash-tiered",
			lane: "multimodal",
			reason: "Multimodal input requires vision capability",
			confidence: 0.98,
			estimatedCostPerM: 0.3,
			estimatedLatencyMs: 1200,
			fallbackChain: ["openai-codex/gpt-6.1-terra", "openai-codex/gpt-6-luna"],
		};
	}

	// 2. High-security / Audit / Policy
	const lower = fullText.toLowerCase();
	if (
		lower.includes("vulnerability") ||
		lower.includes("exploit") ||
		lower.includes("security audit") ||
		lower.includes("cryptograph") ||
		lower.includes("irreversible") ||
		input.stepRisk === "high" ||
		preference === "safety"
	) {
		return {
			selectedModel: "openai-codex/gpt-6.1-terra",
			lane: "quality",
			reason: "Security audit / high-risk reasoning requires frontier safety",
			confidence: 0.95,
			estimatedCostPerM: 3.0,
			estimatedLatencyMs: 3200,
			fallbackChain: ["openai-codex/gpt-6-luna", "kimi-code/k3.1-pro"],
		};
	}

	// 3. Ultra long context (>48k tokens)
	if (estTokens > 48000) {
		return {
			selectedModel: "minimax-code/MiniMax-M3.1-Flash",
			lane: "long_context",
			reason: `Long context (${estTokens} tokens) routed to Minimax 1M window`,
			confidence: 0.94,
			estimatedCostPerM: 0.25,
			estimatedLatencyMs: 1400,
			fallbackChain: ["google-antigravity/gemini-3.8-flash-tiered", "openai-codex/gpt-6.1-terra"],
		};
	}

	// 4. Heavy coding / Architecture / Refactor
	if (
		lower.includes("refactor") ||
		lower.includes("implement") ||
		lower.includes("function") ||
		lower.includes("class ") ||
		lower.includes("```ts") ||
		lower.includes("```js") ||
		lower.includes("```python") ||
		lower.includes("algorithm") ||
		lower.includes("bugfix") ||
		lower.includes("fix ") ||
		lower.includes("leak") ||
		lower.includes("debug") ||
		lower.includes("code") ||
		lower.includes("compiler")
	) {
		return {
			selectedModel: "kimi-code/k3.1-pro",
			lane: "coding",
			reason: "Coding and architectural task routed to Kimi K3.1 Pro specialist",
			confidence: 0.92,
			estimatedCostPerM: 1.2,
			estimatedLatencyMs: 2200,
			fallbackChain: ["openai-codex/gpt-6-luna", "minimax-code/MiniMax-M3.1-Flash"],
		};
	}

	// 5. Explicit Speed or Free tier
	if (preference === "speed") {
		return {
			selectedModel: "openrouter/deepseek/deepseek-v4.1-flash-1017",
			lane: "fast",
			reason: "Speed preference routed to DeepSeek V4.1 Flash",
			confidence: 0.9,
			estimatedCostPerM: 0.14,
			estimatedLatencyMs: 900,
			fallbackChain: ["openrouter/recursive/flint-v1.0:free", "minimax-code/MiniMax-M3.1-Flash"],
		};
	}

	if (preference === "cost" || preference === "free") {
		return {
			selectedModel: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
			lane: "free",
			reason: "Cost-minimization preference routed to Nemotron Ultra free tier",
			confidence: 0.92,
			estimatedCostPerM: 0.0,
			estimatedLatencyMs: 850,
			fallbackChain: ["openrouter/recursive/flint-v1.0:free", "openrouter/dots-studio/dots-3-note-preview:free"],
		};
	}

	// 6. Default Balanced
	return {
		selectedModel: "minimax-code/MiniMax-M3.1-Flash",
		lane: "balanced",
		reason: "General balanced request routed to Minimax M3.1 Flash",
		confidence: 0.88,
		estimatedCostPerM: 0.25,
		estimatedLatencyMs: 1100,
		fallbackChain: ["openrouter/deepseek/deepseek-v4.1-flash-1017", "kimi-code/k3.1-pro"],
	};
}

/**
 * Handle /v1/models
 */
export function handleModelsList() {
	return new Response(
		JSON.stringify({
			object: "list",
			data: PREFERRED_MODELS.map(m => ({
				id: m.id,
				object: "model",
				created: 1718000000,
				owned_by: m.owned_by,
				permission: [],
				root: m.id,
				parent: null,
			})),
		}),
		{
			status: 200,
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Access-Control-Allow-Origin": "*",
				"Cache-Control": "public, max-age=300",
			},
		},
	);
}

/**
 * Handle /v1/route
 */
export async function handleRouteDecision(request) {
	let body = {};
	try {
		body = await request.json();
	} catch {}

	const decision = evaluateFastRoute(body);
	return new Response(JSON.stringify(decision), {
		status: 200,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

/**
 * Upstream Chat Completions Dispatcher
 */
export async function handleChatCompletions(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }), {
			status: 400,
			headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
		});
	}

	let targetModel = body.model;
	let decisionMeta = null;

	if (!targetModel || targetModel === "router/auto") {
		decisionMeta = evaluateFastRoute(body);
		targetModel = decisionMeta.selectedModel;
	} else if (targetModel === "router/decision") {
		// Call decision evaluation and return synthetic response
		decisionMeta = evaluateFastRoute(body);
		return new Response(
			JSON.stringify({
				id: `chatcmpl-decision-${Date.now()}`,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: "router/decision",
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: JSON.stringify(decisionMeta),
						},
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
			}),
			{
				status: 200,
				headers: {
					"Content-Type": "application/json; charset=utf-8",
					"Access-Control-Allow-Origin": "*",
					"x-router-selected-model": decisionMeta.selectedModel,
				},
			},
		);
	}

	// Client authorization header pass-through
	const clientAuth = request.headers.get("Authorization");

	// Determine upstream URL, auth token, and target model ID
	let upstreamUrl = "https://openrouter.ai/api/v1/chat/completions";
	let upstreamToken = env.OPENROUTER_API_KEY || (clientAuth ? clientAuth.replace(/^Bearer\s+/i, "") : "");
	let upstreamModelId = targetModel;

	if (targetModel.startsWith("openrouter/")) {
		upstreamUrl = "https://openrouter.ai/api/v1/chat/completions";
		upstreamModelId = targetModel.replace(/^openrouter\//, "");
		upstreamToken = env.OPENROUTER_API_KEY || upstreamToken;
	} else if (targetModel.startsWith("minimax-code/")) {
		// If Minimax API key configured directly, route to Minimax endpoint, else OpenRouter
		if (env.MINIMAX_API_KEY) {
			upstreamUrl = "https://api.minimax.io/v1/chat/completions";
			upstreamToken = env.MINIMAX_API_KEY;
			upstreamModelId = "MiniMax-M3.1-Flash";
		} else {
			upstreamUrl = "https://openrouter.ai/api/v1/chat/completions";
			upstreamModelId = "minimax/minimax-m3.1-flash";
			upstreamToken = env.OPENROUTER_API_KEY || upstreamToken;
		}
	} else if (targetModel.startsWith("kimi-code/")) {
		if (env.KIMI_API_KEY || env.MOONSHOT_API_KEY) {
			upstreamUrl = "https://api.moonshot.cn/v1/chat/completions";
			upstreamToken = env.KIMI_API_KEY || env.MOONSHOT_API_KEY;
			upstreamModelId = "k3.1-pro";
		} else {
			upstreamUrl = "https://openrouter.ai/api/v1/chat/completions";
			upstreamModelId = "moonshot/k3.1-pro";
			upstreamToken = env.OPENROUTER_API_KEY || upstreamToken;
		}
	} else if (targetModel.startsWith("openai-codex/") || targetModel.startsWith("openai/")) {
		if (env.OPENAI_API_KEY) {
			upstreamUrl = "https://api.openai.com/v1/chat/completions";
			upstreamToken = env.OPENAI_API_KEY;
			upstreamModelId = targetModel.replace(/^openai-codex\//, "").replace(/^openai\//, "");
		} else {
			upstreamUrl = "https://openrouter.ai/api/v1/chat/completions";
			upstreamModelId = `openai/${targetModel.replace(/^openai-codex\//, "").replace(/^openai\//, "")}`;
			upstreamToken = env.OPENROUTER_API_KEY || upstreamToken;
		}
	} else if (targetModel.startsWith("google-antigravity/")) {
		if (env.GEMINI_API_KEY) {
			upstreamUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
			upstreamToken = env.GEMINI_API_KEY;
			upstreamModelId = "gemini-3.8-flash-tiered";
		} else {
			upstreamUrl = "https://openrouter.ai/api/v1/chat/completions";
			upstreamModelId = "google/gemini-3.8-flash-tiered";
			upstreamToken = env.OPENROUTER_API_KEY || upstreamToken;
		}
	}

	const upstreamHeaders = {
		"Content-Type": "application/json",
		"User-Agent": "oh-my-pk-router/1.0",
		"HTTP-Referer": "https://oh-my-pk.pkking.computer",
		"X-Title": "oh-my-pk-router",
	};
	if (upstreamToken) {
		upstreamHeaders["Authorization"] = `Bearer ${upstreamToken}`;
	}

	const upstreamBody = {
		...body,
		model: upstreamModelId,
	};

	const startTime = Date.now();
	let upstreamResponse;
	try {
		upstreamResponse = await fetch(upstreamUrl, {
			method: "POST",
			headers: upstreamHeaders,
			body: JSON.stringify(upstreamBody),
		});
	} catch (error) {
		return new Response(
			JSON.stringify({
				error: {
					message: `Upstream dispatch error to ${upstreamUrl}: ${error.message}`,
					type: "upstream_error",
				},
			}),
			{
				status: 502,
				headers: {
					"Content-Type": "application/json; charset=utf-8",
					"Access-Control-Allow-Origin": "*",
				},
			},
		);
	}

	const latencyMs = Date.now() - startTime;
	const respHeaders = new Headers(upstreamResponse.headers);
	respHeaders.set("Access-Control-Allow-Origin", "*");
	respHeaders.set("x-router-selected-model", targetModel);
	respHeaders.set("x-router-upstream-url", upstreamUrl);
	respHeaders.set("x-router-latency-ms", String(latencyMs));
	if (decisionMeta) {
		respHeaders.set("x-router-lane", decisionMeta.lane);
		respHeaders.set("x-router-reason", decisionMeta.reason);
	}

	return new Response(upstreamResponse.body, {
		status: upstreamResponse.status,
		statusText: upstreamResponse.statusText,
		headers: respHeaders,
	});
}
