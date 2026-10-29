/**
 * Streamable-HTTP transport for the MCP protocol core.
 *
 * The server is stateless: no Mcp-Session-Id is issued and no SSE stream is
 * kept open. ChatGPT sends one JSON-RPC request per POST and reads one JSON
 * response, which keeps tunneled deployments simple.
 */

import { authorizeRequest } from "../auth";
import { createJwtVerifier, type JwtVerifier } from "../auth-jwt";
import type { ConnectorConfig } from "../config";
import { JSON_RPC_ERRORS, type JsonRpcResponse, McpServer } from "../mcp/server";
import type { TaskService } from "../types";
import { VERSION } from "../version";

const MAX_BODY_BYTES = 1_048_576;
const SERVER_NAME = "ompk-chatgpt";

/** Root path segment for RFC 9728 protected-resource metadata. */
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
	"Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
	"Access-Control-Max-Age": "86400",
};

export interface ConnectorServerOptions {
	config: ConnectorConfig;
	service: TaskService;
	mcp?: McpServer;
	/** Version string reported by `GET /` and `GET /healthz`. */
	version?: string;
	/**
	 * Pre-built verifier for `auth.mode = "oauth"`; created lazily from
	 * `config.auth.oauth` when omitted so one instance shares the JWKS cache.
	 */
	oauthVerifier?: JwtVerifier;
	/** Called for each handled request; defaults to stderr logging. */
	log?: (line: string) => void;
}

export interface ConnectorServer {
	/** Base URL clients should use, honoring `server.publicUrl` when set. */
	readonly url: string;
	readonly port: number;
	stop(): Promise<void>;
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extraHeaders },
	});
}

function empty(status: number, extraHeaders: Record<string, string> = {}): Response {
	return new Response(null, { status, headers: { ...CORS_HEADERS, ...extraHeaders } });
}

function jsonRpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function isLocalOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		const host = url.hostname.toLowerCase();
		return host === "localhost" || host === "::1" || host.startsWith("127.");
	} catch {
		return false;
	}
}

