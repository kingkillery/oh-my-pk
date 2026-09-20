import type { LifecycleAdmissionResult } from "../operational/lifecycle-types";
import type { OperationalStore } from "../operational/store";
import type { LaunchCompileInput, LaunchContractDiagnostic, ReservationVector } from "./launch-contract";
import { compileLaunchContract } from "./launch-contract";
import type { SpawnPlan } from "./spawn-plan";

export interface LaunchAdmissionRequest {
	readonly spawnPlan: SpawnPlan;
	readonly compileInput: LaunchCompileInput;
	readonly ownerNodeId: string | null;
	readonly runId: string;
	readonly idempotencyKey: string;
	readonly reservation: ReservationVector;
	readonly prerequisiteIds: readonly string[];
	readonly expectedPlanVersion: number;
	readonly expectedCancellationGeneration: number;
	readonly confinedBackendAvailable?: boolean;
}

export type PrepareLifecycleLaunchResult =
	| { readonly ok: true; readonly launch: LifecycleAdmissionResult }
	| { readonly ok: false; readonly diagnostics: readonly LaunchContractDiagnostic[] };

/**
 * Single coordinated lifecycle admission path (A02/B1).
 * Runs in strict order: mission compilation → store admission → binding.
 * Provisioning (sessions, worktrees, outputs) happens in the caller, after
 * a successful return. Allocates no sessions, worktrees, or outputs itself.
 */
export function prepareLifecycleLaunch(
	store: OperationalStore,
	request: LaunchAdmissionRequest,
): PrepareLifecycleLaunchResult {
	if (!request.runId.trim() || !request.idempotencyKey.trim()) {
		return {
			ok: false,
			diagnostics: [{ code: "missing_admission_identity", message: "runId and idempotencyKey are required." }],
		};
	}
	void request.spawnPlan;
	if (request.compileInput.policy.isolationLevel === "confined" && !request.confinedBackendAvailable) {
		return {
			ok: false,
			diagnostics: [
				{
					code: "required_isolation_unavailable",
					message: "Confined execution requires a verified backend; no downgrade performed.",
				},
			],
		};
	}
	const compiled = compileLaunchContract(request.compileInput);
	if (!compiled.ok) {
		return { ok: false, diagnostics: compiled.diagnostics };
	}
	const result = store.admitLifecycleAttempt({
		runId: request.runId,
		ownerNodeId: request.ownerNodeId ?? `${request.runId}-root`,
		nodeId: null,
		idempotencyKey: request.idempotencyKey,
		compiled: compiled.compiled,
		expectedPlanVersion: request.expectedPlanVersion,
		expectedCancellationGeneration: request.expectedCancellationGeneration,
		reservation: request.reservation,
		prerequisiteIds: request.prerequisiteIds,
	});
	if (!result.ok) {
		return {
			ok: false,
			diagnostics: [{ code: result.code, message: result.message }],
		};
	}
	return { ok: true, launch: result };
}
