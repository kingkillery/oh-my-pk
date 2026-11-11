import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WebStandardStreamableHTTPServerTransport as McpHttpTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FoldedItem, MuseClient, Session } from "@muse-code/sdk";
import { MuseClient as MuseClientRuntime } from "@muse-code/sdk";
import { clampThinkingLevelForModel, minimumSupportedEffort } from "@pk-nerdsaver-ai/pi-catalog/model-thinking";
import { VERSION } from "@pk-nerdsaver-ai/pi-utils";
import * as AIError from "../error";
import type {
	AssistantMessage,
	Context,
	CursorExecHandlers,
	CursorToolResultHandler,
	ImageContent,
	Message,
	Model,
	ProviderSessionState,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { toolWireSchema } from "../utils/schema/wire";

export interface MuseCodeOptions extends SimpleStreamOptions {
	/** Live OMPK tool executor, forwarded by the agent for every model turn. */
	execHandlers?: CursorExecHandlers;
	/** Receives completed tool results so the agent can place them in transcript order. */
	onToolResult?: CursorToolResultHandler;
	/** Diagnostic override; `echo` exercises the real protocol without subscription inference. */
	museProvider?: string;
	/** Explicit CLI path override (defaults to the installed Muse CLI). */
	museBin?: string;
}

interface MuseInputPart {
	type: "text" | "image";
	text?: string;
	base64Data?: string;
	mediaType?: string;
}

interface StreamBlocks {
	textIndex: number;
	textValue: string;
	thinkingIndex: number;
	thinkingValue: string;
}

const MUSE_MCP_SERVER_NAME = "ompk_tools";
const MUSE_MCP_PROVIDER = "meta-muse-code";
const MUSE_SESSION_KEY = "muse-code-cli-session";
/** Muse settings only accept secret header values as a whole `${VAR}` reference. */
const MUSE_MCP_AUTH_ENV = "OMPK_MUSE_MCP_AUTHORIZATION";

/** Build the `muse serve` argument list; Muse refuses unknown keys and inline secrets. */
export function museServeArgs(bridgeUrl: string, museProvider?: string): string[] {
	return [
		"serve",
		"--disable-shell",
		"--disable-write",
		"--disable-request-user-input",
		...(museProvider ? ["--provider", museProvider] : []),
		"-c",
		`mcpServers.${MUSE_MCP_SERVER_NAME}=${JSON.stringify({
			url: bridgeUrl,
			headers: { Authorization: `\${${MUSE_MCP_AUTH_ENV}}` },
		})}`,
	];
}

/** Resolve the installed Muse Code executable without hardcoding its version. */
export function resolveMuseBinary(override?: string): string {
	if (override) return override;
	const configured = Bun.env.MUSE_BIN;
	if (configured) return configured;
	if (process.platform !== "win32") return "muse";
	const localAppData = Bun.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
	const programs = join(localAppData, "Programs", "muse");
	try {
		const version = readFileSync(join(programs, ".muse-version"), "utf8").trim();
		if (version) return join(programs, `muse-bin-${version}.exe`);
	} catch {
		// Fall through to PATH resolution.
	}
	return "muse";
}

function isToolResultMessage(value: unknown): value is ToolResultMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		"role" in value &&
		value.role === "toolResult" &&
		"content" in value &&
		Array.isArray(value.content) &&
		"isError" in value &&
		typeof value.isError === "boolean" &&
		"toolName" in value &&
		typeof value.toolName === "string"
	);
}

function extractToolResult(value: unknown): ToolResultMessage | undefined {
	if (isToolResultMessage(value)) return value;
	if (typeof value === "object" && value !== null && "toolResult" in value && isToolResultMessage(value.toolResult)) {
		return value.toolResult;
	}
	return undefined;
}

export interface OmpkMcpBridge {
	readonly url: string;
	readonly authorization: string;
	close(): Promise<void>;
}

/**
 * Expose the current OMPK tool set to the Muse host over authenticated loopback MCP.
 * Calls return to OMPK's executor so approvals, sandboxing, and events stay native.
 */
