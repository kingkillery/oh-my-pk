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
	// Opt-in NVIDIA NIM direct lanes (round-robin across NVIDIA_API_KEYS).
	// Any `nvidia/<nim-model-id>` passes through; these are just discovery entries.
	{
		id: "nvidia/deepseek-ai/deepseek-v4.1-flash",
		object: "model",
		owned_by: "nvidia",
		label: "DeepSeek V4.1 Flash via NVIDIA NIM (key round-robin)",
		lane: "fast",
		contextWindow: 128000,
	},
	{
		id: "nvidia/minimaxai/minimax-m3.1-flash",
		object: "model",
		owned_by: "nvidia",
		label: "MiniMax M3.1 Flash via NVIDIA NIM (key round-robin)",
		lane: "balanced",
		contextWindow: 1000000,
	},
	{
		id: "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
		object: "model",
		owned_by: "nvidia",
		label: "Nemotron 3 Ultra via NVIDIA NIM (key round-robin)",
		lane: "free",
		contextWindow: 128000,
	},
	// Verified Groq + Cerebras — 2026-11-12. Live 200 on a real chat call.
	{
		id: "groq/openai/gpt-oss-120b",
		object: "model",
		owned_by: "groq",
		label: "GPT-OSS 120B via Groq (free tier)",
		lane: "free",
		contextWindow: 128000,
	},
	{
		id: "groq/openai/gpt-oss-20b",
		object: "model",
		owned_by: "groq",
		label: "GPT-OSS 20B via Groq (free tier)",
		lane: "free",
		contextWindow: 128000,
	},
	{
		id: "groq/qwen/qwen3.8-27b",
		object: "model",
		owned_by: "groq",
		label: "Qwen 3.8 27B via Groq (free tier)",
		lane: "free",
		contextWindow: 128000,
	},
	{
		id: "cerebras/gpt-oss-120b",
		object: "model",
		owned_by: "cerebras",
		label: "GPT-OSS 120B via Cerebras (free tier)",
		lane: "free",
		contextWindow: 128000,
	},
	{
		id: "cerebras/qwen-3.8-27b",
		object: "model",
		owned_by: "cerebras",
		label: "Qwen 3.8 27B via Cerebras (free tier)",
		lane: "free",
		contextWindow: 128000,
	},

	// Verified free set — 2026-11-12. OpenRouter ids are zero-priced
	// (prompt and completion) with tool support and a live 200; NVIDIA ids
	// answered a real chat call on a free-tier key. Ids that 401/404 or only
	// burn NIM credits were left out.
	{
		id: "openrouter/cohere/north-mini-code:free",
		object: "model",
		owned_by: "openrouter",
		label: "North Mini Code Free Lane (tool-capable)",
		lane: "free",
		contextWindow: 256000,
	},
	{
		id: "openrouter/liquid/lfm-2.5-2.6b:free",
		object: "model",
		owned_by: "openrouter",
		label: "LFM 2.5 2.6B Free Lane (fastest cheap lane)",
		lane: "free",
		contextWindow: 65536,
	},
	{
		id: "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
		object: "model",
		owned_by: "openrouter",
		label: "Nemotron 3 Nano Omni Free Lane (multimodal reasoning)",
		lane: "free",
		contextWindow: 256000,
	},
	{
		id: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
		object: "model",
		owned_by: "nvidia",
		label: "Nemotron 3.5 Lightning via NVIDIA NIM (key round-robin)",
		lane: "free",
		contextWindow: 32768,
	},
	{
		id: "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
		object: "model",
		owned_by: "nvidia",
		label: "Nemotron 3 Nano Omni via NVIDIA NIM (key round-robin)",
		lane: "free",
		contextWindow: 32768,
	},
	{
		id: "nvidia/nvidia/nemotron-3.5-bolt-e4b",
		object: "model",
		owned_by: "nvidia",
		label: "Nemotron 3.5 Bolt via NVIDIA NIM (key round-robin)",
		lane: "free",
		contextWindow: 32768,
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

// Module-scope counter: round-robins within an isolate, spreads randomly across
// isolates — enough to even out per-key rate limits without KV/DO state.
// ponytail: per-isolate counter, KV-backed global rotation if uneven spread ever matters.
let keyRr = 0;

function splitKeys(...values) {
	const keys = values
		.filter(Boolean)
		.join(",")
		.split(",")
		.map(k => k.trim())
		.filter(Boolean);
	// Duplicates would make the retry loop hit the same throttled key twice.
	return [...new Set(keys)];
}

const nvidiaKeys = env => splitKeys(env.NVIDIA_API_KEYS, env.NVIDIA_API_KEY);
const openrouterKeys = env => splitKeys(env.OPENROUTER_API_KEYS, env.OPENROUTER_API_KEY);
const groqKeys = env => splitKeys(env.GROQ_API_KEYS, env.GROQ_API_KEY);
const cerebrasKeys = env => splitKeys(env.CEREBRAS_API_KEYS, env.CEREBRAS_API_KEY);

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

	// Normal turns use the verified OpenRouter flash lane first. The remaining
	// entries are ordered by the configured low-latency fallback preference;
	// dispatch retries them only after an upstream failure, so the common path
	// remains one local decision and one model request.
	return {
		selectedModel: "openrouter/deepseek/deepseek-v4.1-flash-1017",
		lane: "fast",
		reason: "Normal request routed to the fastest verified OpenRouter flash lane",
		confidence: 0.9,
		estimatedCostPerM: 0.14,
		estimatedLatencyMs: 900,
		fallbackChain: [
			"minimax-code/MiniMax-M3.1-Flash",
			"nvidia/minimaxai/minimax-m3.1-flash",
			"groq/openai/gpt-oss-120b",
			"cerebras/gpt-oss-120b",
		],
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
	const incomingFallbackChain = Array.isArray(body.__routerFallbackChain)
		? body.__routerFallbackChain.filter(model => typeof model === "string")
		: [];
	delete body.__routerFallbackChain;

	let targetModel = body.model;
	let decisionMeta = null;
	const fallbackChainForRequest = incomingFallbackChain.slice();

	if (!targetModel || targetModel === "router/auto") {
		decisionMeta = evaluateFastRoute(body);
		targetModel = decisionMeta.selectedModel;
		fallbackChainForRequest.push(...decisionMeta.fallbackChain);
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
	let keyPool = null;

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
	} else if (targetModel.startsWith("groq/")) {
		keyPool = groqKeys(env);
		if (keyPool.length > 0) {
			upstreamUrl = "https://api.groq.com/openai/v1/chat/completions";
			upstreamModelId = targetModel.replace(/^groq\//, "");
		} else {
			return new Response(
				JSON.stringify({ error: { message: "Groq lane selected but no keys configured. Set GROQ_API_KEYS (comma-separated) via `wrangler secret put`.", type: "configuration_error" } }),
				{ status: 503, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
			);
		}
	} else if (targetModel.startsWith("cerebras/")) {
		keyPool = cerebrasKeys(env);
		if (keyPool.length > 0) {
			upstreamUrl = "https://api.cerebras.ai/v1/chat/completions";
			upstreamModelId = targetModel.replace(/^cerebras\//, "");
		} else {
			return new Response(
				JSON.stringify({ error: { message: "Cerebras lane selected but no keys configured. Set CEREBRAS_API_KEYS (comma-separated) via `wrangler secret put`.", type: "configuration_error" } }),
				{ status: 503, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
			);
		}
	} else if (targetModel.startsWith("nvidia/")) {
		// Opt-in NVIDIA NIM direct lane. Round-robin across NVIDIA_API_KEYS
		// (each key has its own ~40 TPM limit) applies whenever keys exist.
		keyPool = nvidiaKeys(env);
		// A caller that brought their own NIM key is a pool of one.
		if (keyPool.length === 0 && clientAuth) {
			keyPool = [clientAuth.replace(/^Bearer\s+/i, "")];
		}
		if (keyPool.length > 0) {
			upstreamUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
			upstreamModelId = targetModel.replace(/^nvidia\//, "");
		} else {
			return new Response(
				JSON.stringify({
					error: {
						message: "NVIDIA lane selected but no keys configured. Set NVIDIA_API_KEYS (comma-separated) via `wrangler secret put`.",
						type: "configuration_error",
					},
				}),
				{
					status: 503,
					headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
				},
			);
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

	// Any lane that lands on OpenRouter uses the key pool when configured —
	// free models get their per-account daily quota multiplied by key count.
	if (!keyPool && upstreamUrl.startsWith("https://openrouter.ai/")) {
		keyPool = openrouterKeys(env);
		if (keyPool.length === 0) keyPool = null;
	}


	const upstreamHeaders = {
		"Content-Type": "application/json",
		"User-Agent": "oh-my-pk-router/1.0",
		"HTTP-Referer": "https://oh-my-pk.pkking.computer",
		"X-Title": "oh-my-pk-router",
	};

	const upstreamBody = {
		...body,
		model: upstreamModelId,
	};

	const startTime = Date.now();
	const doFetch = token => {
		const headers = { ...upstreamHeaders };
		if (token) headers["Authorization"] = `Bearer ${token}`;
		return fetch(upstreamUrl, { method: "POST", headers, body: JSON.stringify(upstreamBody) });
	};
	const retryFallback = () => {
		const nextModel = fallbackChainForRequest.shift();
		if (!nextModel || nextModel === targetModel) return undefined;
		const retryBody = { ...body, model: nextModel, __routerFallbackChain: fallbackChainForRequest };
		return handleChatCompletions(
			new Request(request.url, {
				method: "POST",
				headers: request.headers,
				body: JSON.stringify(retryBody),
			}),
			env,
		);
	};
	let upstreamResponse;
	try {
		if (keyPool) {
			// Round-robin: start at the next key, rotate through the pool on
			// rate limits and auth failures so one bad key cannot break the lane.
			for (let attempt = 0; attempt < keyPool.length; attempt++) {
				const token = keyPool[keyRr++ % keyPool.length];
				if (attempt > 0) upstreamResponse.body?.cancel().catch(() => {});
				upstreamResponse = await doFetch(token);
				if (![401, 403, 429, 503].includes(upstreamResponse.status)) break;
			}
		} else {
			upstreamResponse = await doFetch(upstreamToken);
		}
	} catch (error) {
		const fallbackResponse = retryFallback();
		if (fallbackResponse) return fallbackResponse;
		return new Response(
			JSON.stringify({ error: { message: `Upstream dispatch error to ${upstreamUrl}: ${error.message}`, type: "upstream_error" } }),
			{
				status: 502,
				headers: {
					"Content-Type": "application/json; charset=utf-8",
					"Access-Control-Allow-Origin": "*",
				},
			},
		);
	}
	if ([401, 403, 408, 425, 429, 500, 502, 503, 504, 524].includes(upstreamResponse.status)) {
		const fallbackResponse = retryFallback();
		if (fallbackResponse) {
			upstreamResponse.body?.cancel().catch(() => {});
			return fallbackResponse;
		}
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
