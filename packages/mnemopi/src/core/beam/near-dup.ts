import { sha256Hex16 } from "../../util/ids";

export interface NearDupMember {
	id: string;
	content: string;
	normalized: string;
	tokens: string[];
	shingles: Set<string>;
}

// Strip transcript envelope markers ([role: user], [user:end], timestamps like
// [2026-09-22T04:43]) and normalize case/whitespace so rolling snapshots of the
// same session collide on signature even when their wrappers drift.
export function normalizeDedupeText(content: string): string {
	return content
		.replace(/\[[^\]\n]{1,64}\]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

export function prefixSignature(content: string, prefixTokens = 24): string {
	const normalized = normalizeDedupeText(content);
	if (normalized.length === 0) return "";
	return normalized.split(" ").slice(0, Math.max(4, prefixTokens)).join(" ");
}

export function prefixHash(content: string, prefixTokens = 24): string {
	return sha256Hex16(prefixSignature(content, prefixTokens));
}

export function shingleSet(tokens: readonly string[], size = 8): Set<string> {
	const out = new Set<string>();
	if (tokens.length < size) return out;
	for (let i = 0; i + size <= tokens.length; i++) {
		out.add(tokens.slice(i, i + size).join(" "));
	}
	return out;
}

export function toNearDupMember(id: string, content: string, shingleSize = 8): NearDupMember {
	const normalized = normalizeDedupeText(content);
	const tokens = normalized.length === 0 ? [] : normalized.split(" ");
	return { id, content, normalized, tokens, shingles: shingleSet(tokens, shingleSize) };
}

/** Fraction of `member`'s shingles contained in `canonical` (Broder containment). */
export function containmentRatio(member: NearDupMember, canonical: NearDupMember): number {
	if (member.shingles.size === 0) {
		return canonical.normalized.includes(member.normalized) ? 1 : 0;
	}
	let hit = 0;
	for (const shingle of member.shingles) {
		if (canonical.shingles.has(shingle)) hit++;
	}
	return hit / member.shingles.size;
}
