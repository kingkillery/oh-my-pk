/**
 * Launch-authority mutation and read types (§14.5) shared by the lifecycle
 * authority store, launch admission and the context record loader.
 */

import type { LifecycleExecutionContext, RootExecutionContext } from "../orchestration/lifecycle-authority";
import type {
	ArtifactRefV1,
	CompiledLaunchContract,
	DisclosureDomain,
	DisclosureKind,
	LaunchBinding,
	LaunchContract,
	LaunchContractDiagnostic,
	ResourceOperation,
	ResourceSelectorV1,
	RuntimeGuaranteesV1,
} from "../task/launch-contract";

/**
 * Authenticates a mutation.
 *
 * `expectedPolicyEpoch` refers to the binding named by the operation. The
 * issuer's own currentness is checked separately through actor registration,
 * so a stale issuer cannot ride in on a fresh recipient epoch.
 */
export interface LaunchMutationGuard {
	/**
	 * Either a bound child context or the host's root issuer: the store
	 * authenticates both lineages, so the type admits both rather than
	 * forcing root callers to cast away their brand.
	 */
	readonly actor: LifecycleExecutionContext | RootExecutionContext;
	readonly expectedPolicyEpoch: number;
	readonly idempotencyKey: string;
}

export interface GrantIssueRequest {
	readonly idempotencyKey: string;
	/** Authenticated issuer identity, supplied by the runtime preflight. */
	readonly issuerPrincipalId: string;
	readonly recipientPrincipalId: string;
	readonly recipientBindingId: string;
	readonly resource: ResourceSelectorV1;
	readonly operations: readonly ResourceOperation[];
	readonly delegableOperations: readonly ResourceOperation[];
	readonly recipientConstraints: readonly string[];
	/** Each derivation decrements every source bound; zero forbids onward issuance. */
	readonly remainingDelegationDepth: number;
	readonly domains: readonly DisclosureDomain[];
	readonly sourceGrantIds: readonly string[];
	readonly contractRevision: number;
	readonly attemptId: string;
	readonly expiresAt: number | null;
	readonly purpose: string;
}

/** Grant handle. Serialization alone is inert; use requires host registration. */
export interface RuntimeGrantRef {
	readonly grantId: string;
	readonly recordDigest: string;
}

/** Shared failure shape for every authority operation. */
export interface LaunchAuthorityFailure {
	readonly ok: false;
	readonly code: string;
	readonly diagnostics: readonly LaunchContractDiagnostic[];
}

export type GrantIssueResult = { readonly ok: true; readonly grant: RuntimeGrantRef } | LaunchAuthorityFailure;

/** Typed acknowledgement for authority mutations that do not return a record. */
export type LaunchMutationResult = { readonly ok: true } | LaunchAuthorityFailure;

export interface ContextDeliveryRequest {
	readonly deliveryId: string;
	readonly channelId: string;
	readonly recipientBindingId: string;
	readonly expectedPolicyEpoch: number;
	readonly attemptId: string;
	readonly contractRevision: number;
	readonly contextGeneration: number;
	readonly grantRefs: readonly { readonly grantId: string; readonly recordDigest: string }[];
	readonly payloadRef: ArtifactRefV1;
	readonly resourceRefs: readonly ResourceSelectorV1[];
	readonly domains: readonly DisclosureDomain[];
	readonly kind: DisclosureKind;
}

/**
 * One admitted disclosure. Admission is the commit point: an atomic
 * insertion into the recipient's durable context inbox plus channel-budget
 * consumption.
 */
export interface DeliveryRecordV1 {
	readonly schemaVersion: 1;
	readonly deliveryId: string;
	readonly channelId: string;
	readonly senderPrincipalId: string;
	readonly recipientPrincipalId: string;
	readonly recipientBindingId: string;
	readonly attemptId: string;
	readonly contractRevision: number;
	readonly policyEpoch: number;
	readonly contextGeneration: number;
	readonly payloadRef: ArtifactRefV1;
	readonly resourceRefs: readonly ResourceSelectorV1[];
	readonly domains: readonly DisclosureDomain[];
	readonly kind: DisclosureKind;
	readonly bytes: number;
	readonly requestDigest: string;
}

export type ContextDeliveryResult =
	| { readonly ok: true; readonly delivery: DeliveryRecordV1; readonly replayed: boolean }
	| LaunchAuthorityFailure;

/**
 * Authority-only admission: the contract plus an `authorized` binding. There
 * is no scheduler job behind it, so the binding row is the execution record.
 */
export interface LaunchAuthorityAdmissionInput {
	readonly guard: LaunchMutationGuard;
	readonly compiled: CompiledLaunchContract;
	readonly restoresBindingId: string | null;
}

export type LaunchAuthorityAdmissionResult =
	| { readonly ok: true; readonly launch: LaunchContract; readonly replayed: boolean }
	| LaunchAuthorityFailure;

/**
 * authorized to bound stores probe results; bound to active revalidates
 * identity, epoch and evidence before the child becomes externally visible.
 */
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
