/**
 * Recovery decision helper (A12/C2).
 *
 * The `RecoveryCapsuleV1` record itself is declared once, in
 * `operational/lifecycle-types.ts`, because the capsule is a persisted
 * lifecycle record and its `remainingReservation` must carry the full
 * `ReservationVector` (requests, runtimeMs, tokens, costMicrounits). The
 * former local copy here omitted tokens and cost, which would silently drop
 * two budget dimensions on every recovery round-trip.
 */

export type RecoveryDecisionV1 =
	| { readonly kind: "continue-attempt" }
	| { readonly kind: "new-attempt"; readonly reason: string }
	| { readonly kind: "blocked"; readonly reason: string };

/**
 * Recovery capsule and fencing decisions (A12/C2).
 * Same-attempt continuation requires a live lease, unchanged contract, and
 * verified retained workspace/context; process loss or an expired lease
 * creates a new attempt under parent budget with incremented epoch and
 * explicit supersession. Old results/callbacks can never mutate new state.
 * Unavailable pinned manifests block with missing_pinned_manifest — current
 * defaults are never substituted.
 */
export function decideRecovery(input: {
	leaseLive: boolean;
	contractUnchanged: boolean;
	workspaceRetained: boolean;
	pinnedManifestAvailable: boolean;
}): RecoveryDecisionV1 {
	if (!input.pinnedManifestAvailable) {
		return { kind: "blocked", reason: "missing_pinned_manifest" };
	}
	if (input.leaseLive && input.contractUnchanged && input.workspaceRetained) {
		return { kind: "continue-attempt" };
	}
	if (!input.leaseLive) {
		return { kind: "new-attempt", reason: "lease_expired" };
	}
	if (!input.contractUnchanged) {
		return { kind: "new-attempt", reason: "contract_changed" };
	}
	return { kind: "new-attempt", reason: "workspace_not_retained" };
}