function originAllowed(config: ConnectorConfig, origin: string | null): boolean {
	if (!origin) return true;
	if (config.server.allowInsecure) return true;
	if (isLocalOrigin(origin)) return true;
	if (config.server.publicUrl) {
		try {
			return new URL(config.server.publicUrl).origin === origin;
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * RFC 9728 §3.1 metadata URL for a resource identifier. A resource with a path
 * publishes its document at the origin-rooted well-known path plus that path —
 * `https://host/.well-known/oauth-protected-resource/mcp` for `/mcp` — so the
 * advertised `resource_metadata` must not be built by appending to the resource.
 */
function resourceMetadataUrl(resource: string): string | undefined {
	try {
		const parsed = new URL(resource);
		const suffix = parsed.pathname.replace(/\/+$/, "");
		return `${parsed.origin}${RESOURCE_METADATA_PATH}${suffix}`;
	} catch {
		return undefined;
	}
}

/** Answers both the bare well-known path and its path-suffixed forms. */
function isResourceMetadataPath(pathname: string): boolean {
	return pathname === RESOURCE_METADATA_PATH || pathname.startsWith(`${RESOURCE_METADATA_PATH}/`);
}

/** Start the connector's HTTP listener. */
export function startConnectorServer(options: ConnectorServerOptions): ConnectorServer {
	const { config, service } = options;
	const version = options.version ?? VERSION;
	const mcp = options.mcp ?? new McpServer({ service, config, name: SERVER_NAME, version });
	const log = options.log ?? ((line: string) => console.error(line));
	const oauthVerifier =
		options.oauthVerifier ??
		(config.auth.mode === "oauth" && config.auth.oauth ? createJwtVerifier(config.auth.oauth) : undefined);

	const server = Bun.serve({
		hostname: config.server.host,
		port: config.server.port,
		async fetch(request, serverInstance) {
			const started = performance.now();
			const url = new URL(request.url);
			const respond = (response: Response): Response => {
				const ms = (performance.now() - started).toFixed(1);
				log(`${request.method} ${url.pathname} → ${response.status} (${ms}ms)`);
				return response;
			};

			if (request.method === "OPTIONS") return respond(empty(204));

			if (url.pathname === "/healthz" && request.method === "GET") {
				const tasks = service.list();
				const live = tasks.filter(task => task.state === "running" || task.state === "queued").length;
				return respond(
					json({
						ok: true,
						name: SERVER_NAME,
						version,
						port: serverInstance.port,
						tasks: { live, total: tasks.length },
					}),
				);
			}

			if (isResourceMetadataPath(url.pathname) && request.method === "GET") {
				const oauth = config.auth.oauth;
				if (!oauth) return respond(json({ error: "not_found" }, 404));
				const resource = oauth.resource ?? config.server.publicUrl;
				if (!resource) return respond(json({ error: "not_found" }, 404));
				return respond(
					json({
						resource,
						authorization_servers: oauth.authorizationServers,
						...(oauth.scopes && oauth.scopes.length > 0 ? { scopes_supported: oauth.scopes } : {}),
					}),
				);
			}

			if (url.pathname === "/" && request.method === "GET") {
				return respond(
					json({
						name: SERVER_NAME,
						description: "Remote MCP server that launches and drives ompk coding tasks.",
						mcp: { endpoint: "/mcp", transport: "streamable-http", protocolVersion: "2025-06-18" },
						version,
						workspaces: config.workspaces.map(workspace => ({
							id: workspace.id,
							label: workspace.label,
							allowWrite: workspace.allowWrite !== false,
						})),
					}),
				);
			}

			if (url.pathname !== "/mcp") return respond(json({ error: "not_found" }, 404));

			if (request.method !== "POST") {
				return respond(
					json(
						{
							error: "method_not_allowed",
							message: "This stateless connector accepts JSON-RPC over POST only.",
						},
						405,
						{ Allow: "POST, OPTIONS" },
					),
				);
			}

			if (!originAllowed(config, request.headers.get("origin"))) {
				return respond(json({ error: "origin_not_allowed" }, 403));
			}

			const decision = await authorizeRequest(config.auth, request.headers, {
				queryToken: url.searchParams.get("token"),
				oauthVerifier,
			});
			if (!decision.ok) {
				const status = decision.reason === "auth_misconfigured" ? 503 : 401;
				const headers: Record<string, string> = {};
				if (status === 401) {
					const oauth = config.auth.oauth;
					const resource = oauth?.resource ?? config.server.publicUrl;
					const metadataUrl = resource ? resourceMetadataUrl(resource) : undefined;
					headers["WWW-Authenticate"] =
						oauth && metadataUrl
							? `Bearer realm="ompk-chatgpt", resource_metadata="${metadataUrl}"`
							: 'Bearer realm="ompk-chatgpt"';
				}
				return respond(
					json(
						{
							error: decision.reason ?? "unauthorized",
							message:
								decision.reason === "missing_token"
									? "Send Authorization: Bearer <token>."
									: "The supplied token is not accepted.",
						},
						status,
						headers,
					),
				);
			}

			const contentType = request.headers.get("content-type") ?? "";
			if (contentType.length > 0 && !contentType.toLowerCase().includes("application/json")) {
				return respond(json({ error: "unsupported_media_type" }, 415));
			}

			const raw = await request.text();
			if (raw.length > MAX_BODY_BYTES) {
				return respond(json(jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, "Request body too large"), 413));
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return respond(json(jsonRpcError(null, JSON_RPC_ERRORS.parse, "Parse error: body is not valid JSON"), 400));
			}

			try {
				const result = await mcp.handleBody(parsed);
				if (result === undefined) return respond(empty(202));
				return respond(json(result));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return respond(json(jsonRpcError(null, JSON_RPC_ERRORS.internal, message), 500));
			}
		},
	});

	const port = server.port ?? config.server.port;
	const base =
		config.server.publicUrl ??
		`http://${config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host}:${port}`;
	const trimmedBase = base.replace(/\/+$/, "");
	return {
		url: trimmedBase.endsWith("/mcp") ? trimmedBase : `${trimmedBase}/mcp`,
		port,
		async stop() {
			server.stop(true);
		},
	};
}
