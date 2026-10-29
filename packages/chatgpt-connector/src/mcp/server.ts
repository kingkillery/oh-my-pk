/**
 * Stateless MCP protocol core (JSON-RPC 2.0).
 *
 * Only the tools capability is advertised. The transport layer owns HTTP,
 * authentication, CORS, and session headers; this module owns method dispatch
 * so protocol behavior stays testable without a socket.
 */
import type { ConnectorConfig } from "../config";
import { ConnectorError, isConnectorError } from "../errors";
import type { TaskService } from "../types";
import { VERSION } from "../version";
import { callTool, listToolDefinitions, type ToolCallResult } from "./tools";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];
export const LATEST_PROTOCOL_VERSION: ProtocolVersion = "2025-06-18";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcSuccess {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
}

export interface JsonRpcFailure {
	jsonrpc: "2.0";
	id: JsonRpcId;
	error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export const JSON_RPC_ERRORS = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603,
} as const;

const INSTRUCTIONS = [
	"ompk runs autonomous coding tasks in allowlisted workspaces. Tasks keep running after a call returns.",
	"Workflow: call list_workspaces when you need a workspace id; call launch_task with a specific, self-contained assignment;",
	"poll with wait_task or get_task; read the answer with get_task_result and the change summary with get_task_diff.",
	"A launch result that is not settled includes a task id you can poll. Prefer one task per request over many tiny launches.",
	"Never assume a task finished until its state is completed, failed, cancelled, or timed_out.",
].join(" ");

export interface McpServerOptions {
	service: TaskService;
	config: ConnectorConfig;
	name?: string;
	version?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
	return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function successResponse(id: JsonRpcId, result: unknown): JsonRpcSuccess {
	return { jsonrpc: "2.0", id, result };
}

function negotiateVersion(requested: unknown): ProtocolVersion {
	if (typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
		return requested as ProtocolVersion;
	}
	return LATEST_PROTOCOL_VERSION;
}

export class McpServer {
	readonly #service: TaskService;
	readonly #config: ConnectorConfig;
	readonly #name: string;
	readonly #version: string;

	constructor(options: McpServerOptions) {
		this.#service = options.service;
		this.#config = options.config;
		this.#name = options.name ?? "ompk-chatgpt";
		this.#version = options.version ?? VERSION;
	}

	/** Handle one JSON-RPC message. Returns undefined for notifications. */
	async handleMessage(message: unknown): Promise<JsonRpcResponse | undefined> {
		if (!isObject(message)) {
			return errorResponse(null, JSON_RPC_ERRORS.invalidRequest, "Expected a JSON-RPC 2.0 object");
		}
		const request = message as unknown as JsonRpcRequest;
		if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
			return errorResponse(request.id ?? null, JSON_RPC_ERRORS.invalidRequest, "Invalid JSON-RPC 2.0 request");
		}
		const id = request.id ?? null;
		const isNotification = request.id === undefined;

		try {
			const result = await this.#dispatch(request.method, request.params);
			if (isNotification) return undefined;
			return successResponse(id, result);
		} catch (error) {
			if (isNotification) return undefined;
			if (isConnectorError(error)) {
				return errorResponse(id, JSON_RPC_ERRORS.invalidParams, error.message, {
					code: error.code,
					...error.details,
				});
			}
			if (error instanceof Error && error.name === "MethodNotFound") {
				return errorResponse(id, JSON_RPC_ERRORS.methodNotFound, error.message);
			}
			const messageText = error instanceof Error ? error.message : String(error);
			return errorResponse(id, JSON_RPC_ERRORS.internal, messageText);
		}
	}

	/** Handle a parsed body: one message or a batch. */
	async handleBody(body: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
		if (!Array.isArray(body)) return this.handleMessage(body);
		if (body.length === 0) return errorResponse(null, JSON_RPC_ERRORS.invalidRequest, "Empty JSON-RPC batch");
		const responses: JsonRpcResponse[] = [];
		for (const message of body) {
			const response = await this.handleMessage(message);
			if (response) responses.push(response);
		}
		return responses.length > 0 ? responses : undefined;
	}

	async #dispatch(method: string, params: unknown): Promise<unknown> {
		switch (method) {
			case "initialize":
				return {
					protocolVersion: negotiateVersion(isObject(params) ? params.protocolVersion : undefined),
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: this.#name, version: this.#version },
					instructions: INSTRUCTIONS,
				};
			case "ping":
				return {};
			case "tools/list":
				return { tools: listToolDefinitions() };
			case "tools/call": {
				const typed = isObject(params) ? params : {};
				if (typeof typed.name !== "string" || typed.name.length === 0) {
					throw new ConnectorError("invalid_request", "tools/call requires a tool name");
				}
				const args = isObject(typed.arguments) ? typed.arguments : {};
				const result: ToolCallResult = await callTool(typed.name, args, {
					service: this.#service,
					config: this.#config,
				});
				return {
					content: result.content,
					...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
					...(result.isError ? { isError: true } : {}),
				};
			}
			case "resources/list":
				return { resources: [] };
			case "resources/templates/list":
				return { resourceTemplates: [] };
			case "prompts/list":
				return { prompts: [] };
			case "logging/setLevel":
				return {};
			case "notifications/initialized":
			case "notifications/cancelled":
			case "notifications/roots/list_changed":
			case "notifications/progress":
				return undefined;
			default:
				throw Object.assign(new Error(`Method not found: ${method}`), { name: "MethodNotFound" });
		}
	}
}
