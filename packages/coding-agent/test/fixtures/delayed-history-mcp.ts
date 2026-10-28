import * as readline from "node:readline";

// Legacy stdio protocol, matching T3's ACP bridge transport. No model calls.
const input = readline.createInterface({ input: process.stdin });
input.on("line", async line => {
	const message = JSON.parse(line) as {
		id?: number | string;
		method: string;
		params?: { name?: string; arguments?: { threadId?: string } };
	};
	if (message.id === undefined) return;
	if (message.method === "server/discover") {
		process.stdout.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32601, message: "Method not found" },
			})}\n`,
		);
		return;
	}
	if (message.method === "tools/list") await Bun.sleep(700);
	const result =
		message.method === "initialize"
			? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "history", version: "1" } }
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
				: message.method === "tools/call" &&
						message.params?.name === "t3_thread_read" &&
						message.params.arguments?.threadId === "source-sentinel"
					? {
							content: [
								{
									type: "text",
									text: "FACT=cedar-58; DECISION=keep-ACP-boundary; FILE=docs/fork-boundaries.md",
								},
							],
						}
					: {};
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
});
input.on("close", () => process.exit(0));
