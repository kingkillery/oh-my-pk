/**
 * Verification Receipts and Completion Decisions (A11) — frozen W1 contract surface.
 *
 * Acceptance derives from current snapshot receipts and unresolved
 * obligations — never from tool names or narrative acknowledgement.
 * Any open mandatory obligation, partial/conflicted/rejected required
 * publication, stale/failed/unverified mandatory receipt, scope violation
 * or unresolved dependency prevents completed. Explicit waivers are listed,
 * never forged into passing evidence.
 */

import { isHex64, isNonEmptyString, isSafeNonNegativeInt } from "../task/launch-contract";

export type VerificationOutcome = "passed" | "failed" | "unverified";
export type PublicationState = "not-requested" | "pending" | "integrated" | "conflicted" | "rejected" | "partial";
export type LifecycleExecutionOutcome = "completed" | "blocked" | "failed" | "cancelled" | "needs-replan" | null;

export interface VerificationReceiptV1 {
	readonly schemaVersion: 1;
	readonly receiptId: string;
	readonly runId: string;
	readonly nodeId: string;
	readonly attemptId: string;
	readonly contractVersion: number;
	readonly contractHash: string;
	readonly candidateHash: string;
	readonly environmentHash: string;
	readonly lockfileHash: string;
	readonly verifierId: string;
	readonly verifierVersion: string;
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly nonSecretEnvHash: string;
	readonly startedAt: number;
	readonly finishedAt: number;
	readonly exitCode: number;
	readonly outcome: VerificationOutcome;
	readonly criterionIds: readonly string[];
	readonly artifactIds: readonly string[];
}

export interface DependencyTerminalState {
	readonly prerequisiteId: string;
	readonly outcome: "completed" | "blocked" | "failed" | "cancelled" | "needs-replan" | null;
}

export interface LifecycleCompletionSnapshot {
	readonly runId: string;
	readonly nodeId: string;
	readonly attemptId: string;
	readonly contractHash: string;
	readonly environmentHash: string;
	readonly candidateHash: string;
	readonly mandatoryCriterionIds: readonly string[];
	readonly receipts: readonly VerificationReceiptV1[];
	readonly openObligationIds: readonly string[];
	readonly waivedObligationIds: readonly string[];
	readonly publicationState: PublicationState;
	readonly publicationRequired: boolean;
	readonly scopeReceiptId: string | null;
	readonly dependencyTerminalStates: readonly DependencyTerminalState[];
	readonly executionOutcome: LifecycleExecutionOutcome;
}

export interface LifecycleCompletionDecision {
	readonly outcome: "completed" | "partial" | "blocked" | "failed" | "cancelled";
	readonly satisfiedCriterionIds: readonly string[];
	readonly unmetCriterionIds: readonly string[];
	readonly obligationIds: readonly string[];
	readonly receiptIds: readonly string[];
}

function receiptCovers(
	receipt: VerificationReceiptV1,
	snapshot: LifecycleCompletionSnapshot,
	criterionId: string,
): boolean {
	return (
		receipt.outcome === "passed" &&
		receipt.exitCode === 0 &&
		receipt.criterionIds.includes(criterionId) &&
		receipt.candidateHash === snapshot.candidateHash &&
		receipt.contractHash === snapshot.contractHash &&
		receipt.environmentHash === snapshot.environmentHash &&
		receipt.runId === snapshot.runId
	);
}

/**
 * Pure lifecycle completion evaluator (A11).
 */
export function evaluateLifecycleCompletion(snapshot: LifecycleCompletionSnapshot): LifecycleCompletionDecision {
	const allObligations = [...snapshot.openObligationIds, ...snapshot.waivedObligationIds];
	const allReceiptIds = snapshot.receipts.map(r => r.receiptId);

	if (snapshot.executionOutcome === "cancelled") {
		return {
			outcome: "cancelled",
			satisfiedCriterionIds: [],
			unmetCriterionIds: [...snapshot.mandatoryCriterionIds],
			obligationIds: allObligations,
			receiptIds: allReceiptIds,
		};
	}
	if (snapshot.executionOutcome === "failed") {
		return {
			outcome: "failed",
			satisfiedCriterionIds: [],
			unmetCriterionIds: [...snapshot.mandatoryCriterionIds],
			obligationIds: allObligations,
			receiptIds: allReceiptIds,
		};
	}

	const satisfied: string[] = [];
	const unmet: string[] = [];
	for (const criterionId of snapshot.mandatoryCriterionIds) {
		const covering = snapshot.receipts.some(r => receiptCovers(r, snapshot, criterionId));
		if (covering) satisfied.push(criterionId);
		else unmet.push(criterionId);
	}

	// Unresolved dependencies prevent completion
	const hasUnresolvedDependency = snapshot.dependencyTerminalStates.some(dep => dep.outcome !== "completed");

	// Scope verification required for completion
	const scopeViolated = snapshot.scopeReceiptId === null;

	if (snapshot.openObligationIds.length > 0 || unmet.length > 0 || hasUnresolvedDependency || scopeViolated) {
		return {
			outcome: "blocked",
			satisfiedCriterionIds: satisfied,
			unmetCriterionIds: unmet,
			obligationIds: allObligations,
			receiptIds: allReceiptIds,
		};
	}

	// Publication required checks:
	// If publication is required and not integrated, block or partial.
	if (snapshot.publicationRequired) {
		if (
			snapshot.publicationState === "partial" ||
			snapshot.publicationState === "conflicted" ||
			snapshot.publicationState === "rejected"
		) {
			return {
				outcome: "blocked",
				satisfiedCriterionIds: satisfied,
				unmetCriterionIds: unmet,
				obligationIds: [...snapshot.waivedObligationIds],
				receiptIds: allReceiptIds,
			};
		}
		if (snapshot.publicationState === "not-requested" || snapshot.publicationState === "pending") {
			return {
				outcome: "partial",
				satisfiedCriterionIds: satisfied,
				unmetCriterionIds: unmet,
				obligationIds: [...snapshot.waivedObligationIds],
				receiptIds: allReceiptIds,
			};
		}
	} else if (
		snapshot.publicationState === "partial" ||
		snapshot.publicationState === "conflicted" ||
		snapshot.publicationState === "rejected"
	) {
		return {
			outcome: "blocked",
			satisfiedCriterionIds: satisfied,
			unmetCriterionIds: unmet,
			obligationIds: [...snapshot.waivedObligationIds],
			receiptIds: allReceiptIds,
		};
	}

	if (
		snapshot.publicationState === "pending" ||
		snapshot.executionOutcome === "blocked" ||
		snapshot.executionOutcome === "needs-replan"
	) {
		return {
			outcome: "partial",
			satisfiedCriterionIds: satisfied,
			unmetCriterionIds: unmet,
			obligationIds: [...snapshot.waivedObligationIds],
			receiptIds: allReceiptIds,
		};
	}

	return {
		outcome: "completed",
		satisfiedCriterionIds: satisfied,
		unmetCriterionIds: unmet,
		obligationIds: [...snapshot.waivedObligationIds],
		receiptIds: allReceiptIds,
	};
}

