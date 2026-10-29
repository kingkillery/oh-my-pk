/**
 * Minimal OAuth 2.1 access-token verification for `auth.mode = "oauth"`.
 *
 * The connector acts as an MCP protected resource server: ChatGPT completes the
 * authorization-code + PKCE flow with an external identity provider and presents
 * the issued JWT here. This module verifies RS256/ES256 signatures against the
 * authorization server's JWKS and enforces `exp`/`nbf`/`iss`/`aud` and all
 * configured scopes.
 */
import { constants, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { OAuthConfig } from "./config";

/** Transient authorization-server problem; mapped to a 503, not a 401. */
export class AuthorizationServerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthorizationServerError";
	}
}

/** The presented credential is malformed, mis-signed, or out of claims. */
export class InvalidTokenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidTokenError";
	}
}

/** Identity proven by a verified access token. */
export interface OAuthPrincipal {
	sub?: string;
	scopes: string[];
}

export interface JwtVerifier {
	verify(token: string): Promise<OAuthPrincipal>;
}

/** JSON Web Key as surfaced by a JWKS endpoint. */
interface Jwk {
	kty?: string;
	kid?: string;
	crv?: string;
	use?: string;
	alg?: string;
	[key: string]: unknown;
}

interface JsonWebKeySet {
	keys?: Jwk[];
}

export type JwksFetcher = (uri: string) => Promise<JsonWebKeySet>;

export interface JwtVerifierOptions {
	/** Injectable for tests; defaults to a 10s-timeout global fetch. */
	fetcher?: JwksFetcher;
	/** JWKS cache TTL; a `kid` miss also forces one refresh. Default 10 min. */
	cacheTtlMs?: number;
	/** Injectable clock (ms epoch) for tests. */
	now?: () => number;
}

const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const SUPPORTED_ALGS: Record<string, true> = { RS256: true, ES256: true };

const defaultFetcher: JwksFetcher = async uri => {
	const response = await fetch(uri, { signal: AbortSignal.timeout(10_000) });
	if (!response.ok) {
		throw new AuthorizationServerError(`JWKS fetch failed: HTTP ${response.status}`);
	}
	return (await response.json()) as JsonWebKeySet;
};

function decodeSegment(segment: string): unknown {
	const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
	try {
		return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
	} catch {
		throw new InvalidTokenError("access token is not a decodable JWT");
	}
}

function asClaims(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new InvalidTokenError("access token payload is not an object");
	}
	return value as Record<string, unknown>;
}

function keyToCryptoKey(jwk: Jwk): KeyObject {
	try {
		return createPublicKey({ key: jwk, format: "jwk" } as Parameters<typeof createPublicKey>[0]);
	} catch {
		throw new InvalidTokenError("JWKS key is not usable");
	}
}

function verifySignature(alg: string, key: KeyObject, data: string, signature: Buffer): boolean {
	try {
		if (alg === "RS256") {
			return cryptoVerify(
				"sha256",
				Buffer.from(data, "utf8"),
				{ key, padding: constants.RSA_PKCS1_PADDING },
				signature,
			);
		}
		// JWT carries the raw r||s form; OpenSSL expects it via ieee-p1363.
		return cryptoVerify("sha256", Buffer.from(data, "utf8"), { key, dsaEncoding: "ieee-p1363" }, signature);
	} catch {
		return false;
	}
}

function matchesKey(jwk: Jwk, alg: string, kid: string | undefined): boolean {
	if (kid !== undefined && jwk.kid !== kid) return false;
	if (jwk.use !== undefined && jwk.use !== "sig") return false;
	if (alg === "RS256") return jwk.kty === "RSA";
	return jwk.kty === "EC" && (jwk.crv === undefined || jwk.crv === "P-256");
}

