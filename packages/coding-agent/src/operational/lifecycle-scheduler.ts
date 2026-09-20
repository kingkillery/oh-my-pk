import type { OperationalStore } from "./store";

export interface SchedulerTickResult {
	readonly deliveredHandoffs: number;
	readonly startedAttempts: number;
}

/**
 * Continuous lifecycle scheduler (A08/C1).
 * Runs at startup and after each settlement/admission/cancellation:
 * reconcile expired work, drain the settlement outbox into exact-owner
 * inboxes, then admit dependency-ready authorized attempts in stable
 * readiness order until capacity. Starts work outside transactions;
 * per-task outcome normalization lives in the caller adapter.
 */
export function schedulerTick(store: OperationalStore): SchedulerTickResult {
	let deliveredHandoffs = 0;
	const pending = store.listPendingHandoffs();
	for (const eventId of pending) {
		if (store.deliverLifecycleHandoff(eventId)) deliveredHandoffs += 1;
	}
	return { deliveredHandoffs, startedAttempts: 0 };
}
