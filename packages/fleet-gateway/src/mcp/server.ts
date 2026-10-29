/**
 * Stateless JSON-RPC 2.0 core for the gateway's own /mcp — the same shape the
 * connector serves: initialize, ping, tools/list, tools/call, notifications
 * ignored, batches answered in order.
 */

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export const JSON_RPC_ERRORS = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
} as const;

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asRequest(value: unknown): JsonRpcRequest | null {
	if (!isRecord(value) || value.jsonrpc !== "2.0") return null;
	if (typeof value.method !== "string") return null;
	const { id } = value;
	if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") return null;
	return { jsonrpc: "2.0", id, method: value.method, params: value.params };
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

export type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

export interface ToolListEntry {
	name: string;
	title?: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
}

export class McpServer {
	readonly name: string;
	readonly version: string;
	#tools: ToolListEntry[];
	#call: ToolHandler;
	#instructions: string;

	constructor(deps: {
		name: string;
		version: string;
		instructions: string;
		tools: ToolListEntry[];
		call: ToolHandler;
	}) {
		this.#tools = deps.tools;
		this.#call = deps.call;
		this.#instructions = deps.instructions;
		this.name = deps.name;
		this.version = deps.version;
	}

	async handle(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
		if (Array.isArray(message)) {
			if (message.length === 0) {
				return {
					jsonrpc: "2.0",
					id: null,
					error: { code: JSON_RPC_ERRORS.INVALID_REQUEST, message: "empty batch" },
				};
			}
			const responses: JsonRpcResponse[] = [];
			for (const item of message) {
				const r = await this.#one(item);
				if (r) responses.push(r);
			}
			return responses.length ? responses : null;
		}
		return this.#one(message);
	}

	async #one(message: unknown): Promise<JsonRpcResponse | null> {
		const request = asRequest(message);
		if (!request) {
			return {
				jsonrpc: "2.0",
				id: null,
				error: { code: JSON_RPC_ERRORS.INVALID_REQUEST, message: "not a JSON-RPC 2.0 request" },
			};
		}
		const id = request.id ?? null;
		const isNotification = request.id === undefined || request.id === null;
		try {
			switch (request.method) {
				case "initialize": {
					const params = isRecord(request.params) ? request.params : {};
					const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
					const protocolVersion =
						requested && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
					return isNotification
						? null
						: {
								jsonrpc: "2.0",
								id,
								result: {
									protocolVersion,
									capabilities: { tools: { listChanged: false } },
									serverInfo: { name: this.name, version: this.version },
									instructions: this.#instructions,
								},
							};
				}
				case "ping":
					return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
				case "tools/list":
					return isNotification ? null : { jsonrpc: "2.0", id, result: { tools: this.#tools } };
				case "tools/call": {
					const params = isRecord(request.params) ? request.params : {};
					if (typeof params.name !== "string" || !params.name) {
						return {
							jsonrpc: "2.0",
							id,
							error: { code: JSON_RPC_ERRORS.INVALID_PARAMS, message: "tools/call needs params.name" },
						};
					}
					const args = isRecord(params.arguments) ? params.arguments : {};
					const result = await this.#call(params.name, args);
					return isNotification ? null : { jsonrpc: "2.0", id, result };
				}
				case "resources/list":
					return isNotification ? null : { jsonrpc: "2.0", id, result: { resources: [] } };
				case "prompts/list":
					return isNotification ? null : { jsonrpc: "2.0", id, result: { prompts: [] } };
				default:
					if (isNotification || request.method.startsWith("notifications/")) return null;
					return {
						jsonrpc: "2.0",
						id,
						error: { code: JSON_RPC_ERRORS.METHOD_NOT_FOUND, message: `unknown method: ${request.method}` },
					};
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { jsonrpc: "2.0", id, error: { code: JSON_RPC_ERRORS.INTERNAL_ERROR, message: detail } };
		}
	}
}
