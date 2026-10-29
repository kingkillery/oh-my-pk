/**
 * Bearer-token gate for the connector's HTTP surface.
 *
 * Tokens are compared with a constant-time primitive so a caller cannot learn a
 * valid token by measuring response times. A request is authorized when its
 * header (or, when explicitly enabled, its query token) matches any configured
 * token.
 */
import { timingSafeEqual } from "node:crypto";
import { AuthorizationServerError, type JwtVerifier } from "./auth-jwt";
import type { AuthConfig } from "./config";

export interface AuthDecision {
	ok: boolean;
	/** Machine-readable reason for a rejection; safe to return in a 401 body. */
	reason?: "missing_token" | "invalid_token" | "auth_misconfigured";
	/** The credential to echo in `WWW-Authenticate`, when the header was malformed. */
	headerPresent?: boolean;
}

const BEARER_PREFIX = "bearer ";

function safeEqual(candidate: string, expected: string): boolean {
	const candidateBytes = Buffer.from(candidate);
	const expectedBytes = Buffer.from(expected);
	// timingSafeEqual requires equal lengths; compare a fixed-size digest of both
	// so the length of a valid token does not leak through an early return.
	const left = Buffer.from(candidateBytes.length.toString().padStart(4, "0") + candidate);
	const right = Buffer.from(expectedBytes.length.toString().padStart(4, "0") + expected);
	const size = Math.max(left.length, right.length);
	const paddedLeft = Buffer.alloc(size);
	const paddedRight = Buffer.alloc(size);
	left.copy(paddedLeft);
	right.copy(paddedRight);
	const equal = timingSafeEqual(paddedLeft, paddedRight);
	return equal && candidateBytes.length === expectedBytes.length;
}

/** Extract the raw credential from an Authorization header value. */
export function readBearer(header: string | null | undefined): string | undefined {
	if (!header) return undefined;
	const trimmed = header.trim();
	if (trimmed.length <= BEARER_PREFIX.length) return undefined;
	if (!trimmed.toLowerCase().startsWith(BEARER_PREFIX)) return undefined;
	const token = trimmed.slice(BEARER_PREFIX.length).trim();
	return token.length > 0 ? token : undefined;
}

/**
 * Decide whether a request may proceed.
 *
 * `auth.mode = "none"` allows everything. In bearer mode an empty token list is
 * a misconfiguration: failing closed keeps an accidentally unauthenticated
 * server from executing agent sessions.
 */
export function authorize(
	auth: AuthConfig,
	headers: Headers | Record<string, string | undefined>,
	queryToken?: string | null,
): AuthDecision {
	if (auth.mode === "none") return { ok: true };
	if (auth.mode === "oauth") {
		const headerValue =
			headers instanceof Headers ? headers.get("authorization") : (headers.authorization ?? headers.Authorization);
		return {
			ok: false,
			reason: readBearer(headerValue) ? "invalid_token" : "missing_token",
			headerPresent: Boolean(headerValue),
		};
	}
	if (auth.tokens.length === 0) return { ok: false, reason: "auth_misconfigured" };

	const headerValue =
		headers instanceof Headers ? headers.get("authorization") : (headers.authorization ?? headers.Authorization);
	const fromHeader = readBearer(headerValue);
	if (fromHeader && auth.tokens.some(token => safeEqual(fromHeader, token))) return { ok: true };
	if (auth.allowQueryToken && queryToken && auth.tokens.some(token => safeEqual(queryToken, token))) {
		return { ok: true };
	}
	return { ok: false, reason: fromHeader ? "invalid_token" : "missing_token", headerPresent: Boolean(headerValue) };
}

/**
 * Async authorization covering every mode. `bearer`/`none` delegate to the sync
 * `authorize`; `oauth` verifies the presented JWT through the supplied verifier
 * (created once per server so its JWKS cache is shared). A verifier that cannot
 * reach the authorization server maps to `auth_misconfigured` → HTTP 503.
 */
export async function authorizeRequest(
	auth: AuthConfig,
	headers: Headers | Record<string, string | undefined>,
	options: { queryToken?: string | null; oauthVerifier?: JwtVerifier },
): Promise<AuthDecision> {
	if (auth.mode !== "oauth") return authorize(auth, headers, options.queryToken);

	const headerValue =
		headers instanceof Headers ? headers.get("authorization") : (headers.authorization ?? headers.Authorization);
	const token = readBearer(headerValue);
	if (!token) return { ok: false, reason: "missing_token", headerPresent: Boolean(headerValue) };
	const verifier = options.oauthVerifier;
	if (!verifier) return { ok: false, reason: "auth_misconfigured" };
	try {
		await verifier.verify(token);
		return { ok: true };
	} catch (error) {
		if (error instanceof AuthorizationServerError) return { ok: false, reason: "auth_misconfigured" };
		return { ok: false, reason: "invalid_token", headerPresent: true };
	}
}

/** Redact a token for logs and setup output. */
export function redactToken(token: string): string {
	if (token.length <= 8) return "***";
	return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
