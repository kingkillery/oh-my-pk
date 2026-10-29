/**
 * ompk-side custom tool: `ask_chatgpt` delegates a bounded question to ChatGPT
 * via the OpenAI Responses API and returns the answer text.
 *
 * Install through the normal custom-tools loader (`ompk --tools
 * path/to/this/file.ts` or the workspace `ompk.tools` setting). The loader calls
 * the default-exported factory with its injected API surface; this file only
 * needs `pi.zod` for the parameter schema plus `ctx.fetch` for the request, so
 * it stays free of coding-agent internals beyond the public type contract in
 * `extensibility/custom-tools/types.ts`.
 */
import type { CustomToolFactory } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/custom-tools/types";
import { loadChatGptClientConfig } from "../config";
import { isConnectorError } from "../errors";
import { ChatGptClient } from "./client";

const DESCRIPTION = [
	"Ask ChatGPT (OpenAI) a question and return its answer.",
	"Use for a second opinion, rubber-ducking a design, or delegating a bounded analysis.",
	"The question is sent to api.openai.com over the network — do not include secrets,",
	"API keys, or private credentials. Local context is included only in what you write.",
].join(" ");

const factory: CustomToolFactory = pi => {
	const z = pi.zod;
	const parameters = z.object({
		question: z
			.string()
			.min(1)
			.describe(
				"The complete question or task for ChatGPT. Self-contained: ChatGPT cannot see this session, the workspace, or your files.",
			),
		context: z
			.string()
			.optional()
			.describe("Optional extra context pasted verbatim into the question (snippets, constraints)."),
		model: z.string().optional().describe("Model override (default: configured model, e.g. gpt-5.1)."),
		reasoningEffort: z
			.enum(["low", "medium", "high"])
			.optional()
			.describe("Reasoning effort for reasoning-capable models."),
	});

	type Params = { question: string; context?: string; model?: string; reasoningEffort?: "low" | "medium" | "high" };

	return {
		name: "ask_chatgpt",
		label: "Ask ChatGPT",
		description: DESCRIPTION,
		parameters,
		// Sends text to an external API: approval tier "exec" lets an operator gate it.
		approval: "exec",
		async execute(_toolCallId, params: Params, _onUpdate, ctx, signal) {
			try {
				const config = loadChatGptClientConfig();
				const client = new ChatGptClient({ ...config, fetch: ctx.fetch });
				const question = params.context ? `${params.question}\n\nContext:\n${params.context}` : params.question;
				const result = await client.ask(question, {
					model: params.model,
					reasoningEffort: params.reasoningEffort,
					signal,
				});
				const usage = result.usage ? ` (${result.usage.totalTokens} tokens)` : "";
				return {
					content: [
						{
							type: "text",
							text: `ChatGPT${result.model ? ` (${result.model})` : ""}:${usage}\n\n${result.text}`,
						},
					],
					details: { model: result.model, usage: result.usage },
				};
			} catch (error) {
				const message =
					isConnectorError(error) && error.code === "not_configured"
						? `${error.message} Configure the key and retry.`
						: error instanceof Error
							? error.message
							: String(error);
				return { content: [{ type: "text", text: message }], isError: true };
			}
		},
	};
};

export default factory;