function checkClaims(claims: Record<string, unknown>, oauth: OAuthConfig, nowSeconds: number): void {
	const skew = oauth.clockSkewSeconds ?? 60;
	if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
		throw new InvalidTokenError("access token expiry is required");
	}
	if (nowSeconds >= claims.exp + skew) {
		throw new InvalidTokenError("access token is expired");
	}
	if (typeof claims.nbf === "number" && nowSeconds + skew < claims.nbf) {
		throw new InvalidTokenError("access token is not yet valid");
	}
	if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf))) {
		throw new InvalidTokenError("access token not-before claim is invalid");
	}
	const issuers = oauth.issuer ?? [];
	if (issuers.length > 0 && (typeof claims.iss !== "string" || !issuers.includes(claims.iss))) {
		throw new InvalidTokenError("access token issuer is not accepted");
	}
	const audiences = oauth.audience ?? [];
	if (audiences.length > 0) {
		const aud = claims.aud;
		const presented = Array.isArray(aud)
			? aud.filter((v): v is string => typeof v === "string")
			: typeof aud === "string"
				? [aud]
				: [];
		if (!presented.some(entry => audiences.includes(entry))) {
			throw new InvalidTokenError("access token audience does not match this resource");
		}
	}
}

function readScopes(claims: Record<string, unknown>): string[] {
	const scope = claims.scope;
	if (typeof scope === "string") return scope.split(/\s+/).filter(Boolean);
	const scp = claims.scp;
	if (Array.isArray(scp)) return scp.filter((v): v is string => typeof v === "string");
	return [];
}

/**
 * Build a verifier for one OAuth configuration. The verifier owns the JWKS
 * cache, so create it once per server — not per request.
 */
export function createJwtVerifier(oauth: OAuthConfig, options: JwtVerifierOptions = {}): JwtVerifier {
	const fetcher = options.fetcher ?? defaultFetcher;
	const now = options.now ?? Date.now;
	const cacheTtlMs = options.cacheTtlMs ?? JWKS_CACHE_TTL_MS;
	let cached: { keys: Jwk[]; fetchedAt: number } | undefined;

	async function loadKeys(force: boolean): Promise<Jwk[]> {
		if (!force && cached && now() - cached.fetchedAt < cacheTtlMs) return cached.keys;
		if (!oauth.jwksUri) throw new AuthorizationServerError("auth.oauth.jwksUri is not configured");
		let document: JsonWebKeySet;
		try {
			document = await fetcher(oauth.jwksUri);
		} catch (error) {
			if (error instanceof AuthorizationServerError) throw error;
			throw new AuthorizationServerError(
				`JWKS fetch failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!Array.isArray(document.keys)) {
			throw new AuthorizationServerError("JWKS document did not contain a keys array");
		}
		cached = { keys: document.keys, fetchedAt: now() };
		return cached.keys;
	}

	return {
		async verify(token: string): Promise<OAuthPrincipal> {
			const parts = token.split(".");
			if (parts.length !== 3 || parts.some(part => part.length === 0)) {
				throw new InvalidTokenError("access token is not a JWT");
			}
			const header = asClaims(decodeSegment(parts[0]));
			const claims = asClaims(decodeSegment(parts[1]));
			const alg = typeof header.alg === "string" ? header.alg : "";
			if (!SUPPORTED_ALGS[alg]) {
				throw new InvalidTokenError(`access token alg "${alg}" is not supported (RS256/ES256 only)`);
			}
			const kid = typeof header.kid === "string" ? header.kid : undefined;
			const signature = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");

			let candidates = (await loadKeys(false)).filter(jwk => matchesKey(jwk, alg, kid));
			if (candidates.length === 0 && kid !== undefined) {
				// Signing keys rotate; one forced refresh before giving up.
				candidates = (await loadKeys(true)).filter(jwk => matchesKey(jwk, alg, kid));
			}
			const data = `${parts[0]}.${parts[1]}`;
			const matched = candidates.some(jwk => verifySignature(alg, keyToCryptoKey(jwk), data, signature));
			if (!matched) throw new InvalidTokenError("access token signature is invalid");

			checkClaims(claims, oauth, now() / 1000);
			const scopes = readScopes(claims);
			if (oauth.scopes?.some(scope => !scopes.includes(scope)))
				throw new InvalidTokenError("access token lacks required scope");
			return { sub: typeof claims.sub === "string" ? claims.sub : undefined, scopes };
		},
	};
}
