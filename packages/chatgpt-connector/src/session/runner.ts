/**
 * ompk-backed SessionRunner: one in-process AgentSession per task, kept alive
 * across follow-up turns and disposed by the manager's idle TTL or at shutdown.
 *
 * The runner only translates events and results. Scheduling, cancellation
 * bookkeeping, and retention belong to TaskManager.
 */
import { type AgentSession, createAgentSession } from "@pk-nerdsaver-ai/pi-coding-agent";
import { resolveToolProfile } from "@pk-nerdsaver-ai/pi-coding-agent/tools/tool-profiles";
import type { RunHooks, RunOutcome, SessionRunner, TaskUsage } from "../types";

/** Built-in tools a read-only workspace may use. */
const READ_ONLY_TOOL_NAMES = [
	"read",
	"grep",
	"glob",
	"lsp",
	"ast_grep",
	"web_search",
	"search_tool_bm25",
	"todo",
	"context_oracle",
	"inspect_image",
] as const;

const SUMMARY_CHARS = 280;
const TEXT_PREVIEW_CHARS = 200;

const CONNECTOR_SYSTEM_PROMPT = [
	"You are running as a remotely launched ompk task.",
	"Work autonomously: nobody can answer questions mid-run.",
	"Stay inside the current workspace, keep changes scoped, and verify before finishing.",
	"Finish with a concise summary of what changed and how it was verified.",
].join("\n");

export interface OmpkRunnerOptions {
	/** Allowlisted workspace root. */
	cwd: string;
	/** Model selector string forwarded to `createAgentSession`. */
	model?: string;
	/** When false the session gets a read-only tool ceiling. */
	allowWrite?: boolean;
	/** Extra system prompt text appended to the connector prompt. */
	appendSystemPrompt?: string;
	/** Load MCP servers discovered from the workspace. Default true. */
	enableMCP?: boolean;
}

