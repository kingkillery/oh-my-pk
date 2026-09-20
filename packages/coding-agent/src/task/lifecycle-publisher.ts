import type { ArtifactRefV1, MutationContractV1, SnapshotRefV1 } from "./launch-contract";
import { isNonEmptyString, isPlainObject, parseSnapshotRefV1 } from "./launch-contract";

export interface PublicationInput {
	readonly runId: string;
	readonly attemptId: string;
	readonly manifest: ArtifactRefV1;
	readonly expectedCandidate: SnapshotRefV1;
	readonly target: "run-candidate" | "user-workspace";
	readonly mutation: MutationContractV1;
	readonly approvalRef: string | null;
	readonly idempotencyKey: string;
	readonly signal?: AbortSignal;
}

export interface PublicationReceipt {
	readonly schemaVersion: 1;
	readonly publicationId: string;
	readonly state: "integrated" | "pending" | "conflicted" | "rejected" | "partial";
	readonly candidate: SnapshotRefV1 | null;
	readonly mutatedRepositories: readonly string[];
	readonly changesApplied: boolean;
	readonly recoveryRefs: readonly string[];
	readonly obligationIds: readonly string[];
}

const PUBLICATION_RECEIPT_STATES: readonly PublicationReceipt["state"][] = [
	"integrated",
	"pending",
	"conflicted",
	"rejected",
	"partial",
];

const PUBLICATION_RECEIPT_KEYS = [
	"schemaVersion",
	"publicationId",
	"state",
	"candidate",
	"mutatedRepositories",
	"changesApplied",
	"recoveryRefs",
	"obligationIds",
] as const;

function parseStringArray(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value)) throw new Error(`invalid_PublicationReceipt: ${field} must be an array`);
	return Object.freeze(
		value.map((entry, index) => {
			if (!isNonEmptyString(entry)) {
				throw new Error(`invalid_PublicationReceipt: ${field}[${index}] must be a non-empty string`);
			}
			return entry;
		}),
	);
}

/**
 * Strict round-trip parser for persisted publication receipts.
 *
 * `changesApplied` means the entire authorized user-target change landed, so it
 * must never be inferred from a missing field: absence rejects rather than
 * defaulting to `false` and silently reporting a clean partial publication.
 */
export function parsePublicationReceipt(value: unknown): PublicationReceipt {
	if (!isPlainObject(value)) throw new Error("invalid_PublicationReceipt: expected object");
	for (const key of Object.keys(value)) {
		if (!PUBLICATION_RECEIPT_KEYS.includes(key as (typeof PUBLICATION_RECEIPT_KEYS)[number])) {
			throw new Error(`unknown_field: PublicationReceipt.${key}`);
		}
	}
	if (value.schemaVersion !== 1) throw new Error("invalid_PublicationReceipt: schemaVersion must be 1");
	if (!isNonEmptyString(value.publicationId)) {
		throw new Error("invalid_PublicationReceipt: publicationId must be a non-empty string");
	}
	const state = value.state;
	if (typeof state !== "string" || !PUBLICATION_RECEIPT_STATES.includes(state as PublicationReceipt["state"])) {
		throw new Error(`invalid_PublicationReceipt: state must be one of ${PUBLICATION_RECEIPT_STATES.join("|")}`);
	}
	if (value.candidate === undefined) {
		throw new Error("invalid_PublicationReceipt: candidate must be present or null");
	}
	if (typeof value.changesApplied !== "boolean") {
		throw new Error("invalid_PublicationReceipt: changesApplied must be a boolean");
	}
	return Object.freeze({
		schemaVersion: 1 as const,
		publicationId: value.publicationId,
		state: state as PublicationReceipt["state"],
		candidate: value.candidate === null ? null : parseSnapshotRefV1(value.candidate, "PublicationReceipt.candidate"),
		mutatedRepositories: parseStringArray(value.mutatedRepositories, "mutatedRepositories"),
		changesApplied: value.changesApplied,
		recoveryRefs: parseStringArray(value.recoveryRefs, "recoveryRefs"),
		obligationIds: parseStringArray(value.obligationIds, "obligationIds"),
	});
}

export interface PublicationStageEffects {
	readonly applyToTarget: (manifest: ArtifactRefV1) => Promise<{ applied: string[]; failed: string[] }>;
}

function receipt(
	input: PublicationInput,
	state: PublicationReceipt["state"],
	extra: Partial<PublicationReceipt> = {},
): PublicationReceipt {
	return {
		schemaVersion: 1,
		publicationId: `pub-${input.attemptId}-${input.idempotencyKey}`,
		state,
		candidate: state === "rejected" ? null : input.expectedCandidate,
		mutatedRepositories: [],
		changesApplied: false,
		recoveryRefs: [],
		obligationIds: [],
		...extra,
	};
}

/**
 * Fenced run-owned publication (A10).
 * Hierarchical adapters return retained candidates with changesApplied:false
 * until this publisher confirms user-target mutation. apply=false still
 * allows internal run-candidate assembly but forbids user workspace mutation.
 * allowCommit/allowPush/allowMerge default false unless an explicit user
 * contract grants them. Never overwrites a changed target: conflicts leave
 * both sides retained and block acceptance.
 */
export async function publishLifecycleCandidate(input: PublicationInput): Promise<PublicationReceipt> {
	if (!input.mutation.apply) {
		return receipt(input, "pending", {
			candidate: input.expectedCandidate,
			changesApplied: false,
		});
	}
	if (input.target === "user-workspace") {
		if (!input.approvalRef) {
			return receipt(input, "rejected", {
				recoveryRefs: [input.manifest.uri],
				obligationIds: [`approval-missing:${input.attemptId}`],
			});
		}
		if (input.mutation.approvalRef !== input.approvalRef) {
			return receipt(input, "rejected", {
				recoveryRefs: [input.manifest.uri],
				obligationIds: [`approval-changed:${input.attemptId}`],
			});
		}
	}
	if (input.signal?.aborted) {
		return receipt(input, "pending", { recoveryRefs: [input.manifest.uri] });
	}
	return receipt(input, "integrated", {
		mutatedRepositories: [input.target === "run-candidate" ? "run-root" : "user-workspace"],
		changesApplied: input.target === "user-workspace",
	});
}

export async function publishWithEffects(
	input: PublicationInput,
	effects: PublicationStageEffects,
): Promise<PublicationReceipt> {
	const gate = await publishLifecycleCandidate({ ...input, signal: input.signal });
	if (gate.state !== "integrated" || !input.mutation.apply) return gate;
	const outcome = await effects.applyToTarget(input.manifest);
	if (outcome.failed.length > 0 && outcome.applied.length > 0) {
		return {
			...gate,
			state: "partial",
			mutatedRepositories: outcome.applied,
			changesApplied: false,
			recoveryRefs: [input.manifest.uri, ...outcome.failed.map(repo => `recovery://${repo}`)],
			obligationIds: [`publication-partial:${input.attemptId}`],
		};
	}
	if (outcome.failed.length > 0) {
		return {
			...gate,
			state: "conflicted",
			mutatedRepositories: [],
			changesApplied: false,
			recoveryRefs: [input.manifest.uri],
			obligationIds: [`publication-conflict:${input.attemptId}`],
		};
	}
	return { ...gate, mutatedRepositories: outcome.applied };
}
