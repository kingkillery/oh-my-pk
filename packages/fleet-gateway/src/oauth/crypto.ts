/**
 * Token and code primitives shared by the OAuth server and the CLI.
 * Everything durable is stored as a SHA-256 digest; the raw value leaves the
 * process exactly once, in the response or the terminal it was minted in.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function newToken(): string {
	return randomBytes(32).toString("base64url");
}

export function newId(): string {
	return randomBytes(16).toString("base64url");
}

export function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function hmac(key: string, value: string): string {
	return createHmac("sha256", key).update(value).digest("hex");
}

/** Constant-time compare for digests. */
export function digestEquals(a: string, b: string): boolean {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Crockford base32, unambiguous alphabet (no i, l, o, u). */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** A one-time approval code: 10 chars ≈ 50 bits, shown as XXXXX-XXXXX. */
export function newApprovalCode(): { code: string; display: string } {
	const bytes = randomBytes(10);
	let raw = "";
	for (const b of bytes) raw += CROCKFORD[b & 31];
	return { code: raw, display: `${raw.slice(0, 5)}-${raw.slice(5)}` };
}

/** Accept an approval code in any case or spacing; null when malformed. */
export function normalizeApprovalCode(input: string): string | null {
	const compact = input.toLowerCase().replace(/[^0-9a-z]/g, "");
	return /^[0-9a-hjkmnp-tv-z]{10}$/.test(compact) ? compact : null;
}

/** PKCE S256 check. */
export function pkceMatches(verifier: string, challenge: string): boolean {
	const digest = createHash("sha256").update(verifier).digest("base64url");
	return digest === challenge;
}
