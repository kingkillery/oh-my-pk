/**
 * Auth tests: the static-token gate (headers, query tokens, none mode,
 * misconfiguration) and the oauth path (JWT verification against a JWKS
 * endpoint it really fetches, plus the async `authorizeRequest` wrapper).
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { authorize, authorizeRequest } from "../src/auth";
import { createJwtVerifier, type JwksFetcher } from "../src/auth-jwt";
import type { AuthConfig, OAuthConfig } from "../src/config";

const TOKEN = "test-token-value-0123456789";

function bearerAuth(extra?: Partial<AuthConfig>): AuthConfig {
	return { mode: "bearer", tokens: [TOKEN], allowQueryToken: false, ...extra };
}

const bearerHeader = (value: string | undefined): Record<string, string | undefined> => ({
	authorization: value === undefined ? undefined : `Bearer ${value}`,
});

describe("bearer authorization", () => {
	test("accepts a valid Bearer token (Headers object)", () => {
		const headers = new Headers({ authorization: `Bearer ${TOKEN}` });
		expect(authorize(bearerAuth(), headers).ok).toBe(true);
	});

	test("rejects wrong and missing tokens", () => {
		expect(authorize(bearerAuth(), bearerHeader("wrong-token-value")).ok).toBe(false);
		expect(authorize(bearerAuth(), bearerHeader(undefined)).reason).toBe("missing_token");
		expect(authorize(bearerAuth(), bearerHeader("wrong")).reason).toBe("invalid_token");
	});

	test("rejects malformed schemes", () => {
		expect(authorize(bearerAuth(), { authorization: TOKEN }).reason).toBe("missing_token");
		expect(authorize(bearerAuth(), { authorization: `Basic ${TOKEN}` }).reason).toBe("missing_token");
	});

	test("query token gated by allowQueryToken", () => {
		const auth = bearerAuth({ allowQueryToken: false });
		expect(authorize(auth, {}, TOKEN).reason).toBe("missing_token");
		expect(authorize(bearerAuth({ allowQueryToken: true }), {}, TOKEN).ok).toBe(true);
		expect(authorize(bearerAuth({ allowQueryToken: true }), {}, "nope").reason).toBe("missing_token");
	});

	test("a valid query token authorizes even with a bad header", () => {
		const auth = bearerAuth({ allowQueryToken: true, tokens: ["other-token-value-12345"] });
		expect(authorize(auth, bearerHeader(TOKEN), "other-token-value-12345").ok).toBe(true);
	});

	test("none mode allows everything", () => {
		expect(authorize({ mode: "none", tokens: [] }, {}).ok).toBe(true);
	});

	test("bearer with empty token list is misconfigured, not a 401", () => {
		expect(authorize(bearerAuth({ tokens: [] }), bearerHeader(TOKEN)).reason).toBe("auth_misconfigured");
	});

	test("oauth mode defers to the async path", () => {
		const auth: AuthConfig = { mode: "oauth", tokens: [TOKEN] };
		expect(authorize(auth, bearerHeader(TOKEN)).reason).toBe("invalid_token");
	});
});

describe("JWT verification (oauth mode)", () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	// Export produces Node's opaque JWK; cast through Record for the fake JWKS document.
	const jwk = publicKey.export({ format: "jwk" }) as unknown as Record<string, unknown>;
	const kid = "test-key-1";

	const oauth: OAuthConfig = {
		resource: "https://connector.example.com/mcp",
		issuer: ["https://idp.example.com"],
		audience: ["https://connector.example.com/mcp"],
		authorizationServers: ["https://idp.example.com"],
		jwksUri: "https://idp.example.com/.well-known/jwks.json",
		clockSkewSeconds: 60,
	};

	function mint(claims: Record<string, unknown>, options?: { kid?: string; alg?: string }): string {
		const header = Buffer.from(
			JSON.stringify({ alg: options?.alg ?? "RS256", typ: "JWT", kid: options?.kid ?? kid }),
		).toString("base64url");
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const data = `${header}.${payload}`;
		const signature = sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url");
		return `${data}.${signature}`;
	}

	const validClaims = {
		iss: "https://idp.example.com",
		sub: "user-42",
		aud: "https://connector.example.com/mcp",
		exp: Math.floor(Date.now() / 1000) + 600,
	};

	function fetcher(overrides?: Partial<{ body: string; status: number }>): JwksFetcher {
		return async () => {
			if (overrides?.status && overrides.status !== 200) {
				throw new Error(`HTTP ${overrides.status}`);
			}
			return JSON.parse(overrides?.body ?? JSON.stringify({ keys: [{ ...jwk, kid, use: "sig" }] }));
		};
	}

	test("accepts a correctly signed token with matching claims", async () => {
		const verifier = createJwtVerifier(oauth, { fetcher: fetcher() });
		const principal = await verifier.verify(mint(validClaims));
		expect(principal.sub).toBe("user-42");
	});

	test("rejects a tampered signature", async () => {
		const verifier = createJwtVerifier(oauth, { fetcher: fetcher() });
		const [h, p] = mint(validClaims).split(".");
		const bad = `${h}.${p}.${Buffer.from("forged").toString("base64url")}`;
		await expect(verifier.verify(bad)).rejects.toThrow("signature");
	});

	test("rejects expired and wrong-audience tokens", async () => {
		const verifier = createJwtVerifier(oauth, { fetcher: fetcher() });
		await expect(
			verifier.verify(mint({ ...validClaims, exp: Math.floor(Date.now() / 1000) - 3600 })),
		).rejects.toThrow("expired");
		await expect(verifier.verify(mint({ ...validClaims, aud: "https://other.example.com" }))).rejects.toThrow(
			"audience",
		);
		await expect(verifier.verify(mint({ ...validClaims, iss: "https://evil.example.com" }))).rejects.toThrow(
			"issuer",
		);
	});

	test("rejects missing expiry and missing required scopes", async () => {
		const verifier = createJwtVerifier({ ...oauth, scopes: ["mcp"] }, { fetcher: fetcher() });
		const { exp: _exp, ...withoutExpiry } = validClaims;
		await expect(verifier.verify(mint({ ...withoutExpiry, scope: "mcp" }))).rejects.toThrow("expiry");
		await expect(verifier.verify(mint(validClaims))).rejects.toThrow("scope");
		await expect(verifier.verify(mint({ ...validClaims, scope: "mcp" }))).resolves.toBeDefined();
	});

	test("rejects malformed and unsupported-alg tokens", async () => {
		const verifier = createJwtVerifier(oauth, { fetcher: fetcher() });
		await expect(verifier.verify("not-a-jwt")).rejects.toThrow();
		await expect(verifier.verify(mint(validClaims, { alg: "HS256" }))).rejects.toThrow("alg");
	});

	test("forces a JWKS refresh on unknown kid, then still fails if missing", async () => {
		let fetches = 0;
		const countingFetcher: JwksFetcher = async () => {
			fetches += 1;
			return JSON.parse(JSON.stringify({ keys: [{ ...jwk, kid, use: "sig" }] }));
		};
		const verifier = createJwtVerifier(oauth, { fetcher: countingFetcher });
		await expect(verifier.verify(mint(validClaims, { kid: "other-kid" }))).rejects.toThrow("signature");
		expect(fetches).toBe(2);
	});

	test("JWKS outages surface as AuthorizationServerError", async () => {
		const verifier = createJwtVerifier(oauth, { fetcher: fetcher({ status: 500 }) });
		await expect(verifier.verify(mint(validClaims))).rejects.toThrow(/JWKS|failed/i);
	});
});

describe("authorizeRequest (oauth)", () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = publicKey.export({ format: "jwk" }) as unknown as Record<string, unknown>;
	const oauth: OAuthConfig = {
		resource: "https://connector.example.com/mcp",
		issuer: ["https://idp.example.com"],
		audience: ["https://connector.example.com/mcp"],
		authorizationServers: ["https://idp.example.com"],
		jwksUri: "https://idp.example.com/jwks",
		clockSkewSeconds: 60,
	};
	const fetcher: JwksFetcher = async () => JSON.parse(JSON.stringify({ keys: [{ ...jwk, use: "sig" }] }));

	function mintJwt(): string {
		const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
		const claims = {
			iss: "https://idp.example.com",
			aud: "https://connector.example.com/mcp",
			exp: Math.floor(Date.now() / 1000) + 600,
		};
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
		return `${header}.${payload}.${signature}`;
	}

	test("accepts a valid JWT", async () => {
		const auth: AuthConfig = { mode: "oauth", tokens: [], oauth };
		const verifier = createJwtVerifier(oauth, { fetcher });
		const decision = await authorizeRequest(auth, bearerHeader(mintJwt()), { oauthVerifier: verifier });
		expect(decision.ok).toBe(true);
	});

	test("rejects a bad token as invalid_token", async () => {
		const auth: AuthConfig = { mode: "oauth", tokens: [], oauth };
		const verifier = createJwtVerifier(oauth, { fetcher });
		const decision = await authorizeRequest(auth, bearerHeader("not-a-jwt"), { oauthVerifier: verifier });
		expect(decision.reason).toBe("invalid_token");
	});

	test("missing token and missing verifier map correctly", async () => {
		const auth: AuthConfig = { mode: "oauth", tokens: [], oauth };
		expect((await authorizeRequest(auth, bearerHeader(undefined), {})).reason).toBe("missing_token");
		expect((await authorizeRequest(auth, bearerHeader(mintJwt()), {})).reason).toBe("auth_misconfigured");
	});

	test("bearer mode still works through the async wrapper", async () => {
		const decision = await authorizeRequest(bearerAuth(), bearerHeader(TOKEN), {});
		expect(decision.ok).toBe(true);
	});
});