export async function startOmpkMcpBridge(
	tools: readonly Tool[],
	executor: CursorExecHandlers,
	onToolResult?: CursorToolResultHandler,
): Promise<OmpkMcpBridge> {
	const server: Server = new McpServer({ name: "oh-my-pk", version: VERSION }, { capabilities: { tools: {} } });
	const transport: WebStandardStreamableHTTPServerTransport = new McpHttpTransport({
		sessionIdGenerator: () => randomUUID(),
		enableJsonResponse: true,
	});
	const authorization = `Bearer ${randomUUID()}${randomUUID()}`;
	const definitions = tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		inputSchema: toolWireSchema(tool),
	}));

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
	server.setRequestHandler(CallToolRequestSchema, async request => {
		const name = request.params.name;
		const args = request.params.arguments ?? {};
		try {
			const result = extractToolResult(
				await executor.mcp?.({
					name,
					providerIdentifier: MUSE_MCP_PROVIDER,
					toolName: name,
					toolCallId: `muse_${randomUUID()}`,
					args,
					rawArgs: {},
				}),
			);
			if (!result) {
				return { content: [{ type: "text" as const, text: `Tool "${name}" returned no result` }], isError: true };
			}
			await onToolResult?.(result);
			return {
				content: result.content.map(part =>
					part.type === "text"
						? { type: "text" as const, text: part.text }
						: { type: "image" as const, data: part.data, mimeType: part.mimeType },
				),
				isError: result.isError,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { content: [{ type: "text" as const, text: message }], isError: true };
		}
	});

	await server.connect(transport);
	const http = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (request.headers.get("authorization") !== authorization) {
				return new Response("Unauthorized", { status: 401 });
			}
			return transport.handleRequest(request);
		},
	});
	return {
		url: `http://127.0.0.1:${http.port}/mcp`,
		authorization,
		async close() {
			await http.stop(true);
			await transport.close().catch(() => {});
			await server.close().catch(() => {});
		},
	};
}

