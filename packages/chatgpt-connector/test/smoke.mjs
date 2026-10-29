// Quick smoke script (not part of `bun test`): spins a real connector on a
// temp workspace and exercises initialize/tools/list/tools/call over HTTP.
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnector } from "../src/index.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "smoke-")));
const ws = realpathSync(mkdtempSync(join(tmpdir(), "smoke-ws-")));
const configPath = join(dir, "config.json");
writeFileSync(configPath, JSON.stringify({
	server: { host: "127.0.0.1", port: 0 },
	auth: { mode: "bearer", tokens: ["smoke-token-0123456789abcdef"] },
	workspaces: [{ id: "ws", path: ws }],
}));

const connector = createConnector({
	configPath,
	env: {},
	createRunner: () => ({
		async run(input) {
			return { text: `echo: ${input.prompt}`, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, requests: 1 } };
		},
		async dispose() {},
	}),
});
const base = `http://127.0.0.1:${connector.server.port}`;
console.log("listening:", base);

const post = (body) => fetch(`${base}/mcp`, {
	method: "POST",
	headers: { "content-type": "application/json", authorization: "Bearer smoke-token-0123456789abcdef" },
	body: JSON.stringify(body),
}).then(r => r.json());

const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
console.log("init:", init.result.protocolVersion, "| serverInfo:", JSON.stringify(init.result.serverInfo));

const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
console.log("tools:", tools.result.tools.map(t => t.name).join(","));

const wsList = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_workspaces", arguments: {} } });
console.log("workspaces:", wsList.result.content[0].text);
console.log("path stripped:", wsList.result.structuredContent.workspaces[0].path === undefined);

const launch = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "launch_task", arguments: { prompt: "say hello", wait_seconds: 0 } } });
console.log("launch id:", launch.result.structuredContent.task.id, "| settled:", launch.result.structuredContent.settled);
console.log("sessionFile stripped:", launch.result.structuredContent.task.sessionFile === undefined);

await new Promise(r => setTimeout(r, 500));
await connector.stop();
console.log("stopped cleanly");
