/**
 * Coordinated lifecycle launch admission (A02/B1, §4.3/§4.4).
 *
 * Single synchronous coordinator between allocation-free preflight and
 * provisioning. Strict order: compile → admit authority → activate binding.
 * Provisioning (sessions, worktrees, outputs) happens in the caller AFTER a
 * successful return; this module allocates no sessions or worktrees itself.
 *
 * Fail-closed rules honored here:
 * - `owner: null` is legal ONLY for the authenticated root factory path and
 *   routes to `createLifecycleRun`; every delegated child carries a
 *   registered `LifecycleExecutionContext` whose registration supplies the
 *   mutation guard's actor and expected policy epoch.
 * - A child is never exposed before `activateLaunchBinding` records
 *   host-measured guarantees: admission commits an `authorized` binding,
 *   activation moves it to `bound`. An activation refusal leaves the
 *   authorized binding row as the failed-attempt audit identity — no live
 *   unscoped child, no silent fallback to legacy admission.
 */

import type { LaunchMutationGuard } from "../operational/lifecycle-types";
import type { OperationalStore } from "../operational/store";
import type { DurableJob } from "../operational/types";
import type { LifecycleExecutionContext, RootExecutionContext } from "../orchestration/lifecycle-authority";
import { getLifecycleRegistration } from "../orchestration/lifecycle-authority";
import type {
	ArtifactRefV1,
	LaunchCompileInput,
	LaunchContract,
	LaunchContractDiagnostic,
	ReservationVector,
	RuntimeGuaranteesV1,
} from "./launch-contract";
import { compileLaunchContract } from "./launch-contract";
import type { SpawnPlan } from "./spawn-plan";

/**
 * Host-registered confined-backend handle (§14.6). Registered by the host
 * after probing; never accepted as a model-supplied boolean.
 */
export interface ConfinedBackendHandle {
	readonly backendId: string;
	readonly probeDigest: string;
}

export interface LaunchAdmissionRequest {
	/** Allocation-free route/profile proposal from `createSpawnPlan`. */
	readonly spawnPlan: SpawnPlan;
	/** Capsule + policy + authenticated authorization snapshot for the compiler. */
	readonly compileInput: LaunchCompileInput;
	/**
	 * Registered parent execution context. `null` is legal ONLY from the
	 * authenticated root factory (`createLifecycleRun`); a delegated child
	 * always supplies its owner's context so the guard authenticates.
	 */
	readonly owner: LifecycleExecutionContext | RootExecutionContext | null;
	readonly idempotencyKey: string;
	readonly reservation: ReservationVector;
	readonly prerequisiteIds: readonly string[];
	/** Runtime-only services and host-measured inputs; never model data. */
	readonly services: {
		readonly confinedBackend: ConfinedBackendHandle | null;
		/**
		 * Host-measured runtime guarantees (probe results). Required for a
		 * delegated child: activation refuses to bind a contract whose
		 * guarantees nobody measured.
		 */
		readonly measuredGuarantees?: RuntimeGuaranteesV1;
		/** Evidence refs backing the measured guarantees; activation requires a non-empty set. */
		readonly guaranteeEvidenceRefs?: readonly ArtifactRefV1[];
		/** Pre-allocated durable session identity recorded on the binding at activation. */
		readonly sessionId?: string;
		readonly processRef?: string | null;
	};
	/** Set only by trusted revive/restore flows that rebind recorded lineage. */
	readonly restoresBindingId?: string | null;
}

export type PrepareLifecycleLaunchResult =
	| {
			readonly ok: true;
			readonly launch: LaunchContract;
			readonly job: DurableJob | null;
			readonly plan: SpawnPlan;
	  }
	| {
			readonly ok: false;
			readonly code: string;
			readonly diagnostics: readonly LaunchContractDiagnostic[];
	  };

function failure(
	code: string,
	message: string,
	path?: string,
): { readonly ok: false; readonly code: string; readonly diagnostics: readonly LaunchContractDiagnostic[] } {
	return {
		ok: false,
		code,
		diagnostics: Object.freeze([path === undefined ? { code, message } : { code, message, path }]),
	};
}

/**
 * Compile → admit → activate a launch. Synchronous: store transactions
 * contain no awaits, and all profile/artifact/realpath/backend preflight is
 * the caller's async, allocation-free responsibility BEFORE this call.
 */
