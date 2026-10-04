import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LaunchMutationGuard } from "../operational/launch-authority-types";
import type { LifecycleStore } from "../operational/lifecycle-store";
import {
	getLifecycleRegistration,
	type LifecycleExecutionContext,
	type RootExecutionContext,
	registerLiveBindingValidator,
	resolvePersistedLifecycleContext,
} from "../orchestration/lifecycle-authority";
import { registerLifecycleDispatchLimits } from "../orchestration/lifecycle-tool-guard";
import { writeContentAddressedFile } from "../utils/content-addressed-file";
import {
	type ArtifactRefV1,
	canonicalJson,
	compileLaunchContract,
	type LaunchCompileInput,
	type LaunchContract,
	type LaunchContractDiagnostic,
	type ReservationVector,
	type RuntimeGuaranteesV1,
	sha256Hex,
} from "./launch-contract";

export interface PendingLifecycleLaunch {
	readonly store: LifecycleStore;
	readonly guard: LaunchMutationGuard;
	readonly launch: LaunchContract;
	readonly actualRuntimeGuarantees: RuntimeGuaranteesV1;
	readonly guaranteeEvidenceRefs: readonly ArtifactRefV1[];
}

const OWNED_ACTIVATIONS = new WeakMap<PendingLifecycleLaunch, string>();
const EXECUTOR_SETTLEMENTS = new WeakSet<PendingLifecycleLaunch>();

/** The foreground executor settles the durable row after result validation and local disposal. */
export function claimExecutorSettlement(pending: PendingLifecycleLaunch): void {
	if (EXECUTOR_SETTLEMENTS.has(pending)) throw new Error("launch_executor_already_owned: launch is already executing");
	EXECUTOR_SETTLEMENTS.add(pending);
}

export function releaseExecutorSettlement(pending: PendingLifecycleLaunch): void {
	EXECUTOR_SETTLEMENTS.delete(pending);
}

export function hasExecutorSettlement(pending: PendingLifecycleLaunch): boolean {
	return EXECUTOR_SETTLEMENTS.has(pending);
}

export type LifecycleLaunchResult =
	| { readonly ok: true; readonly pending: PendingLifecycleLaunch }
	| { readonly ok: false; readonly code: string; readonly diagnostics: readonly LaunchContractDiagnostic[] };

export function launchFailure(code: string, message: string): Extract<LifecycleLaunchResult, { ok: false }> {
	return { ok: false, code, diagnostics: [{ code, message }] };
}

/** Admission records authority only. No session, output, worktree or scheduler job is allocated here. */
export async function prepareLifecycleLaunch(
	store: LifecycleStore,
	request: {
		readonly compileInput: LaunchCompileInput;
		readonly owner: LifecycleExecutionContext | RootExecutionContext;
		readonly idempotencyKey: string;
		readonly reservation: ReservationVector;
		readonly actualRuntimeGuarantees: RuntimeGuaranteesV1;
		readonly guaranteeEvidenceRefs: readonly ArtifactRefV1[];
	},
	signal?: AbortSignal,
): Promise<LifecycleLaunchResult> {
	if (signal?.aborted) return launchFailure("launch_aborted", "Launch aborted before admission.");
	const registration = getLifecycleRegistration(request.owner);
	if (!registration) return launchFailure("missing_lifecycle_binding", "Issuer is not registered with the host.");
	if (!request.idempotencyKey.trim()) return launchFailure("missing_admission_identity", "Admission key is required.");
	// There is no confined backend in the current in-process executor. Never downgrade that request.
	if (request.compileInput.policy.isolationLevel === "confined") {
		return launchFailure("required_isolation_unavailable", "The in-process executor does not provide confinement.");
	}
	const compiled = compileLaunchContract(request.compileInput);
	if (!compiled.ok) {
		return { ok: false, code: compiled.diagnostics[0]?.code ?? "compile_failed", diagnostics: compiled.diagnostics };
	}
	if (signal?.aborted) return launchFailure("launch_aborted", "Launch aborted before admission.");
	const guard: LaunchMutationGuard = {
		actor: request.owner,
		expectedPolicyEpoch: registration.policyEpoch,
		idempotencyKey: request.idempotencyKey,
	};
	const admitted = await store.admitLaunchAuthority({
		guard,
		compiled: compiled.compiled,
		reservation: request.reservation,
		lifecycle: null,
		restoresBindingId: null,
	});
	if (!admitted.ok) return admitted;
	const pending: PendingLifecycleLaunch = Object.freeze({
		store,
		guard,
		launch: admitted.launch,
		actualRuntimeGuarantees: request.actualRuntimeGuarantees,
		guaranteeEvidenceRefs: request.guaranteeEvidenceRefs,
	});
	if (signal?.aborted) {
		terminateLifecycleLaunch(pending, "failed", "Launch aborted after admission.");
		return launchFailure("launch_aborted", "Launch aborted after admission.");
	}
	return { ok: true, pending };
}

