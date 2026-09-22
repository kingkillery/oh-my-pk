import type { OperationalStore } from "./store";

export interface SchedulerTickOptions {
	readonly leaseOwner?: string;
	readonly leaseMs?: number;
	readonly maxAttemptsToStart?: number;
	readonly now?: number;
}

export interface SchedulerTickResult {
	readonly deliveredHandoffs: number;
	readonly startedAttempts: number;
	readonly reconciledLeases?: number;
}

/**
 * Continuous lifecycle scheduler (A08/C1).
 * Runs at startup and after each settlement/admission/cancellation:
 * reconcile expired work, drain the settlement outbox into exact-owner
 * inboxes, then claim dependency-ready authorized attempts in stable
 * readiness order until capacity. Starts work outside transactions;
 * per-task outcome normalization lives in the caller adapter.
 */
export function schedulerTick(store: OperationalStore, options: SchedulerTickOptions = {}): SchedulerTickResult {
	const leaseOwner = options.leaseOwner ?? "scheduler";
	const leaseMs = options.leaseMs ?? 60_000;
	const now = options.now ?? Date.now();
	let deliveredHandoffs = 0;
	let startedAttempts = 0;

	// 1. Reconcile expired job leases
	const reconciledLeases = store.reconcileExpiredLeases(now);

	// 2. Deliver pending handoffs from outbox into exact-owner inboxes
	const pending = store.listPendingHandoffs();
	for (const eventId of pending) {
		if (store.deliverLifecycleHandoff(eventId)) deliveredHandoffs += 1;
	}

	// 3. Claim dependency-ready native task jobs in deterministic order
	const readyJobs = store.listDependencyReadyNativeTaskJobs(options.maxAttemptsToStart ?? 10);
	for (const job of readyJobs) {
		const claimed = store.claimJobById(job.id, leaseOwner, leaseMs);
		if (claimed) {
			startedAttempts += 1;
		}
	}

	return { deliveredHandoffs, startedAttempts, reconciledLeases };
}
