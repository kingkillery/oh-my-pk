/**
 * Outbound client for the OpenAI Responses API (`POST {baseUrl}/responses`).
 *
 * Powers the ompk-side `ask_chatgpt` tool: the agent delegates a bounded
 * question to ChatGPT and receives plain text back. Configuration comes from
 * `config.chatgpt` (`baseUrl`, `model`, `apiKey`, `timeoutMs`,
 * `reasoningEffort`); failures surface as `ConnectorError("chatgpt_error", …)`
 * so the tool layer can report one stable code.
 */
import type { ChatGptClientConfig } from "../config";
import { ConnectorError } from "../errors";

/** Fetch-shaped function; accepts both global `fetch` and pi-ai's `FetchImpl`. */
export type FetchLike = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export interface ChatGptClientOptions extends ChatGptClientConfig {
	/** Injectable fetch for tests; defaults to global `fetch`. */
	fetch?: FetchLike;
	/** Overrides `apiKey` and the `OPENAI_API_KEY` environment fallback. */
	resolveApiKey?: () => string | undefined;
}

export interface AskOptions {
	/** Optional system/developer instruction prepended to the input. */
	instructions?: string;
	/** Per-call reasoning effort override (`low` | `medium` | `high`). */
	reasoningEffort?: "low" | "medium" | "high";
	/** Per-call timeout override in milliseconds. */
	timeoutMs?: number;
	/** Per-call model override. */
	model?: string;
	/** Caller abort signal, combined with the internal timeout. */
	signal?: AbortSignal;
}

export interface AskResult {
	text: string;
	/** Model actually used, echoed by the API when present. */
	model?: string;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	};
}

interface ResponsesApiOutputItem {
	type?: string;
	content?: Array<{ type?: string; text?: string }>;
	text?: string;
}

interface ResponsesApiBody {
	output_text?: string;
	output?: ResponsesApiOutputItem[];
	model?: string;
	usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
	error?: { message?: string; type?: string } | null;
}

function extractText(body: ResponsesApiBody): string {
	if (typeof body.output_text === "string" && body.output_text.trim().length > 0) {
		return body.output_text.trim();
	}
	const parts: string[] = [];
	for (const item of body.output ?? []) {
		if (item.type !== "message" || !Array.isArray(item.content)) continue;
		for (const part of item.content) {
			if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
				parts.push(part.text);
			}
		}
	}
	return parts.join("\n").trim();
}

/** Combined timeout + caller signal using the platform's AbortSignal helpers. */
function combinedSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return caller ? AbortSignal.any([timeout, caller]) : timeout;
}

export class ChatGptClient {
	readonly #config: ChatGptClientOptions;
	readonly #fetch: FetchLike;

	constructor(options: ChatGptClientOptions) {
		this.#config = options;
		this.#fetch = options.fetch ?? fetch;
	}

	#apiKey(): string | undefined {
		return (this.#config.resolveApiKey?.() ?? this.#config.apiKey ?? process.env.OPENAI_API_KEY)?.trim() || undefined;
	}

	/** Ask ChatGPT a question and return the assistant text. */
	async ask(prompt: string, options: AskOptions = {}): Promise<AskResult> {
		const question = prompt.trim();
		if (question.length === 0) throw new ConnectorError("invalid_request", "prompt must not be empty");
		const apiKey = this.#apiKey();
		if (!apiKey) {
			throw new ConnectorError(
				"not_configured",
				"No OpenAI API key. Set `chatgpt.apiKey` in the connector config or export OPENAI_API_KEY.",
			);
		}

		const timeoutMs = options.timeoutMs ?? this.#config.timeoutMs;
		const effort = options.reasoningEffort ?? this.#config.reasoningEffort;
		const input: unknown = options.instructions
			? [
					{ role: "developer", content: options.instructions },
					{ role: "user", content: question },
				]
			: question;
		const payload: Record<string, unknown> = {
			model: options.model ?? this.#config.model,
			input,
			...(effort ? { reasoning: { effort } } : {}),
		};

		const base = this.#config.baseUrl.replace(/\/+$/, "");
		let response: Response;
		try {
			response = await this.#fetch(`${base}/responses`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(payload),
				signal: combinedSignal(timeoutMs, options.signal),
			});
		} catch (error) {
			const name = error instanceof Error ? error.name : "";
			throw new ConnectorError(
				"chatgpt_error",
				name === "TimeoutError"
					? `ChatGPT request timed out after ${Math.round(timeoutMs / 1000)}s`
					: name === "AbortError"
						? "ChatGPT request was aborted"
						: `ChatGPT request failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		let body: ResponsesApiBody;
		try {
			body = (await response.json()) as ResponsesApiBody;
		} catch {
			throw new ConnectorError("chatgpt_error", `ChatGPT returned a non-JSON response (HTTP ${response.status})`);
		}
		if (!response.ok) {
			const detail = body.error?.message ?? `HTTP ${response.status}`;
			throw new ConnectorError("chatgpt_error", `ChatGPT API error: ${detail}`, { status: response.status });
		}

		const text = extractText(body);
		if (text.length === 0) {
			throw new ConnectorError("chatgpt_error", "ChatGPT returned an empty response");
		}
		const usage = body.usage;
		return {
			text,
			model: typeof body.model === "string" ? body.model : this.#config.model,
			usage:
				usage && typeof usage.total_tokens === "number"
					? {
							inputTokens: usage.input_tokens ?? 0,
							outputTokens: usage.output_tokens ?? 0,
							totalTokens: usage.total_tokens,
						}
					: undefined,
		};
	}
}

/** Build a client from the merged `chatgpt` config block. */
export function createChatGptClient(config: ChatGptClientConfig, fetchImpl?: FetchLike): ChatGptClient {
	return new ChatGptClient({ ...config, fetch: fetchImpl });
}
