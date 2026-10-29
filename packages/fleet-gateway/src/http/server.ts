/**
 * The gateway's HTTP front door.
 *
 *   GET  /.well-known/oauth-protected-resource
 *   GET  /.well-known/oauth-authorization-server
 *   POST /oauth/register
 *   GET|POST /oauth/authorize     (approval page)
 *   POST /oauth/token
 *   GET  /health                  (no auth)
 *   POST /mcp                     (Bearer required)
 *
 * The transport owns no domain logic: auth comes from {@link OAuthServer},
 * tools come from {@link McpServer} + the registered {@link callTool}.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Store } from "../db/store";
import type { Caller, JobService } from "../jobs/service";
import { McpServer } from "../mcp/server";
import { buildToolList, callTool } from "../mcp/tools";
import { OAuthServer } from "../oauth/server";
import type { GatewayConfig } from "../types";
import { SERVER_NAME, VERSION } from "../version";

const MAX_BODY = 256 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buf.length;
		if (size > MAX_BODY) throw new Error("body too large");
		chunks.push(buf);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	return text.length ? JSON.parse(text) : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
	res.end(JSON.stringify(body));
}

export class GatewayHttpServer {
	#config: GatewayConfig;
	#oauth: OAuthServer;
	#mcp: McpServer;
	#server: Server | undefined;
	#caller: Caller | undefined;
	#service: JobService;

	constructor(deps: { store: Store; config: GatewayConfig; service: JobService; signingKey: string }) {
		this.#config = deps.config;
		this.#service = deps.service;
		this.#oauth = new OAuthServer({ store: deps.store, config: deps.config, serverKey: deps.signingKey });
		const tools = buildToolList();
		this.#mcp = new McpServer({
			name: SERVER_NAME,
			version: VERSION,
			instructions: [
				"This gateway fronts several machines, each running an ompk connector.",
				"fleet_status names hosts, workspaces and open jobs; fleet_workspaces lists aliases.",
				"work_start launches a task on a workspace alias and returns a job; watch it with work_status or the single work_feed cursor.",
				"When a job reaches idle, work_result carries the outcome; work_continue sends a follow-up; work_cancel interrupts.",
				"Every mutating tool takes a requestId for idempotent retries.",
			].join(" "),
			tools,
			call: async (name, args) =>
				callTool(
					{ service: this.#service, config: this.#config, callerFor: () => this.#requireCaller() },
					name,
					args,
				),
		});
	}

	#requireCaller(): Caller {
		if (!this.#caller) throw new Error("tool call without an authenticated caller");
		return this.#caller;
	}

	get oauth(): OAuthServer {
		return this.#oauth;
	}

	async listen(): Promise<{ port: number; host: string }> {
		const { listen } = this.#config;
		this.#server = createServer((req, res) => {
			void this.#route(req, res).catch(error => {
				if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
				else res.end();
				console.error(`[gateway] ${req.method} ${req.url}:`, error);
			});
		});
		const listening = Promise.withResolvers<void>();
		this.#server!.listen(listen.port, listen.host, listening.resolve);
		await listening.promise;
		const address = this.#server.address();
		const port = typeof address === "object" && address ? address.port : listen.port;
		return { port, host: listen.host };
	}

	async close(): Promise<void> {
		const closed = Promise.withResolvers<void>();
		this.#server?.close(() => closed.resolve());
		await closed.promise;
	}

	async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;

		if (path === "/health") {
			sendJson(res, 200, { ok: true, name: SERVER_NAME, version: VERSION });
			return;
		}
		if (path === "/.well-known/oauth-protected-resource") {
			sendJson(res, 200, this.#oauth.metadataJson());
			return;
		}
		if (path === "/.well-known/oauth-authorization-server") {
			sendJson(res, 200, this.#oauth.asMetadataJson());
			return;
		}
		if (path === "/oauth/register" && req.method === "POST") {
			const body = await readJson(req);
			const result = this.#oauth.register(
				typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {},
			);
			sendJson(res, result.status, result.json);
			return;
		}
		if (path === "/oauth/authorize") {
			await this.#oauth.authorize(req, res, url);
			return;
		}
		if (path === "/oauth/token" && req.method === "POST") {
			await this.#oauth.token(req, res);
			return;
		}
		if (path === "/mcp") {
			await this.#mcpRoute(req, res);
			return;
		}
		sendJson(res, 404, { error: "not_found" });
	}

	async #mcpRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method === "GET") {
			// Streamable HTTP allows GET/SSE; this server is stateless POST only.
			sendJson(res, 405, { error: "method_not_allowed", hint: "POST JSON-RPC 2.0 bodies" }, { allow: "POST" });
			return;
		}
		if (req.method !== "POST") {
			sendJson(res, 405, { error: "method_not_allowed" });
			return;
		}
		const auth = req.headers.authorization;
		const identity = this.#oauth.authenticate(auth);
		if (!identity) {
			sendJson(
				res,
				401,
				{ error: "unauthorized", error_description: "Bearer token required" },
				{
					"www-authenticate": `Bearer realm="${SERVER_NAME}", resource_metadata="${this.#config.publicUrl}/.well-known/oauth-protected-resource"`,
				},
			);
			return;
		}
		let body: unknown;
		try {
			body = await readJson(req);
		} catch {
			sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } });
			return;
		}
		this.#caller = { clientId: identity.clientId, scopes: identity.scopes, grantId: identity.grantId };
		try {
			const response = await this.#mcp.handle(body);
			if (response === null) {
				res.writeHead(202).end();
				return;
			}
			sendJson(res, 200, response);
		} finally {
			this.#caller = undefined;
		}
	}
}
