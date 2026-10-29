/**
 * HTTP transport tests against a real Bun.serve listener on an ephemeral port:
 * auth enforcement, CORS/origin policy, routing (404/405), body limits, parse
 * errors, the oauth protected-resource metadata endpoint, and the
 * WWW-Authenticate challenge shape.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { createJwtVerifier } from "../src/auth-jwt";
import type { ConnectorServer } from "../src/server/http";
import { startConnectorServer } from "../src/server/http";
import { FakeTaskService, testConfig } from "./helpers";

const TOKEN = "test-token-value-0123456789";
const servers: ConnectorServer[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop();
});

function start(options?: {
	auth?: Parameters<typeof testConfig>[0]["auth"];
	oauthVerifier?: Parameters<typeof startConnectorServer>[0]["oauthVerifier"];
	publicUrl?: string;
	allowInsecure?: boolean;
}): { url: string; port: number; service: FakeTaskService } {
	const service = new FakeTaskService();
	const config = testConfig({
		auth: options?.auth,
		server: { publicUrl: options?.publicUrl, allowInsecure: options?.allowInsecure },
	});
	const server = startConnectorServer({
		config,
		service,
		oauthVerifier: options?.oauthVerifier,
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}`, port: server.port, service };
}

function post(url: string, body: unknown, headers?: Record<string, string>) {
	return fetch(`${url}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${TOKEN}`,
			...headers,
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

describe("routing", () => {
	test("GET / and /healthz report status without auth", async () => {
		const { url } = start();
		const info = await (await fetch(url)).json();
		expect((info as Record<string, unknown>).name).toBe("ompk-chatgpt");
		const health = await (await fetch(`${url}/healthz`)).json();
		expect((health as Record<string, unknown>).ok).toBe(true);
	});

	test("unknown path is 404, GET /mcp is 405", async () => {
		const { url } = start();
		expect((await fetch(`${url}/nope`)).status).toBe(404);
		const get = await fetch(`${url}/mcp`);
		expect(get.status).toBe(405);
		expect(get.headers.get("allow")).toContain("POST");
	});

	test("OPTIONS replies 204 with CORS headers", async () => {
		const { url } = start();
		const res = await fetch(`${url}/mcp`, { method: "OPTIONS", headers: { origin: "https://chatgpt.com" } });
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-methods")).toContain("POST");
	});
});

describe("bearer enforcement", () => {
	test("POST /mcp without a token is 401 with a Bearer challenge", async () => {
		const { url } = start();
		const res = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("Bearer");
	});

	test("bad token is 401, good token reaches the protocol layer", async () => {
		const { url } = start();
		const bad = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer wrong-token-012345" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
		expect(bad.status).toBe(401);

		const res = await post(url, { jsonrpc: "2.0", id: 1, method: "ping" });
		expect(res.status).toBe(200);
		expect(((await res.json()) as Record<string, unknown>).result).toEqual({});
	});

	test("query token works only when enabled", async () => {
		const { url: strict } = start({ auth: { allowQueryToken: false } });
		const denied = await fetch(`${strict}/mcp?token=${TOKEN}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
		expect(denied.status).toBe(401);

		const { url: open } = start({ auth: { allowQueryToken: true } });
		const allowed = await fetch(`${open}/mcp?token=${TOKEN}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
		expect(allowed.status).toBe(200);
	});

	test("none mode serves without credentials", async () => {
		const { url } = start({ auth: { mode: "none", tokens: [] } });
		const res = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
		expect(res.status).toBe(200);
	});
});

describe("origin and payload policy", () => {
	test("publicUrl origin passes, others are refused", async () => {
		const { url } = start({ publicUrl: "https://chatgpt.com" });
		const ok = await post(url, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://chatgpt.com" });
		expect(ok.status).toBe(200);
		const denied = await post(url, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example.com" });
		expect(denied.status).toBe(403);
	});

	test("malformed JSON is a parse error, not a crash", async () => {
		const { url } = start();
		const res = await post(url, "{not json");
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error?: { code: number } }).error?.code).toBe(-32700);
	});

	test("bodies over the cap are rejected 413", async () => {
		const { url } = start();
		const res = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
			body: "x".repeat(2 * 1024 * 1024),
		});
		expect(res.status).toBe(413);
	});
});

describe("oauth resource-server surface", () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = publicKey.export({ format: "jwk" }) as unknown as Record<string, unknown>;

	function mintJwt(): string {
		const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({
				iss: "https://idp.example.com",
				aud: "https://conn.example.com/mcp",
				exp: Math.floor(Date.now() / 1000) + 600,
				scope: "mcp",
			}),
		).toString("base64url");
		const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
		return `${header}.${payload}.${signature}`;
	}

	const oauthBlock = {
		resource: "https://conn.example.com/mcp",
		issuer: ["https://idp.example.com"],
		audience: ["https://conn.example.com/mcp"],
		authorizationServers: ["https://idp.example.com"],
		jwksUri: "https://idp.example.com/jwks",
		scopes: ["mcp"],
	};

	test("well-known document advertises resource and authorization servers", async () => {
		const { url } = start({
			auth: { mode: "oauth", oauth: oauthBlock },
			publicUrl: "https://conn.example.com",
			oauthVerifier: createJwtVerifier(oauthBlock, {
				fetcher: async () => JSON.parse(JSON.stringify({ keys: [{ ...jwk, use: "sig" }] })),
			}),
		});
		const res = await fetch(`${url}/.well-known/oauth-protected-resource`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			resource?: string;
			authorization_servers?: string[];
			scopes_supported?: string[];
		};
		expect(body.resource).toBe("https://conn.example.com/mcp");
		expect(body.authorization_servers).toEqual(["https://idp.example.com"]);
		expect(body.scopes_supported).toEqual(["mcp"]);
		// RFC 9728 §3.1 also publishes the path-suffixed form for the /mcp resource.
		const suffixed = await fetch(`${url}/.well-known/oauth-protected-resource/mcp`);
		expect(suffixed.status).toBe(200);
		expect(((await suffixed.json()) as { resource?: string }).resource).toBe("https://conn.example.com/mcp");
	});

	test("401 challenge includes resource_metadata per RFC 9728", async () => {
		const { url } = start({
			auth: { mode: "oauth", oauth: oauthBlock },
			oauthVerifier: createJwtVerifier(oauthBlock, {
				fetcher: async () => JSON.parse(JSON.stringify({ keys: [{ ...jwk, use: "sig" }] })),
			}),
		});
		const res = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
		expect(res.status).toBe(401);
		const challenge = res.headers.get("www-authenticate") ?? "";
		// The advertised URL is origin-rooted with the resource path appended — NOT
		// the resource URL with the well-known path appended.
		expect(challenge).toContain(
			'resource_metadata="https://conn.example.com/.well-known/oauth-protected-resource/mcp"',
		);
		// And the advertised location must actually serve the document.
		const metadata = await fetch(`${url}/.well-known/oauth-protected-resource/mcp`);
		expect(metadata.status).toBe(200);
	});

	test("a valid JWT reaches the MCP layer", async () => {
		const { url } = start({
			auth: { mode: "oauth", oauth: oauthBlock },
			oauthVerifier: createJwtVerifier(oauthBlock, {
				fetcher: async () => JSON.parse(JSON.stringify({ keys: [{ ...jwk, use: "sig" }] })),
			}),
		});
		const res = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${mintJwt()}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
		expect(res.status).toBe(200);
	});

	test("well-known 404s when oauth is not configured", async () => {
		const { url } = start();
		expect((await fetch(`${url}/.well-known/oauth-protected-resource`)).status).toBe(404);
	});
});
