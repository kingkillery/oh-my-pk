import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	isMuseSessionReusable,
	museHostEnvironment,
	museServeArgs,
	resolveMuseBinary,
	startOmpkMcpBridge,
} from "../src/providers/muse-code";
import type { CursorExecHandlers, Tool, ToolResultMessage } from "../src/types";

const echoTool = {
	name: "echo",
	description: "Echo the supplied text",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
} as Tool;

describe("Muse Code CLI bridge", () => {
	test("enables only the OMPK bridge while disabling native tools and session logs", () => {
		const args = museServeArgs("http://127.0.0.1:1234/mcp", "echo");
		expect(args[args.indexOf("--preset") + 1]).toBe("empty");
		expect(args).toContain("--trust-workspace");
		expect(args).toContain("--disable-shell");
		expect(args).toContain("--disable-write");
		expect(args).toContain("--disable-request-user-input");
		expect(args).toContain("--no-session-log");
		expect(args).toContain("echo");
	});

	test("isolates user config and passes only the selected Meta credential", () => {
		const inherited = {
			HOME: "project-home",
			XDG_CONFIG_HOME: "project-config",
			TBH_MANAGED_HOOKS_PATH: "project-hooks",
			CODEX_HOME: "foreign-skills",
			TBH_MCP_SPAWN_LOG: "foreign-log",
			OPENAI_API_KEY: "foreign-key",
			HTTPS_PROXY: "proxy-value",
			META_API_KEY: "unrelated-key",
			PATH: "system-path",
		};
		const env = museHostEnvironment("isolated-host", "selected-key", "bridge-token", inherited);
		expect(env.HOME).toBe("isolated-host");
		expect(env.USERPROFILE).toBe("isolated-host");
		expect(env.APPDATA).toBe("isolated-host");
		expect(env.LOCALAPPDATA).toBe("isolated-host");
		expect(env.XDG_CONFIG_HOME).toBe(join("isolated-host", "config"));
		expect(env.XDG_DATA_HOME).toBe(join("isolated-host", "data"));
		expect(env.XDG_CACHE_HOME).toBe(join("isolated-host", "cache"));
		expect(env.XDG_STATE_HOME).toBe(join("isolated-host", "state"));
		expect(env.TBH_MANAGED_HOOKS_PATH).toBeUndefined();
		expect(env.CODEX_HOME).toBeUndefined();
		expect(env.TBH_MCP_SPAWN_LOG).toBeUndefined();
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.HTTPS_PROXY).toBe("proxy-value");
		expect(env.TEMP).toBe("isolated-host");
		expect(env.META_API_KEY).toBe("selected-key");
		expect(env.PATH).toBe("system-path");
		expect(inherited.HOME).toBe("project-home");
		expect(inherited.META_API_KEY).toBe("unrelated-key");
		expect(museHostEnvironment("isolated-host", undefined, "bridge-token", inherited).META_API_KEY).toBeUndefined();
	});

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
	test("reuses a live session for the same model, workspace, tools, and credential", () => {
		expect(isMuseSessionReusable(false, true, true, true, true)).toBe(true);
	});

	test("never reuses a closed session", () => {
		// After an abort the session stays in the session map; reusing it would
		// send the next turn to a dead host.
		expect(isMuseSessionReusable(true, true, true, true, true)).toBe(false);
	});

	test("does not reuse a session across a different model, workspace, tool set, or credential", () => {
		expect(isMuseSessionReusable(false, false, true, true, true)).toBe(false);
		expect(isMuseSessionReusable(false, true, false, true, true)).toBe(false);
		expect(isMuseSessionReusable(false, true, true, false, true)).toBe(false);
		expect(isMuseSessionReusable(false, true, true, true, false)).toBe(false);
	});
});