/** Narrow structural view of an AssistantMessage without importing provider types. */
interface AssistantLike {
	role: "assistant";
	content: Array<{ type: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
	usage?: { input?: number; output?: number; totalTokens?: number };
}

function preview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 1)}…` : flat;
}

function asAssistant(message: unknown): AssistantLike | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const candidate = message as { role?: unknown; content?: unknown };
	if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return undefined;
	return message as AssistantLike;
}

function textOf(message: AssistantLike): string {
	return message.content
		.filter(part => part.type === "text" && typeof part.text === "string")
		.map(part => part.text ?? "")
		.join("\n")
		.trim();
}

function usageOf(message: AssistantLike): TaskUsage {
	const usage = message.usage;
	return {
		inputTokens: usage?.input ?? 0,
		outputTokens: usage?.output ?? 0,
		totalTokens: usage?.totalTokens ?? 0,
		requests: 1,
	};
}

function addUsage(total: TaskUsage, next: TaskUsage): TaskUsage {
	return {
		inputTokens: total.inputTokens + next.inputTokens,
		outputTokens: total.outputTokens + next.outputTokens,
		totalTokens: total.totalTokens + next.totalTokens,
		requests: total.requests + next.requests,
	};
}

/** Translate a session event into a condensed timeline entry. */
function summarizeEvent(event: unknown): { type: string; summary: string } | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const typed = event as { type?: unknown; [key: string]: unknown };
	switch (typed.type) {
		case "tool_execution_start": {
			const name = typeof typed.toolName === "string" ? typed.toolName : "tool";
			const intent = typeof typed.intent === "string" ? typed.intent : undefined;
			return { type: "tool_execution_start", summary: intent ? `${name}: ${preview(intent)}` : name };
		}
		case "tool_execution_end": {
			const name = typeof typed.toolName === "string" ? typed.toolName : "tool";
			return {
				type: "tool_execution_end",
				summary: typed.isError === true ? `${name} failed` : `${name} finished`,
			};
		}
		case "message_end": {
			const assistant = asAssistant(typed.message);
			if (!assistant) return undefined;
			const text = textOf(assistant);
			if (text.length === 0) return undefined;
			return { type: "assistant_text", summary: preview(text.slice(0, TEXT_PREVIEW_CHARS)) };
		}
		case "auto_retry_start":
			return {
				type: "retry",
				summary: `Retry ${String(typed.attempt ?? "?")}/${String(typed.maxAttempts ?? "?")}: ${preview(String(typed.errorMessage ?? "model error"))}`,
			};
		case "auto_compaction_start":
			return { type: "compaction", summary: "Context compaction started" };
		case "notice":
			return { type: "notice", summary: preview(String(typed.message ?? "")) };
		case "agent_end":
			return { type: "agent_end", summary: "Agent turn finished" };
		default:
			return undefined;
	}
}

export class OmpkSessionRunner implements SessionRunner {
	readonly #options: OmpkRunnerOptions;
	#session: AgentSession | undefined;
	#unsubscribe: (() => void) | undefined;
	#usage: TaskUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 };
	#hooks: RunHooks | undefined;
	#abortReason: string | undefined;

	constructor(options: OmpkRunnerOptions) {
		this.#options = options;
	}

	async run(input: {
		cwd: string;
		prompt: string;
		model?: string;
		signal: AbortSignal;
		hooks: RunHooks;
	}): Promise<RunOutcome> {
		if (input.signal.aborted) return { text: "", aborted: true, stopReason: "aborted" };
		this.#hooks = input.hooks;
		this.#abortReason = undefined;

		try {
			const session = await this.#ensureSession(input);
			if (input.signal.aborted) return { text: "", aborted: true, stopReason: "aborted" };
			input.hooks.onAbortHandler(async reason => {
				this.#abortReason = reason ?? "cancelled";
				await session.abort({ reason: this.#abortReason });
			});
			const completed = await session.prompt(input.prompt);
			const assistant = this.#lastAssistant();
			const text = assistant ? textOf(assistant) : "";
			if (assistant) this.#usage = addUsage(this.#usage, usageOf(assistant));
			const aborted = input.signal.aborted || this.#abortReason !== undefined;
			const stopReason = assistant?.stopReason;
			const failed = !aborted && (completed === false || stopReason === "error");
			return {
				text,
				stopReason: aborted ? "aborted" : stopReason,
				usage: { ...this.#usage },
				aborted,
				error: failed ? (assistant?.errorMessage ?? "session turn did not complete") : undefined,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = input.signal.aborted || this.#abortReason !== undefined;
			return { text: "", stopReason: aborted ? "aborted" : "error", aborted, error: aborted ? undefined : message };
		}
	}

	async dispose(): Promise<void> {
		const unsubscribe = this.#unsubscribe;
		const session = this.#session;
		this.#unsubscribe = undefined;
		this.#session = undefined;
		unsubscribe?.();
		if (!session) return;
		try {
			await session.dispose();
		} catch {
			// Disposal is best-effort; the task record already settled.
		}
	}

	async #ensureSession(input: { model?: string; hooks: RunHooks }) {
		if (this.#session) return this.#session;
		const allowWrite = this.#options.allowWrite !== false;
		const { session } = await createAgentSession({
			cwd: this.#options.cwd,
			modelPattern: input.model ?? this.#options.model,
			autoApprove: true,
			hasUI: false,
			enableMCP: this.#options.enableMCP !== false,
			enableIrc: false,
			appendSystemPrompt: [CONNECTOR_SYSTEM_PROMPT, this.#options.appendSystemPrompt].filter(Boolean).join("\n\n"),
			toolProfile: allowWrite
				? undefined
				: resolveToolProfile({ agentTools: READ_ONLY_TOOL_NAMES, editMode: "none" }),
		});
		this.#session = session;
		this.#unsubscribe = session.subscribe(event => {
			const summarized = summarizeEvent(event);
			if (summarized) input.hooks.onEvent(summarized);
		});
		input.hooks.onSession?.(session.sessionFile);
		return session;
	}

	#lastAssistant(): AssistantLike | undefined {
		const messages = this.#session?.messages ?? [];
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const assistant = asAssistant(messages[index]);
			if (assistant) return assistant;
		}
		return undefined;
	}
}

/** Build an in-process runner bound to one allowlisted workspace. */
export function createOmpkSessionRunner(options: OmpkRunnerOptions): SessionRunner {
	return new OmpkSessionRunner(options);
}