const VERIFICATION_RECEIPT_KEYS = [
	"schemaVersion",
	"receiptId",
	"runId",
	"nodeId",
	"attemptId",
	"contractVersion",
	"contractHash",
	"candidateHash",
	"environmentHash",
	"lockfileHash",
	"verifierId",
	"verifierVersion",
	"argv",
	"cwd",
	"nonSecretEnvHash",
	"startedAt",
	"finishedAt",
	"exitCode",
	"outcome",
	"criterionIds",
	"artifactIds",
] as const;

function frozenStringArray(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value)) throw new Error(`Invalid VerificationReceiptV1: ${field} must be an array`);
	return Object.freeze(
		value.map((entry, index) => {
			if (!isNonEmptyString(entry)) {
				throw new Error(`Invalid VerificationReceiptV1: ${field}[${index}] must be a non-empty string`);
			}
			return entry;
		}),
	);
}

/**
 * Strict parser: a receipt is runtime-stamped evidence, so a malformed or
 * partially populated record must reject rather than coerce. `Number(undefined)`
 * yielding NaN, or a missing timestamp becoming 0, would turn an unverifiable
 * record into one that looks like a real observation.
 */
export function parseVerificationReceiptV1(value: unknown): VerificationReceiptV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid VerificationReceiptV1: expected object");
	}
	const r = value as Record<string, unknown>;
	for (const key of Object.keys(r)) {
		if (!VERIFICATION_RECEIPT_KEYS.includes(key as (typeof VERIFICATION_RECEIPT_KEYS)[number])) {
			throw new Error(`Invalid VerificationReceiptV1: unknown field '${key}'`);
		}
	}
	if (r.schemaVersion !== 1) throw new Error("Invalid VerificationReceiptV1: schemaVersion must be 1");
	for (const field of ["receiptId", "runId", "nodeId", "attemptId", "verifierId", "verifierVersion", "cwd"] as const) {
		if (!isNonEmptyString(r[field]))
			throw new Error(`Invalid VerificationReceiptV1: ${field} must be non-empty string`);
	}
	for (const hashField of [
		"contractHash",
		"candidateHash",
		"environmentHash",
		"lockfileHash",
		"nonSecretEnvHash",
	] as const) {
		if (!isHex64(r[hashField])) throw new Error(`Invalid VerificationReceiptV1: ${hashField} must be 64-hex SHA-256`);
	}
	for (const countField of ["contractVersion", "startedAt", "finishedAt"] as const) {
		if (!isSafeNonNegativeInt(r[countField])) {
			throw new Error(`Invalid VerificationReceiptV1: ${countField} must be a safe non-negative integer`);
		}
	}
	if (typeof r.exitCode !== "number" || !Number.isSafeInteger(r.exitCode)) {
		throw new Error("Invalid VerificationReceiptV1: exitCode must be a safe integer");
	}
	if ((r.finishedAt as number) < (r.startedAt as number)) {
		throw new Error("Invalid VerificationReceiptV1: finishedAt must not precede startedAt");
	}
	if (!["passed", "failed", "unverified"].includes(r.outcome as string)) {
		throw new Error(`Invalid VerificationReceiptV1: unknown outcome '${String(r.outcome)}'`);
	}
	return Object.freeze({
		schemaVersion: 1 as const,
		receiptId: r.receiptId as string,
		runId: r.runId as string,
		nodeId: r.nodeId as string,
		attemptId: r.attemptId as string,
		contractVersion: r.contractVersion as number,
		contractHash: r.contractHash as string,
		candidateHash: r.candidateHash as string,
		environmentHash: r.environmentHash as string,
		lockfileHash: r.lockfileHash as string,
		verifierId: r.verifierId as string,
		verifierVersion: r.verifierVersion as string,
		argv: frozenStringArray(r.argv, "argv"),
		cwd: r.cwd as string,
		nonSecretEnvHash: r.nonSecretEnvHash as string,
		startedAt: r.startedAt as number,
		finishedAt: r.finishedAt as number,
		exitCode: r.exitCode,
		outcome: r.outcome as VerificationOutcome,
		criterionIds: frozenStringArray(r.criterionIds, "criterionIds"),
		artifactIds: frozenStringArray(r.artifactIds, "artifactIds"),
	});
}
