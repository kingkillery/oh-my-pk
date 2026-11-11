import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isMuseSessionReusable, resolveMuseBinary, startOmpkMcpBridge } from "../src/providers/muse-code";
import type { CursorExecHandlers, Tool, ToolResultMessage } from "../src/types";

const echoTool = {
	name: "echo",
	description: "Echo the supplied text",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
} as Tool;

describe("Muse Code CLI bridge", () => {
	test("resolves the installed Muse executable from the version selector", () => {
		const resolved = resolveMuseBinary();
		expect(resolved.toLowerCase()).toContain("muse");
		expect(resolved).not.toMatch(/muse-bin-9\.9\.9/);
	});

	test("rejects unauthenticated MCP calls and executes authorized OMPK tools once", async () => {
		const calls: string[] = [];
		const executor: CursorExecHandlers = {
			mcp: async call => {
				calls.push(call.toolName);
				const result: ToolResultMessage = {
					role: "toolResult",
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					content: [{ type: "text", text: `echo:${String(call.args.text)}` }],
					isError: false,
					timestamp: Date.now(),
				};
				return result;
			},
		};
		const bridge = await startOmpkMcpBridge([echoTool], executor);
		try {
			const denied = await fetch(bridge.url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(denied.status).toBe(401);

			const client = new Client({ name: "muse-bridge-test", version: "1" });
			const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
				requestInit: { headers: { authorization: bridge.authorization } },
			});
			await client.connect(transport);
			const listed = await client.listTools();
			expect(listed.tools.map(tool => tool.name)).toEqual(["echo"]);
			const called = await client.callTool({ name: "echo", arguments: { text: "ok" } });
			expect(calls).toEqual(["echo"]);
			expect(called.isError).toBe(false);
			await client.close();
		} finally {
			await bridge.close();
		}
	});
});

describe("Muse Code session reuse", () => {
	test("reuses a live session for the same model, workspace, and tools", () => {
		expect(isMuseSessionReusable(false, true, true, true)).toBe(true);
	});

	test("never reuses a closed session", () => {
		// After an abort the session stays in the session map; reusing it would
		// send the next turn to a dead host.
		expect(isMuseSessionReusable(true, true, true, true)).toBe(false);
	});

	test("does not reuse a session across a different model, workspace, or tool set", () => {
		expect(isMuseSessionReusable(false, false, true, true)).toBe(false);
		expect(isMuseSessionReusable(false, true, false, true)).toBe(false);
		expect(isMuseSessionReusable(false, true, true, false)).toBe(false);
	});
});
