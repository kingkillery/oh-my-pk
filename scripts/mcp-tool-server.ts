/**
 * Tool-only MCP stdio server: exposes ompk built-in tools so the MCP client's own
 * model drives them. No ompk LLM loop, provider, or session file is involved.
 *
 *   bun scripts/mcp-tool-server.ts
 *   OMPK_MCP_TOOLS=read,grep,glob   # override the exposed tool set
 *
 * A call may pass `_meta.cwd` to run in that directory; callers own path policy.
 */

// stdout is the protocol channel; keep tool/library logging off it.
console.log = console.info = console.debug = console.error;

const { resolveToolSchema } = await import("../packages/ai/src/dialect/coercion.ts");
const { Settings } = await import("../packages/coding-agent/src/config/settings.ts");
const { BUILTIN_TOOLS } = await import("../packages/coding-agent/src/tools/index.ts");
type ToolSession = import("../packages/coding-agent/src/tools/index.ts").ToolSession;

const DEFAULT_TOOLS = "read,grep,glob,ast_grep,lsp,edit,write,bash,web_search";
const TOOL_TIMEOUT_MS = Number(process.env.OMPK_MCP_TOOL_TIMEOUT_MS ?? 300_000);

const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "",
	settings: Settings.isolated(),
};

const tools = new Map<string, any>();
for (const name of (process.env.OMPK_MCP_TOOLS ?? DEFAULT_TOOLS)
	.split(",")
	.map(s => s.trim())
	.filter(Boolean)) {
	const factory = (BUILTIN_TOOLS as Record<string, (s: ToolSession) => unknown>)[name];
	const tool = factory ? await factory(session) : null;
	if (tool) tools.set(name, tool);
	else console.error(`[ompk-mcp] tool unavailable: ${name}`);
}

function send(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function callTool(params: any): Promise<unknown> {
	const tool = tools.get(params?.name);
	if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${params?.name}` }], isError: true };
	const cwd = params?._meta?.cwd;
	if (typeof cwd === "string" && cwd) session.cwd = cwd;
	try {
		const result = await tool.execute(
			crypto.randomUUID(),
			params.arguments ?? {},
			AbortSignal.timeout(TOOL_TIMEOUT_MS),
		);
		const content = (result?.content ?? []).map((block: any) =>
			block.type === "image"
				? { type: "image", data: block.data, mimeType: block.mimeType }
				: { type: "text", text: String(block.text ?? "") },
		);
		return { content, isError: result?.isError === true };
	} catch (error) {
		return {
			content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
			isError: true,
		};
	}
}

async function handle(message: any): Promise<unknown> {
	switch (message.method) {
		case "initialize":
			return {
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "ompk-tools", version: "1.0.0" },
			};
		case "ping":
			return {};
		case "tools/list":
			return {
				tools: [...tools.values()].map(tool => ({
					name: tool.name,
					description: tool.description,
					inputSchema: resolveToolSchema(tool),
				})),
			};
		case "tools/call":
			return callTool(message.params);
		default:
			throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
	}
}

// ponytail: calls run one at a time because they share `session.cwd`; per-call sessions if concurrency matters.
let queue = Promise.resolve();
for await (const line of console) {
	if (!line.trim()) continue;
	let message: any;
	try {
		message = JSON.parse(line);
	} catch {
		send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		continue;
	}
	if (message.id === undefined) continue; // notifications (initialized, cancelled) need no reply
	queue = queue.then(async () => {
		try {
			send({ jsonrpc: "2.0", id: message.id, result: await handle(message) });
		} catch (error: any) {
			send({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: error?.code ?? -32603, message: String(error?.message ?? error) },
			});
		}
	});
}
await queue;
