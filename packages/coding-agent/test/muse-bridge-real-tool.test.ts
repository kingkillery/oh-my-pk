import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentEvent, AgentToolContext } from "@pk-nerdsaver-ai/pi-agent-core";
import { AuthStorage, SqliteAuthCredentialStore, type ToolResultMessage } from "@pk-nerdsaver-ai/pi-ai";
import { type OmpkMcpBridge, startOmpkMcpBridge } from "@pk-nerdsaver-ai/pi-ai/providers/muse-code";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { CursorExecHandlers } from "@pk-nerdsaver-ai/pi-coding-agent/cursor";
import { createAgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { ReadTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/read";
import { WriteTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/write";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

const marker = "muse-real-read-marker";

describe("Muse MCP bridge with real OMPK tools", () => {
	let cwd: string;
	let session: AgentSession | undefined;
	let bridge: OmpkMcpBridge | undefined;
	let client: Client | undefined;
	let authStorage: AuthStorage | undefined;
	const events: AgentEvent[] = [];
	const results: ToolResultMessage[] = [];

	beforeAll(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "muse-real-tool-test-"));
		await Bun.write(path.join(cwd, "sample.txt"), `${marker}\n`);
		const settings = Settings.isolated({
			"async.enabled": false,
			"tools.approvalMode": "always-ask",
		});
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		const created = await createAgentSession({
			cwd,
			authStorage,
			agentDir: cwd,
			sessionManager: SessionManager.inMemory(cwd),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "write"],
		});
		session = created.session;
		const read = session.getToolByName("read");
		const write = session.getToolByName("write");
		if (!read || !write) throw new Error("Expected the real read and write tools");
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map([
				["read", read],
				["write", write],
			]),
			getToolContext: () => ({ settings }) as AgentToolContext,
			emitEvent: event => events.push(event),
		});
		const toolSession: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
		};
		bridge = await startOmpkMcpBridge([new ReadTool(toolSession), new WriteTool(toolSession)], handlers, result => {
			results.push(result);
			return result;
		});
		client = new Client({ name: "muse-real-tool-test", version: "1" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(bridge.url), {
				requestInit: { headers: { authorization: bridge.authorization } },
			}),
		);
	}, 30000);

	afterAll(async () => {
		await client?.close();
		await bridge?.close();
		await session?.dispose();
		authStorage?.close();
		if (cwd) await removeWithRetries(cwd);
	});

	it("executes the real read tool and returns its result through MCP", async () => {
		if (!client) throw new Error("MCP client not connected");
		const response = await client.callTool({ name: "read", arguments: { path: "sample.txt" } });
		expect(response.isError).not.toBe(true);
		expect(JSON.stringify(response.content)).toContain(marker);
		expect(
			results.some(result => result.toolName === "read" && JSON.stringify(result.content).includes(marker)),
		).toBe(true);
		expect(events.some(event => event.type === "tool_execution_start" && event.toolName === "read")).toBe(true);
		expect(
			events.some(event => event.type === "tool_execution_end" && event.toolName === "read" && !event.isError),
		).toBe(true);
	});

	it("preserves OMPK approval for a bridged write", async () => {
		if (!client) throw new Error("MCP client not connected");
		const response = await client.callTool({ name: "write", arguments: { path: "blocked.txt", content: marker } });
		expect(response.isError).toBe(true);
		expect(JSON.stringify(response.content)).toContain("requires approval");
		expect(await Bun.file(path.join(cwd, "blocked.txt")).exists()).toBe(false);
		expect(
			events.some(event => event.type === "tool_execution_end" && event.toolName === "write" && event.isError),
		).toBe(true);
	});

	it("waits for asynchronous provider resource cleanup during disposal", async () => {
		if (!session || !client || !bridge) throw new Error("Bridge session is not ready");
		const activeClient = client;
		const activeBridge = bridge;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		session.providerSessionState.set("muse-cleanup-test", {
			async close() {
				started.resolve();
				await release.promise;
				await activeClient.close();
				await activeBridge.close();
				await fs.rm(path.join(cwd, "sample.txt"));
			},
		});
		let completed = false;
		const disposed = session.dispose().then(() => {
			completed = true;
		});
		try {
			await started.promise;
			await Promise.resolve();
			expect(completed).toBe(false);
		} finally {
			release.resolve();
		}
		await disposed;
		expect(await Bun.file(path.join(cwd, "sample.txt")).exists()).toBe(false);
		session = undefined;
		client = undefined;
		bridge = undefined;
	});
});

it("cleans temporary hosts after failed and concurrently aborted starts", async () => {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "muse-host-failure-test-"));
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "muse-host-failure.ts")], {
		cwd: temp,
		env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		signal: AbortSignal.timeout(60000),
	});
	try {
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
		expect((await fs.readdir(temp)).filter(name => name.startsWith("ompk-muse-"))).toEqual([]);
	} finally {
		child.kill();
		await removeWithRetries(temp);
	}
}, 70000);
