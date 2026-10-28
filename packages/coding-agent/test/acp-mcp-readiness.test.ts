import { describe, expect, it } from "bun:test";
import { ClientSideConnection, type McpServer, ndJsonStream } from "@agentclientprotocol/sdk";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { createAcpConnection } from "@pk-nerdsaver-ai/pi-coding-agent/modes/acp/acp-mode";
import { createAgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

describe("ACP client MCP readiness", () => {
	for (const scenario of ["http", "stdio", "pending", "disconnect"] as const) {
		it(scenario === "disconnect"
			? "disposes the session when the transport closes during bootstrap"
			: scenario !== "pending"
				? `registers usable ${scenario} history tools before new/load/resume return`
				: "bounds unavailable tool startup and registers tools when discovery later finishes", async () => {
			const directory = TempDir.createSync("acp-mcp-readiness-");
			const authStorage = await AuthStorage.create(directory.join("auth.db"));
			const toAgent = new TransformStream<Uint8Array, Uint8Array>();
			const bootstrapWrite = Promise.withResolvers<void>();
			const releaseBootstrap = Promise.withResolvers<void>();
			let outputController!: TransformStreamDefaultController<Uint8Array>;
			const toClient = new TransformStream<Uint8Array, Uint8Array>({
				start(controller) {
					outputController = controller;
				},
				async transform(chunk, controller) {
					const message = JSON.parse(new TextDecoder().decode(chunk)) as { method?: string };
					if (scenario === "disconnect" && message.method === "session/update") {
						bootstrapWrite.resolve();
						await releaseBootstrap.promise;
					}
					controller.enqueue(chunk);
				},
			});
			let session: AgentSession | undefined;
			let sessionId: string | undefined;
			const releaseTools = Promise.withResolvers<void>();
			const calls: Array<{ name?: string; arguments?: unknown }> = [];
			const history = "FACT=cedar-58; DECISION=keep-ACP-boundary; FILE=docs/fork-boundaries.md";
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					if (request.method !== "POST") return new Response(null, { status: 405 });
					const message = (await request.json()) as {
						id?: number;
						method: string;
						params?: { name?: string; arguments?: unknown };
					};
					if (message.id === undefined) return new Response(null, { status: 202 });
					if (message.method === "server/discover") {
						return Response.json({
							jsonrpc: "2.0",
							id: message.id,
							result: {
								resultType: "complete",
								supportedVersions: ["2026-07-28"],
								capabilities: { tools: {} },
								ttlMs: 0,
								cacheScope: "public",
							},
						});
					}
					if (message.method === "tools/list") {
						if (scenario !== "pending") await Bun.sleep(700);
						else await releaseTools.promise;
					}
					if (message.method === "tools/call") {
						calls.push({ name: message.params?.name, arguments: message.params?.arguments });
					}
					const result =
						message.method === "initialize"
							? {
									protocolVersion: "2025-03-26",
									capabilities: { tools: {} },
									serverInfo: { name: "history", version: "1" },
								}
							: message.method === "tools/list"
								? {
										tools: [
											{
												name: "t3_thread_read",
												description: "Read omitted history",
												inputSchema: { type: "object", properties: {} },
											},
										],
									}
								: message.method === "tools/call"
									? { content: [{ type: "text", text: history }] }
									: {};
					return Response.json({
						jsonrpc: "2.0",
						id: message.id,
						result: { ...result, resultType: "complete", ttlMs: 0, cacheScope: "public" },
					});
				},
			});
			const agent = createAcpConnection(ndJsonStream(toClient.writable, toAgent.readable), async cwd => {
				const created = await createAgentSession({
					cwd,
					agentDir: directory.path(),
					authStorage,
					modelRegistry: new ModelRegistry(authStorage),
					sessionManager: SessionManager.inMemory(cwd),
					settings: Settings.isolated({}),
					model: getBundledModel("openai", "gpt-4o-mini"),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableLsp: false,
					enableMCP: false,
					skipPythonPreflight: true,
					toolNames: [],
				});
				session = created.session;
				return session;
			});
			const client = new ClientSideConnection(
				() => ({
					async requestPermission() {
						return { outcome: { outcome: "cancelled" as const } };
					},
					async sessionUpdate() {},
				}),
				ndJsonStream(toAgent.writable, toClient.readable),
			);
			try {
				await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
				const start = performance.now();
				const mcpServers: McpServer[] =
					scenario === "stdio"
						? [
								{
									name: "history",
									command: process.execPath,
									args: [`${import.meta.dir}/fixtures/delayed-history-mcp.ts`],
									env: [],
								},
							]
						: [{ name: "history", type: "http", url: `http://127.0.0.1:${server.port}/mcp`, headers: [] }];
				const created = await client.newSession({
					cwd: directory.path(),
					mcpServers,
				});
				sessionId = created.sessionId;
				if (scenario === "disconnect") {
					await bootstrapWrite.promise;
					outputController.error(new Error("Test ACP transport closed during bootstrap"));
					releaseBootstrap.resolve();
					sessionId = undefined;
					await toAgent.writable.close();
					await Promise.allSettled([agent.closed, client.closed]);
					const deadline = Date.now() + 3_000;
					while (!session?.isDisposed && Date.now() < deadline) await Bun.sleep(10);
					expect(session?.isDisposed).toBe(true);
					return;
				}
				const initialTools = session?.getActiveToolNames();
				if (scenario === "pending") {
					expect(performance.now() - start).toBeLessThan(8_000);
					expect(initialTools).not.toContain("mcp__history_t_thread_read");
					releaseTools.resolve();
				}
				const deadline = Date.now() + 3_000;
				while (!session?.getActiveToolNames().includes("mcp__history_t_thread_read") && Date.now() < deadline) {
					await Bun.sleep(10);
				}
				expect(session?.getActiveToolNames()).toContain("mcp__history_t_thread_read");
				if (scenario !== "pending") expect(initialTools).toContain("mcp__history_t_thread_read");
				const tool = session?.getToolByName("mcp__history_t_thread_read");
				expect(tool).toBeDefined();
				const result = await tool!.execute("recover-history", { threadId: "source-sentinel" });
				expect(result.content).toEqual([{ type: "text", text: history }]);
				if (scenario !== "stdio")
					expect(calls).toEqual([{ name: "t3_thread_read", arguments: { threadId: "source-sentinel" } }]);
				if (scenario !== "pending") {
					await client.loadSession({ sessionId, cwd: directory.path(), mcpServers });
					expect(session?.getActiveToolNames()).toContain("mcp__history_t_thread_read");
					const loadedResult = await session
						?.getToolByName("mcp__history_t_thread_read")
						?.execute("load-recovery", { threadId: "source-sentinel" });
					expect(loadedResult?.content).toEqual([{ type: "text", text: history }]);
					await client.resumeSession({ sessionId, cwd: directory.path(), mcpServers });
					expect(session?.getActiveToolNames()).toContain("mcp__history_t_thread_read");
					const resumedResult = await session
						?.getToolByName("mcp__history_t_thread_read")
						?.execute("resume-recovery", { threadId: "source-sentinel" });
					expect(resumedResult?.content).toEqual([{ type: "text", text: history }]);
				}
			} finally {
				releaseBootstrap.resolve();
				releaseTools.resolve();
				if (sessionId) await client.closeSession({ sessionId });
				for (let attempt = 0; attempt < 100 && (toAgent.writable.locked || toClient.writable.locked); attempt++) {
					await Bun.sleep(0);
				}
				await Promise.allSettled([toAgent.writable.close(), toClient.writable.close()]);
				await Promise.allSettled([agent.closed, client.closed]);
				await session?.dispose();
				authStorage.close();
				await server.stop(true);
				await directory.remove();
			}
		}, 15_000);
	}
});