function textFrom(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function appendUserParts(parts: MuseInputPart[], content: readonly (TextContent | ImageContent)[]): void {
	for (const part of content) {
		if (part.type === "text") parts.push({ type: "text", text: part.text });
		else parts.push({ type: "image", base64Data: part.data, mediaType: part.mimeType });
	}
}

function renderMuseInput(context: Context): MuseInputPart[] {
	const parts: MuseInputPart[] = [];
	for (const prompt of normalizeSystemPrompts(context.systemPrompt)) {
		parts.push({ type: "text", text: `System instructions:\n${prompt}` });
	}
	for (const message of context.messages) {
		if (message.role === "user") {
			if (typeof message.content === "string") parts.push({ type: "text", text: message.content });
			else appendUserParts(parts, message.content);
			continue;
		}
		if (message.role === "developer") continue;
		if (message.role === "assistant") {
			const text = message.content
				.filter((block): block is TextContent => block.type === "text")
				.map(block => block.text)
				.join("\n");
			if (text) parts.push({ type: "text", text: `Assistant: ${text}` });
			continue;
		}
		const text = textFrom(message.content);
		if (!text) continue;
		parts.push({ type: "text", text: `Tool result (${message.toolName}): ${text}` });
	}
	return parts;
}

/**
 * Whether a stored session may serve another turn. A closed session (abort or
 * explicit close) stays in the session map, so reusing it would send the turn
 * to a dead host.
 */
export function isMuseSessionReusable(
	closed: boolean,
	sameModel: boolean,
	sameCwd: boolean,
	sameTools: boolean,
): boolean {
	return !closed && sameModel && sameCwd && sameTools;
}

class MuseCodeSessionState implements ProviderSessionState {
	#closed = false;
	#history: readonly Message[] = [];

	constructor(
		readonly modelId: string,
		readonly cwd: string,
		readonly toolsKey: string,
		readonly client: MuseClient,
		readonly session: Session,
		readonly bridge: OmpkMcpBridge,
	) {}

	matches(modelId: string, cwd: string, toolsKey: string): boolean {
		return isMuseSessionReusable(
			this.#closed,
			this.modelId === modelId,
			this.cwd === cwd,
			this.toolsKey === toolsKey,
		);
	}
	turnInput(context: Context): MuseInputPart[] {
		const current = context.messages;
		let shared = 0;
		while (shared < Math.min(this.#history.length, current.length) && this.#history[shared] === current[shared]) {
			shared++;
		}
		if (this.#history.length === 0 || shared < this.#history.length) return renderMuseInput(context);
		const parts: MuseInputPart[] = [];
		for (const message of current.slice(shared)) {
			if (message.role !== "user") continue;
			if (typeof message.content === "string") parts.push({ type: "text", text: message.content });
			else appendUserParts(parts, message.content);
		}
		if (parts.length > 0) return parts;
		for (let index = current.length - 1; index >= 0; index--) {
			const message = current[index];
			if (message?.role !== "user") continue;
			if (typeof message.content === "string") parts.push({ type: "text", text: message.content });
			else appendUserParts(parts, message.content);
			break;
		}
		return parts;
	}

	async send(parts: MuseInputPart[], model: Model, options: MuseCodeOptions) {
		const effort = clampThinkingLevelForModel(model, options.reasoning) ?? minimumSupportedEffort(model);
		return this.session.sendUserTurn({
			input: parts.map(part =>
				part.type === "image"
					? { type: "image" as const, base64Data: part.base64Data, mediaType: part.mediaType }
					: { type: "text" as const, text: part.text ?? "" },
			),
			reasoningEffort: effort,
		});
	}

	record(history: readonly Message[]): void {
		this.#history = history;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		void this.client
			.close()
			.catch(() => {})
			.finally(() => this.bridge.close());
	}
}

async function createMuseState(
	model: Model,
	context: Context,
	options: MuseCodeOptions,
): Promise<MuseCodeSessionState> {
	if (!context.tools?.length || !options.execHandlers?.mcp) {
		throw new AIError.ProviderResponseError("Muse Code requires the OMPK tool bridge for this session", {
			provider: model.provider,
		});
	}
	const bridge = await startOmpkMcpBridge(context.tools, options.execHandlers, options.onToolResult);
	const cwd = process.cwd();
	let client: MuseClient | undefined;
	try {
		client = await MuseClientRuntime.spawn({
			museBin: resolveMuseBinary(options.museBin),
			args: museServeArgs(bridge.url, options.museProvider),
			cwd,
			env: { ...process.env, [MUSE_MCP_AUTH_ENV]: bridge.authorization },
			clientInfo: { name: "oh_my_pk", version: VERSION },
		});
		const session = await client.startSession({
			workspaceRoot: cwd,
			modelId: model.id,
			providerId: options.museProvider ?? "meta",
			approvalMode: "allowAll",
		});
		return new MuseCodeSessionState(
			model.id,
			cwd,
			context.tools
				.map(tool => tool.name)
				.sort()
				.join("\u0000"),
			client,
			session,
			bridge,
		);
	} catch (error) {
		await client?.close().catch(() => {});
		await bridge.close().catch(() => {});
		throw error;
	}
}

function storedSession(options: MuseCodeOptions): MuseCodeSessionState | undefined {
	const state = options.providerSessionState?.get(MUSE_SESSION_KEY);
	return state instanceof MuseCodeSessionState ? state : undefined;
}

async function sessionFor(model: Model, context: Context, options: MuseCodeOptions): Promise<MuseCodeSessionState> {
	const toolsKey = (context.tools ?? [])
		.map(tool => tool.name)
		.sort()
		.join("\u0000");
	const existing = storedSession(options);
	if (existing?.matches(model.id, process.cwd(), toolsKey)) return existing;
	existing?.close();
	const created = await createMuseState(model, context, options);
	options.providerSessionState?.set(MUSE_SESSION_KEY, created);
	return created;
}

function applyStreamedItem(
	item: FoldedItem,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	blocks: StreamBlocks,
): void {
	if (item.kind === "reasoning") {
		const summary = (item.summary ?? []).join("\n\n");
		if (!summary) return;
		if (blocks.thinkingIndex < 0) {
			blocks.thinkingIndex = output.content.length;
			blocks.thinkingValue = "";
			output.content.push({ type: "thinking", thinking: "" });
			stream.push({ type: "thinking_start", contentIndex: blocks.thinkingIndex, partial: output });
		}
		const delta = summary.startsWith(blocks.thinkingValue) ? summary.slice(blocks.thinkingValue.length) : summary;
		blocks.thinkingValue = summary;
		const thinking = output.content[blocks.thinkingIndex];
		if (thinking?.type === "thinking") thinking.thinking = summary;
		if (delta) stream.push({ type: "thinking_delta", contentIndex: blocks.thinkingIndex, delta, partial: output });
		return;
	}
	if (item.kind !== "agentMessage" || typeof item.text !== "string") return;
	if (blocks.thinkingIndex >= 0) {
		stream.push({
			type: "thinking_end",
			contentIndex: blocks.thinkingIndex,
			content: blocks.thinkingValue,
			partial: output,
		});
		blocks.thinkingIndex = -1;
	}
	if (blocks.textIndex < 0) {
		blocks.textIndex = output.content.length;
		blocks.textValue = "";
		output.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: blocks.textIndex, partial: output });
	}
	const delta = item.text.startsWith(blocks.textValue) ? item.text.slice(blocks.textValue.length) : item.text;
	blocks.textValue = item.text;
	const text = output.content[blocks.textIndex];
	if (text?.type === "text") text.text = item.text;
	if (delta) stream.push({ type: "text_delta", contentIndex: blocks.textIndex, delta, partial: output });
}

function newAssistantMessage(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export const streamMuseCode = (model: Model<"openai-responses">, context: Context, options?: MuseCodeOptions) => {
	const stream = new AssistantMessageEventStream();
	const output = newAssistantMessage(model);
	const museOptions = options as MuseCodeOptions;

	void (async () => {
		const startedAt = performance.now();
		let state: MuseCodeSessionState | undefined;
		try {
			stream.push({ type: "start", partial: output });
			state = await sessionFor(model, context, museOptions);
			const turn = await state.send(state.turnInput(context), model, museOptions);
			const blocks: StreamBlocks = { textIndex: -1, textValue: "", thinkingIndex: -1, thinkingValue: "" };
			for await (const item of turn.items()) {
				if (options?.signal?.aborted) throw new AIError.AbortError();
				applyStreamedItem(item, output, stream, blocks);
			}
			const outcome = await turn.completed;
			if (blocks.thinkingIndex >= 0) {
				stream.push({
					type: "thinking_end",
					contentIndex: blocks.thinkingIndex,
					content: blocks.thinkingValue,
					partial: output,
				});
			}
			if (blocks.textIndex >= 0) {
				stream.push({
					type: "text_end",
					contentIndex: blocks.textIndex,
					content: blocks.textValue,
					partial: output,
				});
			}
			if (options?.signal?.aborted) throw new AIError.AbortError();
			if (outcome.kind !== "completed" || outcome.params.terminal !== "completed") {
				const reason =
					outcome.kind === "completed"
						? (outcome.params.error?.message ?? `Muse Code turn ended: ${outcome.params.terminal}`)
						: "Muse Code turn ended without a terminal result";
				throw new AIError.ProviderResponseError(reason, { provider: model.provider });
			}
			const usage = outcome.params.usage;
			if (usage) {
				const cached = usage.cachedTokens ?? 0;
				const input = Math.max(0, usage.inputTokens - cached);
				output.usage = {
					input,
					output: usage.outputTokens,
					cacheRead: cached,
					cacheWrite: usage.cacheWriteTokens ?? 0,
					totalTokens: input + usage.outputTokens + cached,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				output.contextSnapshot = { promptTokens: usage.inputTokens, nonMessageTokens: 0 };
			}
			output.duration = outcome.params.durationMs ?? performance.now() - startedAt;
			if (outcome.params.timeToFirstTokenMs) output.ttft = outcome.params.timeToFirstTokenMs;
			state.record(context.messages.slice());
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			state?.close();
			const aborted = options?.signal?.aborted === true;
			output.stopReason = aborted ? "aborted" : "error";
			if (!aborted) output.errorMessage = error instanceof Error ? error.message : String(error);
			output.duration = performance.now() - startedAt;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
};
