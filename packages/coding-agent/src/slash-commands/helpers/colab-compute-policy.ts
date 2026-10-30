/** Compute permission is separate from tool approval. No allocation or provider fallback here. */
export const DEFAULT_COMPUTE_MINUTES = 60;
export const MAX_COMPUTE_MINUTES = 120;
export const COMPUTE_CLEANUP_MINUTES = 5;
export interface ComputeRequest {
	taskId: string;
	account: string;
	model: string;
	accelerator: string;
	sessionName: string;
	minutes?: number;
}
export type ComputeChoice = "once" | "window" | "deny";
export type ComputeConfirmation = (request: Readonly<ComputeRequest>, summary: string) => Promise<ComputeChoice>;
export interface ComputeLease {
	readonly cutoffAt: string;
	readonly hardDeadlineAt: string;
	readonly request: Readonly<ComputeRequest>;
}
interface Grant {
	request: Readonly<ComputeRequest>;
	deadline: number;
	repeated: boolean;
}
const leases = new WeakSet<ComputeLease>();
export function computeMinutes(minutes = DEFAULT_COMPUTE_MINUTES): number {
	if (!Number.isInteger(minutes) || minutes < 10 || minutes > MAX_COMPUTE_MINUTES)
		throw new Error("Colab compute requires 10-120 minutes including cleanup; default is 60.");
	return minutes;
}
export function assertComputeLease(
	lease: ComputeLease | undefined,
	request: ComputeRequest,
	now = Date.now(),
): asserts lease is ComputeLease {
	if (
		!lease ||
		!leases.has(lease) ||
		!sameScope(lease.request, request) ||
		lease.request.sessionName !== request.sessionName ||
		!Number.isFinite(Date.parse(lease.cutoffAt)) ||
		Date.parse(lease.cutoffAt) <= now
	)
		throw new Error("Colab compute approval is missing, expired, or outside its approved scope.");
}
function sameScope(a: Readonly<ComputeRequest>, b: Readonly<ComputeRequest>): boolean {
	return (
		a.taskId === b.taskId &&
		a.account === b.account &&
		a.model === b.model &&
		a.accelerator === b.accelerator &&
		computeMinutes(a.minutes) === computeMinutes(b.minutes)
	);
}
/** One controller per harness task. Restarting the harness discards permission and asks again. */
export class ColabComputePolicy {
	#grants: Grant[] = [];
	#busy = false;
	#active = new Map<string, ComputeLease>();
	constructor(readonly now: () => number = Date.now) {}
	async authorize(
		request: ComputeRequest,
		confirm: ComputeConfirmation | undefined,
		arm: (sessionName: string, cutoffAt: string) => Promise<{ cutoffAt: string }>,
	): Promise<ComputeLease> {
		if (this.#busy) throw new Error("Another Colab approval/allocation is already pending in this task.");
		this.#busy = true;
		try {
			const minutes = computeMinutes(request.minutes);
			for (const field of [request.taskId, request.account, request.model, request.accelerator, request.sessionName])
				if (!field?.trim())
					throw new Error("Compute scope requires task, account, model, accelerator and session.");
			const scope = Object.freeze({ ...request, minutes });
			const prior = this.#active.get(scope.sessionName);
			if (prior) {
				assertComputeLease(prior, scope, this.now());
				const verified = await arm(scope.sessionName, prior.cutoffAt);
				if (verified.cutoffAt !== prior.cutoffAt) throw new Error("Shutdown guard changed the original deadline.");
				return prior;
			}
			if (this.#active.size > 0)
				throw new Error(
					"Compute concurrency limit is one. Confirm release of the owned runtime before another allocation.",
				);
			let grant = this.#grants.find(
				g => g.repeated && sameScope(g.request, scope) && g.deadline - COMPUTE_CLEANUP_MINUTES * 60000 > this.now(),
			);
			if (!grant) {
				const summary = `Allocate Colab compute? Task: ${scope.taskId}; account: ${scope.account}; model: ${scope.model}; accelerator: ${scope.accelerator}; session: ${scope.sessionName}; total maximum: ${minutes} minutes including ${COMPUTE_CLEANUP_MINUTES} minutes cleanup. Compute units may be consumed; estimate unavailable. No paid-provider or accelerator fallback. General full approval does not authorize compute.`;
				const choice = (await confirm?.(scope, summary)) ?? "deny";
				if (choice !== "once" && choice !== "window")
					throw new Error("Colab compute requires explicit user approval; no allocation was authorized.");
				grant = { request: scope, repeated: choice === "window", deadline: this.now() + minutes * 60000 };
				this.#grants.push(grant);
			}
			const hardDeadlineAt = new Date(grant.deadline).toISOString();
			const cutoffAt = new Date(grant.deadline - COMPUTE_CLEANUP_MINUTES * 60000).toISOString();
			const armed = await arm(scope.sessionName, cutoffAt);
			if (armed.cutoffAt !== cutoffAt || Date.parse(cutoffAt) <= this.now())
				throw new Error("Shutdown guard did not verify the approved immutable deadline.");
			const lease = Object.freeze({ request: scope, cutoffAt, hardDeadlineAt });
			leases.add(lease);
			this.#active.set(scope.sessionName, lease);
			return lease;
		} finally {
			this.#busy = false;
		}
	}
	/** Only call with an actual release receipt, never merely after sending stop. */
	confirmSessionReleased(sessionName: string, confirmedUnassigned: boolean): void {
		const lease = this.#active.get(sessionName);
		if (lease) this.confirmReleased(lease, confirmedUnassigned);
	}
	confirmReleased(lease: ComputeLease, confirmedUnassigned: boolean): void {
		if (!leases.has(lease) || !confirmedUnassigned) throw new Error("Runtime release is not confirmed.");
		if (this.#active.get(lease.request.sessionName) === lease) this.#active.delete(lease.request.sessionName);
	}
}
