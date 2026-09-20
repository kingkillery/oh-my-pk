import type { LifecycleRunSnapshot } from "../operational/lifecycle-types";
import { LifecycleReadError, type OperationalStore } from "../operational/store";

export interface LifecycleNodeView {
	readonly nodeId: string;
	readonly ownerNodeId: string | null;
	readonly role: string;
	readonly plannerActivity: string;
	readonly attempts: readonly {
		readonly attemptId: string;
		readonly execution: string;
		readonly capture: string;
		readonly delivery: string;
		readonly publication: string;
		readonly verification: string;
	}[];
}

export interface LifecycleRunView {
	readonly snapshot: LifecycleRunSnapshot;
	readonly nodes: readonly LifecycleNodeView[];
	readonly pendingHandoffs: readonly string[];
}

/**
 * Truthful operator read view (A15/F0).
 * The UI derives its tree and badges from this snapshot: execution vs
 * delivered vs accepted stay distinct, and poll acknowledgement is never
 * presented as durable consumption. No worker prompt content is included.
 *
 * `null` means the run genuinely does not exist. A run that exists but whose
 * records are incomplete or unprojectable propagates its read error instead,
 * so a corrupt run can never render as "no such run".
 */
export function getLifecycleRunView(store: OperationalStore, runId: string): LifecycleRunView | null {
	let snapshot: LifecycleRunSnapshot;
	try {
		snapshot = store.getLifecycleRunSnapshot(runId);
	} catch (error) {
		if (error instanceof LifecycleReadError && error.code === "run_not_found") return null;
		throw error;
	}
	const nodes: LifecycleNodeView[] = store.listLifecycleNodes(runId).map(node => ({
		...node,
		attempts: store.listLifecycleAttempts(node.nodeId),
	}));
	return { snapshot, nodes, pendingHandoffs: store.listPendingHandoffs() };
}
