/** Authority-only contracts. No scheduler, grant or publication dependency. */
import type { LifecycleExecutionContext, RootExecutionContext } from "../orchestration/lifecycle-authority";
import type {
	ArtifactRefV1,
	CompiledLaunchContract,
	LaunchBinding,
	LaunchBindingState,
	LaunchClass,
	LaunchContract,
	LaunchContractDiagnostic,
	ReservationVector,
	RuntimeGuaranteesV1,
} from "../task/launch-contract";

export interface LaunchMutationGuard {
	readonly actor: LifecycleExecutionContext | RootExecutionContext;
	readonly expectedPolicyEpoch: number;
	readonly idempotencyKey: string;
}
export interface LaunchAuthorityFailure {
	readonly ok: false;
	readonly code: string;
	readonly diagnostics: readonly LaunchContractDiagnostic[];
}
export interface LaunchAuthorityAdmissionInput {
	readonly guard: LaunchMutationGuard;
	readonly compiled: CompiledLaunchContract;
	readonly reservation: ReservationVector;
	/** IDs only: jobs/reservations belong to the legacy operational database. */
	readonly lifecycle: {
		readonly runId: string;
		readonly nodeId: string;
		readonly ownerNodeId: string | null;
		readonly jobId: string;
		readonly attemptId: string;
		readonly leaseEpoch: number;
		readonly cancellationGeneration: number;
		readonly reservationId: string;
	} | null;
	readonly restoresBindingId: string | null;
}
export type LaunchAuthorityAdmissionResult =
	| { readonly ok: true; readonly launch: LaunchContract; readonly replayed: boolean }
	| LaunchAuthorityFailure;
export interface LaunchBindingActivationInput {
	readonly guard: LaunchMutationGuard;
	readonly bindingId: string;
	readonly expectedState: "authorized" | "bound";
	readonly sessionId: string;
	readonly processRef: string | null;
	readonly serviceBindings: LaunchBinding["serviceBindings"];
	readonly actualRuntimeGuarantees: RuntimeGuaranteesV1;
	readonly guaranteeEvidenceRefs: readonly ArtifactRefV1[];
}
export type LaunchBindingActivationResult = LaunchAuthorityAdmissionResult;
export interface LaunchPrincipalRow {
	readonly principalId: string;
	readonly rootPrincipalId: string | null;
	readonly parentPrincipalId: string | null;
	readonly launchClass: LaunchClass | null;
	readonly authorityEnvelopeRef: string | null;
	readonly policyEpoch: number;
	readonly status: "active" | "revoked" | "terminal";
	readonly createdAt: number;
	readonly updatedAt: number;
}
export type LaunchBindingTerminationResult =
	| { readonly ok: true; readonly bindingId: string; readonly state: LaunchBindingState; readonly policyEpoch: number }
	| LaunchAuthorityFailure;
