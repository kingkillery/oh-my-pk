export interface ArtifactGrantV1 {
	readonly grantId: string;
	readonly runId: string;
	readonly ownerNodeId: string | null;
	readonly resourceIdentity: string;
	readonly resourceHash: string;
	readonly rights: readonly ("read" | "transfer")[];
	readonly maxReadBytes: number | null;
	readonly expiresAt: number | null;
	readonly revoked: boolean;
	readonly provenance: readonly string[];
}

export type GrantDecision =
	| { readonly allowed: true }
	| { readonly allowed: false; readonly code: string; readonly reason: string };

/**
 * Scoped artifact/memory grant check (A14).
 * Grants bind resource ID + digest, owner/caller lifecycle, rights, bounds,
 * expiry, and revocation. Empty/missing grants deny, except explicit legacy
 * compatibility selected by the caller. Lazy discoverability is never
 * authorization: enumeration without a grant always fails.
 */
export function authorizeGrantAccess(
	grant: ArtifactGrantV1 | null,
	request: {
		runId: string;
		nodeId: string;
		resourceIdentity: string;
		resourceHash: string;
		right: "read" | "transfer";
		bytes: number;
		now: number;
	},
): GrantDecision {
	if (!grant) {
		return { allowed: false, code: "missing_grant", reason: "No grant authorizes this access." };
	}
	if (grant.revoked) {
		return { allowed: false, code: "grant_revoked", reason: "Grant was revoked." };
	}
	if (grant.runId !== request.runId) {
		return { allowed: false, code: "grant_run_mismatch", reason: "Grant belongs to a different run." };
	}
	if (grant.resourceIdentity !== request.resourceIdentity || grant.resourceHash !== request.resourceHash) {
		return { allowed: false, code: "grant_resource_mismatch", reason: "Grant does not cover this exact resource." };
	}
	if (!grant.rights.includes(request.right)) {
		return { allowed: false, code: "grant_right_missing", reason: `Grant lacks the ${request.right} right.` };
	}
	if (grant.ownerNodeId !== null && grant.ownerNodeId !== request.nodeId && request.right === "transfer") {
		return { allowed: false, code: "grant_owner_mismatch", reason: "Only the owner node may transfer this grant." };
	}
	if (grant.maxReadBytes !== null && request.bytes > grant.maxReadBytes) {
		return { allowed: false, code: "grant_bounds_exceeded", reason: "Request exceeds grant byte bounds." };
	}
	if (grant.expiresAt !== null && request.now > grant.expiresAt) {
		return { allowed: false, code: "grant_expired", reason: "Grant expired." };
	}
	return { allowed: true };
}

export function denyEnumeration(): GrantDecision {
	return {
		allowed: false,
		code: "enumeration_denied",
		reason: "Sibling artifacts are not enumerable without an explicit grant.",
	};
}