/** Bind only after the executor has a real session identity, before constructing executable tools. */
export async function activateLifecycleLaunch(
	pending: PendingLifecycleLaunch,
	sessionId: string,
	repoRoot: string,
	evalIdentity: { readonly child: string; readonly parent: string | undefined },
	evidenceDir: string,
): Promise<LifecycleExecutionContext> {
	try {
		if (!evalIdentity.child || evalIdentity.child === evalIdentity.parent) {
			terminateLifecycleLaunch(pending, "failed", "Child eval state does not have an owned session identity.");
			throw new Error("required_eval_ownership_unavailable: child eval state must have its own session identity");
		}
		const measured: RuntimeGuaranteesV1 = { ...pending.actualRuntimeGuarantees, evalState: "child-owned" };
		const canonical = canonicalJson({ sessionId, evalSessionId: evalIdentity.child, sharedWithParent: false });
		const digest = sha256Hex(canonical);
		const evidencePath = path.join(evidenceDir, `eval-ownership-${digest}.json`);
		await writeContentAddressedFile(evidencePath, canonical);
		const evidence: ArtifactRefV1 = {
			schemaVersion: 1,
			artifactId: `eval-ownership-${digest}`,
			uri: pathToFileURL(evidencePath).href,
			sha256: digest,
			bytes: Buffer.byteLength(canonical),
			mediaType: "application/json",
			provenanceId: "host-eval-session-allocation",
		};
		const activated = pending.store.activateLaunchBinding({
			guard: pending.guard,
			bindingId: pending.launch.binding.bindingId,
			expectedState: "authorized",
			sessionId,
			processRef: null,
			serviceBindings: [],
			actualRuntimeGuarantees: measured,
			guaranteeEvidenceRefs: [...pending.guaranteeEvidenceRefs, evidence],
		});
		if (!activated.ok) {
			terminateLifecycleLaunch(pending, "failed", `Activation refused: ${activated.code}`);
			throw new Error(`${activated.code}: ${activated.diagnostics.map(item => item.message).join("; ")}`);
		}
		OWNED_ACTIVATIONS.set(pending, sessionId);
		const context = resolvePersistedLifecycleContext({
			binding: activated.launch.binding,
			contract: activated.launch.compiled,
			repoRoot,
		});
		registerLiveBindingValidator(context, bindingId => {
			const binding = pending.store.getLaunchBinding(bindingId);
			return { state: binding.state, policyEpoch: binding.policyEpoch };
		});
		registerLifecycleDispatchLimits(context, {
			maxHandoffBytes: activated.launch.compiled.policy.limits.maxHandoffBytes,
			maxOutputBytes: activated.launch.compiled.authority.result.maxOutputBytes,
		});
		return context;
	} catch (error) {
		terminateLifecycleLaunch(pending, "failed", "Child activation failed.");
		throw error;
	}
}

export function terminateLifecycleLaunch(
	pending: PendingLifecycleLaunch,
	targetState: "failed" | "revoked",
	reason: string,
): void {
	const binding = pending.store.getLaunchBinding(pending.launch.binding.bindingId);
	if (binding.state === "failed" || binding.state === "revoked") return;
	if (binding.state !== "authorized" && binding.sessionId !== OWNED_ACTIVATIONS.get(pending)) {
		throw new Error("foreign_lifecycle_session: refusing to terminalize another session's binding");
	}
	const result = pending.store.terminateLaunchBinding({
		guard: pending.guard,
		bindingId: pending.launch.binding.bindingId,
		targetState,
		reason,
	});
	if (!result.ok) throw new Error(`${result.code}: launch terminalization refused`);
}