export function prepareLifecycleLaunch(
	store: OperationalStore,
	request: LaunchAdmissionRequest,
	signal?: AbortSignal,
): PrepareLifecycleLaunchResult {
	if (signal?.aborted) {
		return failure("launch_aborted", "Launch aborted before admission.");
	}
	if (!request.idempotencyKey.trim()) {
		return failure("missing_admission_identity", "idempotencyKey is required.", "idempotencyKey");
	}
	if (request.compileInput.policy.isolationLevel === "confined" && !request.services.confinedBackend) {
		return failure(
			"required_isolation_unavailable",
			"Confined execution requires a verified backend; no downgrade performed.",
			"policy.isolationLevel",
		);
	}

	const compiled = compileLaunchContract(request.compileInput);
	if (!compiled.ok) {
		return {
			ok: false,
			code: compiled.diagnostics[0]?.code ?? "compile_failed",
			diagnostics: compiled.diagnostics,
		};
	}
	if (signal?.aborted) {
		return failure("launch_aborted", "Launch aborted after compilation, before admission.");
	}

	if (request.owner === null) {
		// Authenticated root factory: the only legal ownerless launch. The run
		// id derives deterministically from the contract identity — never a
		// synthetic caller-supplied root string.
		const runId = `run-${compiled.compiled.contractId}`;
		const created = store.createLifecycleRun(
			runId,
			compiled.compiled,
			compiled.compiled.policy.limits,
			request.idempotencyKey,
		);
		if (!created.ok) {
			return {
				ok: false,
				code: created.code,
				diagnostics: Object.freeze([{ code: created.code, message: created.message }]),
			};
		}
		return { ok: true, launch: created.launch, job: created.job, plan: request.spawnPlan };
	}

	// Delegated child: the owner context must be a live registration. A forged
	// or revoked handle cannot authenticate the mutation guard.
	const registration = getLifecycleRegistration(request.owner);
	if (!registration) {
		return failure(
			"missing_lifecycle_binding",
			"owner lifecycle context is not registered; refusing unauthenticated admission.",
			"owner",
		);
	}
	const guard: LaunchMutationGuard = {
		actor: request.owner,
		expectedPolicyEpoch: registration.policyEpoch,
		idempotencyKey: request.idempotencyKey,
	};

	// Activation inputs are host-measured, so they are required up front:
	// admitting first and discovering no probe results would strand an
	// authorized binding nobody can honestly activate.
	const measured = request.services.measuredGuarantees;
	const evidence = request.services.guaranteeEvidenceRefs ?? [];
	const sessionId = request.services.sessionId;
	if (!measured || evidence.length === 0 || !sessionId) {
		return failure(
			"missing_required_input",
			"delegated activation requires host-measured guarantees, guarantee evidence refs and a session id.",
			"services",
		);
	}

	// Step 2 (§14.5): commit the contract + an `authorized` binding. Authority
	// only — `lifecycle: null` because this child carries no scheduler job;
	// the durable audit job below is the execution record.
	const admitted = store.admitLaunchAuthority({
		guard,
		compiled: compiled.compiled,
		reservation: request.reservation,
		lifecycle: null,
		restoresBindingId: request.restoresBindingId ?? null,
	});
	if (!admitted.ok) {
		return { ok: false, code: admitted.code, diagnostics: admitted.diagnostics };
	}
	// The durable record names its own binding. The archival envelope
	// overloaded `attemptId` to carry it on this authority-only path; the v2
	// wire keeps the two separate, so read `bindingId` explicitly.
	const bindingId = admitted.launch.binding.bindingId;
	if (signal?.aborted) {
		// Fenced, idempotent terminalization: the committed binding must not
		// stay `authorized` (activatable) after the launch was aborted.
		store.terminateLaunchBinding({
			guard,
			bindingId,
			targetState: "failed",
			reason: "launch aborted after admission",
		});
		return failure(
			"launch_aborted",
			`Launch aborted after admission; binding '${bindingId}' terminalized as the failed-attempt audit identity.`,
		);
	}

	// Steps 3-4 (§14.5): record measured guarantees and move the binding to
	// `bound`. A refusal leaves the authorized row as audit — never a live
	// unscoped child and never a legacy fallback.
	const activated = store.activateLaunchBinding({
		guard,
		bindingId,
		expectedState: "authorized",
		sessionId,
		processRef: request.services.processRef ?? null,
		serviceBindings: [],
		actualRuntimeGuarantees: measured,
		guaranteeEvidenceRefs: evidence,
	});
	if (!activated.ok) {
		// Activation refusal terminalizes the authorized binding: it stays as
		// the failed-attempt audit row, never a live unscoped child and never
		// a legacy fallback. The ORIGINAL refusal code is returned.
		store.terminateLaunchBinding({
			guard,
			bindingId,
			targetState: "failed",
			reason: `activation refused: ${activated.code}`,
		});
		return { ok: false, code: activated.code, diagnostics: activated.diagnostics };
	}

	// §14.6: authority-only helper/compatibility admission carries no
	// scheduler job — the durable binding row IS the execution record, so
	// `job` is null rather than a consumer-less `launch_authority` row.
	return { ok: true, launch: activated.launch, job: null, plan: request.spawnPlan };
}
