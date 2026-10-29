/**
 * Protocol tests: JSON-RPC 2.0 dispatch against a real McpServer with a fake
 * TaskService. Covers version negotiation, tools/list metadata, tools/call
 * error paths, notifications, and batches.
 */
import { describe, expect, test } from "bun:test";
import {
	JSON_RPC_ERRORS,
	type JsonRpcRequest,
	type JsonRpcResponse,
	McpServer,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "../src/mcp/server";
import { errorOf, FakeTaskService, resultOf, testConfig } from "./helpers";

function fixture() {
	const service = new FakeTaskService();
	const mcp = new McpServer({ service, config: testConfig({}) });
	const call = (method: string, params?: unknown, id: JsonRpcRequest["id"] = 1) =>
		mcp.handleMessage({ jsonrpc: "2.0", id, method, params });
	return { mcp, service, call };
}

interface InitializeResult {
	protocolVersion: string;
	capabilities: Record<string, unknown>;
	instructions: string;
	serverInfo: { name: string; version: string };
}

interface ToolsListResult {
	tools: Array<{
		name: string;
		title?: string;
		inputSchema?: Record<string, unknown>;
		outputSchema?: Record<string, unknown>;
		annotations?: Record<string, unknown>;
	}>;
}

interface ToolCallResultPayload {
	content: Array<{ type: string; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

describe("initialize", () => {
	test.each([...SUPPORTED_PROTOCOL_VERSIONS])("negotiates %s", async version => {
		const { call } = fixture();
		const res = await call("initialize", { protocolVersion: version });
		const result = resultOf<InitializeResult>(res);
		expect(result?.protocolVersion).toBe(version);
	});

	test("unknown requested version falls back to latest", async () => {
		const { call } = fixture();
		const res = await call("initialize", { protocolVersion: "1999-01-01" });
		expect(resultOf<InitializeResult>(res)?.protocolVersion).toBe("2025-06-18");
	});

	test("result advertises tools capability and instructions", async () => {
		const { call } = fixture();
		const result = resultOf<InitializeResult>(await call("initialize", { protocolVersion: "2025-06-18" }));
		expect(result?.capabilities).toHaveProperty("tools");
		expect(result?.serverInfo.name).toBe("ompk-chatgpt");
		expect(result?.instructions).toContain("launch_task");
	});
});

describe("tools/list", () => {
	test("returns all nine tools with output schemas and annotations", async () => {
		const { call } = fixture();
		const result = resultOf<ToolsListResult>(await call("tools/list"));
		const names = (result?.tools ?? []).map(tool => tool.name).sort();
		expect(names).toEqual([
			"cancel_task",
			"follow_up_task",
			"get_task",
			"get_task_diff",
			"get_task_result",
			"launch_task",
			"list_tasks",
			"list_workspaces",
			"wait_task",
		]);
		for (const tool of result?.tools ?? []) {
			expect(tool.outputSchema, `${tool.name} missing outputSchema`).toBeDefined();
			expect(tool.annotations?.openWorldHint, `${tool.name} missing openWorldHint`).toBeDefined();
		}
	});

	test("launch_task annotated destructive, list_workspaces read-only", async () => {
		const { call } = fixture();
		const tools = resultOf<ToolsListResult>(await call("tools/list"))?.tools ?? [];
		const launch = tools.find(tool => tool.name === "launch_task");
		const listWs = tools.find(tool => tool.name === "list_workspaces");
		expect(launch?.annotations?.destructiveHint).toBe(true);
		expect(listWs?.annotations?.readOnlyHint).toBe(true);
	});
});

describe("tools/call", () => {
	test("list_workspaces returns text and structured content without host paths", async () => {
		const { call } = fixture();
		const result = resultOf<ToolCallResultPayload>(
			await call("tools/call", { name: "list_workspaces", arguments: {} }),
		);
		const text = result?.content[0]?.text ?? "";
		expect(text).toContain("ws");
		const workspaces = (result?.structuredContent?.workspaces ?? []) as Array<Record<string, unknown>>;
		expect(workspaces.length).toBeGreaterThan(0);
		expect(workspaces[0].path).toBeUndefined();
	});

	test("launch_task delegates to the service", async () => {
		const { call, service } = fixture();
		const result = resultOf<ToolCallResultPayload>(
			await call("tools/call", { name: "launch_task", arguments: { prompt: "refactor x" } }),
		);
		expect(result?.isError).toBeFalsy();
		expect(service.launchCalls).toHaveLength(1);
		expect(service.launchCalls[0].prompt).toBe("refactor x");
		const task = result?.structuredContent?.task as { id?: string } | undefined;
		expect(task?.id).toMatch(/^task_fake_/);
	});

	test("unknown tool name returns isError, not a protocol error", async () => {
		const { call } = fixture();
		const res = await call("tools/call", { name: "nope_tool", arguments: {} });
		const result = resultOf<ToolCallResultPayload>(res);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("Unknown tool");
	});

	test("invalid params surface as tool error text", async () => {
		const { call } = fixture();
		const result = resultOf<ToolCallResultPayload>(
			await call("tools/call", { name: "launch_task", arguments: { prompt: "" } }),
		);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("invalid_request");
	});

	test("unknown task id surfaces unknown_task", async () => {
		const { call } = fixture();
		const result = resultOf<ToolCallResultPayload>(
			await call("tools/call", { name: "get_task", arguments: { task_id: "task_none" } }),
		);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("unknown_task");
	});

	test("missing required name is a protocol invalid-params error", async () => {
		const { call } = fixture();
		const res = await call("tools/call", { arguments: {} });
		expect(errorOf(res)?.code).toBe(JSON_RPC_ERRORS.invalidParams);
	});

	test("task summaries hide the host session path", async () => {
		const { call, service } = fixture();
		await service.launch({ prompt: "x" });
		const id = [...service.records.keys()][0];
		const result = resultOf<ToolCallResultPayload>(
			await call("tools/call", { name: "get_task", arguments: { task_id: id } }),
		);
		const task = result?.structuredContent?.task as Record<string, unknown> | undefined;
		expect(task).toBeDefined();
		expect(task?.sessionFile).toBeUndefined();
	});
});

describe("protocol plumbing", () => {
	test("ping returns an empty result", async () => {
		const { call } = fixture();
		expect(resultOf<Record<string, never>>(await call("ping"))).toEqual({});
	});

	test("resource/prompt lists are empty but present", async () => {
		const { call } = fixture();
		expect(resultOf<Record<string, unknown[]>>(await call("resources/list"))).toEqual({ resources: [] });
		expect(resultOf<Record<string, unknown[]>>(await call("prompts/list"))).toEqual({ prompts: [] });
		expect(resultOf<Record<string, unknown[]>>(await call("resources/templates/list"))).toEqual({
			resourceTemplates: [],
		});
	});

	test("unknown method is methodNotFound", async () => {
		const { call } = fixture();
		expect(errorOf(await call("nope/method"))?.code).toBe(JSON_RPC_ERRORS.methodNotFound);
	});

	test("notifications produce no response", async () => {
		const { mcp } = fixture();
		expect(await mcp.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
	});

	test("batch handles a mix and returns only request responses", async () => {
		const { mcp } = fixture();
		const res = await mcp.handleBody([
			{ jsonrpc: "2.0", id: 1, method: "ping" },
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ jsonrpc: "2.0", id: 2, method: "tools/list" },
		]);
		expect(Array.isArray(res)).toBe(true);
		const responses = res as JsonRpcResponse[];
		expect(responses.map(response => response.id)).toEqual([1, 2]);
	});

	test("empty batch is invalid request", async () => {
		const { mcp } = fixture();
		const res = await mcp.handleBody([]);
		const single = res as JsonRpcResponse;
		expect(errorOf(single)?.code).toBe(JSON_RPC_ERRORS.invalidRequest);
	});

	test("malformed message is invalid request", async () => {
		const { mcp } = fixture();
		const res = await mcp.handleMessage("not an object");
		expect(errorOf(res)?.code).toBe(JSON_RPC_ERRORS.invalidRequest);
	});
});
