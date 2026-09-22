import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { OperationalStore } from "../operational/store";
import * as git from "../utils/git";
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
	/**
	 * Durable single owner for the fenced publication protocol (§7.2).
	 * Required: publication state must live in the store, never in callbacks.
	 */
	readonly store: OperationalStore;
	/** Controller identity that holds the fenced publication lease. */
	readonly publisherOwner: string;
	/** Per-repo effect targets (root and nested) with persisted patch artifacts. */
	readonly repositories: readonly PublicationRepositoryTarget[];
}

export interface PublicationRepositoryTarget {
	readonly targetId: string;
	readonly repoRoot: string;
	/** URI (file:// or plain path) of the persisted patch artifact for this repo. */
	readonly patchUri: string;
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
	if (!Array.isArray(value)) {
		throw new Error(`${field} must be an array`);
	}
	return Object.freeze(
		value.map((item, index) => {
			if (typeof item !== "string" || item.length === 0) {
				throw new Error(`${field}[${index}] must be a non-empty string`);
			}
			return item;
		}),
	);
}

/**
 * Strict round-trip parser for persisted publication receipts.
 * Unknown keys, wrong versions, or malformed fields are hard failures.
 */
export function parsePublicationReceipt(value: unknown): PublicationReceipt {
	if (!isPlainObject(value)) {
		throw new Error("publication receipt must be a plain object");
	}
	const keys = Object.keys(value);
	for (const key of keys) {
		if (!(PUBLICATION_RECEIPT_KEYS as readonly string[]).includes(key)) {
			throw new Error(`unknown_field: publication receipt.${key}`);
		}
	}
	if (value.schemaVersion !== 1) throw new Error("publication receipt schemaVersion must be 1");
	if (!isNonEmptyString(value.publicationId)) {
		throw new Error("publication receipt publicationId must be a non-empty string");
	}
	if (
		typeof value.state !== "string" ||
		!PUBLICATION_RECEIPT_STATES.includes(value.state as PublicationReceipt["state"])
	) {
		throw new Error(`invalid publication receipt state: ${String(value.state)}`);
	}
	const candidate =
		value.candidate === null ? null : parseSnapshotRefV1(value.candidate, "publication receipt candidate");
	return Object.freeze({
		schemaVersion: 1 as const,
		publicationId: value.publicationId,
		state: value.state as PublicationReceipt["state"],
		candidate,
		mutatedRepositories: parseStringArray(value.mutatedRepositories, "mutatedRepositories"),
		changesApplied: value.changesApplied === true,
		recoveryRefs: parseStringArray(value.recoveryRefs, "recoveryRefs"),
		obligationIds: parseStringArray(value.obligationIds, "obligationIds"),
	});
}

function receipt(
	input: PublicationInput,
	publicationId: string,
	state: PublicationReceipt["state"],
	extra: Partial<PublicationReceipt> = {},
): PublicationReceipt {
	return Object.freeze({
		schemaVersion: 1 as const,
		publicationId,
		state,
		candidate: state === "rejected" ? null : input.expectedCandidate,
		mutatedRepositories: [],
		changesApplied: false,
		recoveryRefs: [],
		obligationIds: [],
		...extra,
	});
}

async function readPatchText(patchUri: string): Promise<string> {
	const resolved = patchUri.startsWith("file://") ? fileURLToPath(patchUri) : patchUri;
	return fs.readFile(resolved, "utf8");
}

interface RepoBeforeImage {
	readonly targetId: string;
	readonly repoRoot: string;
	readonly patchUri: string;
	readonly patchSha256: string;
	readonly headCommit: string | null;
	readonly beforeTree: string | null;
	/** Digest of tracked diff/index/status; distinguishes a dirty worktree from its Git index tree. */
	readonly worktreeHash: string;
	/** Publication never mutates an already-dirty target. */
	readonly clean: boolean;
}

type JournalStage = "prepared" | "applied" | "verified";

interface JournalEntry {
	readonly stage: JournalStage;
	readonly data: Record<string, unknown>;
}

function parseJournalEntries(entries: readonly unknown[]): readonly JournalEntry[] {
	const parsed: JournalEntry[] = [];
	for (const entry of entries) {
		if (!isPlainObject(entry) || !isPlainObject(entry.data)) continue;
		if (entry.stage !== "prepared" && entry.stage !== "applied" && entry.stage !== "verified") continue;
		parsed.push({ stage: entry.stage, data: entry.data });
	}
	return parsed;
}

function latestStage(entries: readonly JournalEntry[], stage: JournalStage): JournalEntry | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index]?.stage === stage) return entries[index] ?? null;
	}
	return null;
}

async function readRepoImage(
	repoRoot: string,
	signal?: AbortSignal,
): Promise<Pick<RepoBeforeImage, "headCommit" | "beforeTree" | "worktreeHash" | "clean">> {
	try {
		const [headCommit, beforeTree, unstaged, staged, status] = await Promise.all([
			git.head.sha(repoRoot, signal).catch(() => null),
			git.writeTree(repoRoot, { signal }).catch(() => null),
			git.diff(repoRoot, { binary: true, signal }).catch(() => "<unreadable>"),
			git.diff(repoRoot, { binary: true, cached: true, signal }).catch(() => "<unreadable>"),
			git.status(repoRoot, { porcelainV1: true, untrackedFiles: "all", signal }).catch(() => "<unreadable>"),
		]);
		// ponytail: untracked entries don't block publication — nested repo
		// targets live untracked by design; worktreeHash still pins them.
		const clean =
			status.trim().length === 0 ||
			status
				.trim()
				.split("\n")
				.every(line => line.startsWith("?? "));
		return {
			headCommit,
			beforeTree,
			worktreeHash: createHash("sha256")
				.update(`${beforeTree ?? "<none>"}\u0000${unstaged}\u0000${staged}\u0000${status}`, "utf8")
				.digest("hex"),
			clean,
		};
	} catch {
		return { headCommit: null, beforeTree: null, worktreeHash: "<unreadable>", clean: false };
	}
}

async function hasExactBeforeImage(
	repo: PublicationRepositoryTarget,
	image: RepoBeforeImage,
	signal?: AbortSignal,
): Promise<boolean> {
	const live = await readRepoImage(repo.repoRoot, signal);
	return (
		live.clean &&
		live.headCommit === image.headCommit &&
		live.beforeTree === image.beforeTree &&
		live.worktreeHash === image.worktreeHash
	);
}

function preparedImages(entries: readonly JournalEntry[]): readonly RepoBeforeImage[] | null {
	const prepared = latestStage(entries, "prepared");
	if (!prepared || !Array.isArray(prepared.data.repositories)) return null;
	const images: RepoBeforeImage[] = [];
	for (const candidate of prepared.data.repositories) {
		if (!isPlainObject(candidate)) return null;
		if (
			!isNonEmptyString(candidate.targetId) ||
			!isNonEmptyString(candidate.patchUri) ||
			!isNonEmptyString(candidate.patchSha256) ||
			!isNonEmptyString(candidate.worktreeHash) ||
			candidate.clean !== true ||
			(candidate.headCommit !== null && !isNonEmptyString(candidate.headCommit)) ||
			(candidate.beforeTree !== null && !isNonEmptyString(candidate.beforeTree))
		) {
			return null;
		}
		images.push({
			targetId: candidate.targetId,
			repoRoot: "",
			patchUri: candidate.patchUri,
			patchSha256: candidate.patchSha256,
			headCommit: candidate.headCommit,
			beforeTree: candidate.beforeTree,
			worktreeHash: candidate.worktreeHash,
			clean: candidate.clean,
		});
	}
	return images;
}

function targetKey(input: PublicationInput): string {
	if (input.target === "run-candidate") return `run-candidate:${input.runId}`;
	return input.repositories[0]?.targetId ?? "user-workspace";
}

/**
 * Fenced run-owned publication (A10, §7.2–7.3).
 *
 * The durable store owns all publication state: a controller-fenced claim,
 * lease rechecks immediately before every effect, a prepared/applied/verified
 * stage journal with per-repo before/after snapshots, and an idempotent
 * finalization. Real Git application happens against the recorded
 * per-repository patch artifacts; an `integrated` receipt is only ever
 * issued after every patch applied and the resulting state was observed.
 * `apply=false` allows internal candidate assembly only. Commit/push/merge
 * rights stay independent of patch application.
 */
export async function publishLifecycleCandidate(input: PublicationInput): Promise<PublicationReceipt> {
	// Step 1: controller-fenced, idempotent durable claim.
	const claim = input.store.claimPublication({
		attemptId: input.attemptId,
		targetKind: input.target,
		targetId: targetKey(input),
		manifestHash: input.manifest.sha256,
		expectedSnapshotHash: input.expectedCandidate.manifestHash,
		publisherOwner: input.publisherOwner,
		mutationPolicy: input.mutation,
	});
	if (!claim.ok) {
		// Never steal an integrating lock: report pending with retained recovery material.
		return receipt(input, `unclaimed-${input.idempotencyKey}`, "pending", {
			recoveryRefs: [input.manifest.uri],
		});
	}
	const publicationId = claim.publicationId;

	function mutationPolicyKey(m: MutationContractV1): string {
		return JSON.stringify([m.schemaVersion, m.apply, m.allowCommit, m.allowPush, m.allowMerge, m.approvalRef]);
	}

	// Idempotent replay of an already-finalized publication.
	if (claim.replayed && claim.state !== "pending") {
		const persisted = input.store.getPublication(publicationId);
		const storedPolicy = persisted?.mutationPolicy;
		const policyMatches =
			storedPolicy !== null &&
			storedPolicy !== undefined &&
			mutationPolicyKey(storedPolicy) === mutationPolicyKey(input.mutation);
		if (!policyMatches) {
			// The exact candidate was already decided under a different
			// approved action: report the change, never reuse the old outcome.
			return receipt(input, publicationId, "rejected", {
				recoveryRefs: [input.manifest.uri],
				obligationIds: [`approval-changed:${input.attemptId}`],
			});
		}
		return receipt(input, publicationId, claim.state, {
			candidate: claim.state === "rejected" ? null : input.expectedCandidate,
			changesApplied: claim.state === "integrated" && input.target === "user-workspace",
			mutatedRepositories: claim.state === "integrated" || claim.state === "partial" ? [targetKey(input)] : [],
			recoveryRefs: claim.state === "conflicted" || claim.state === "partial" ? [input.manifest.uri] : [],
			obligationIds: claim.state === "partial" ? [`publication-partial:${input.attemptId}`] : [],
		});
	}

	const lease = {
		publicationId,
		publisherOwner: input.publisherOwner,
		expectedEpoch: claim.epoch,
	} as const;
	const journal = (stage: "prepared" | "applied" | "verified", stageData: Record<string, unknown>) =>
		input.store.journalPublicationStage({ ...lease, stage, stageData });

	// A reclaimed pending row proves a previous controller stopped mid-flight.
	// Reconcile only durable, observable states: exact-before resumes; a
	// verified exact-after finalizes idempotently; every missing/mixed/changed
	// image stays conflicted with recovery material. In particular, never
	// continue applying a nested patch after discovering a root that may have
	// been applied by a dead controller.
	const persisted = input.store.getPublication(publicationId);
	const priorStages = persisted ? parseJournalEntries(persisted.stageJournal) : [];
	const priorPrepared = latestStage(priorStages, "prepared");
	const candidateAssemblyOnly = priorPrepared?.data.mode === "candidate-assembly-only";
	if (priorStages.length > 0 && !candidateAssemblyOnly) {
		const priorImages = preparedImages(priorStages);
		const priorByTarget = new Map(priorImages?.map(image => [image.targetId, image]));
		const hasCompleteBeforeImages =
			priorImages !== null &&
			input.repositories.every(repo => priorByTarget.has(repo.targetId)) &&
			priorImages.length === input.repositories.length;
		const verified = latestStage(priorStages, "verified");
		if (verified && isPlainObject(verified.data.afterTrees) && hasCompleteBeforeImages) {
			const afterTrees = verified.data.afterTrees;
			let exactAfter = true;
			for (const repo of input.repositories) {
				const expectedTree = afterTrees[repo.targetId];
				if (
					!isNonEmptyString(expectedTree) ||
					(await readRepoImage(repo.repoRoot, input.signal)).worktreeHash !== expectedTree
				) {
					exactAfter = false;
					break;
				}
			}
			if (exactAfter) {
				const applied = latestStage(priorStages, "applied");
				const failed = applied && Array.isArray(applied.data.failed) ? applied.data.failed : [];
				const state = failed.length === 0 ? "integrated" : "partial";
				const resultingSnapshotHash = isNonEmptyString(verified.data.resultingSnapshotHash)
					? verified.data.resultingSnapshotHash
					: input.expectedCandidate.manifestHash;
				if (input.store.finalizePublication({ ...lease, state, resultingSnapshotHash })) {
					return receipt(input, publicationId, state, {
						mutatedRepositories: state === "integrated" ? input.repositories.map(repo => repo.targetId) : [],
						changesApplied: state === "integrated" && input.target === "user-workspace",
						recoveryRefs: state === "partial" ? [input.manifest.uri] : [],
						obligationIds: state === "partial" ? [`publication-partial:${input.attemptId}`] : [],
					});
				}
			}
		}
		if (hasCompleteBeforeImages) {
			const exactBefore = await Promise.all(
				input.repositories.map(repo => hasExactBeforeImage(repo, priorByTarget.get(repo.targetId)!, input.signal)),
			);
			if (exactBefore.every(Boolean)) {
				// Reclaimed before any observed effect: regular preparation below
				// rechecks and appends a fresh durable stage before applying.
			} else {
				input.store.finalizePublication({ ...lease, state: "conflicted" });
				return receipt(input, publicationId, "conflicted", {
					recoveryRefs: [input.manifest.uri, ...input.repositories.map(repo => `recovery://${repo.targetId}`)],
					obligationIds: [`publication-recovery-ambiguous:${input.attemptId}`],
				});
			}
		} else {
			input.store.finalizePublication({ ...lease, state: "conflicted" });
			return receipt(input, publicationId, "conflicted", {
				recoveryRefs: [input.manifest.uri],
				obligationIds: [`publication-recovery-ambiguous:${input.attemptId}`],
			});
		}
	}

	// Step 2: cancellation before any effect — retry requires renewed authorization.
	if (input.signal?.aborted) {
		return receipt(input, publicationId, "pending", { recoveryRefs: [input.manifest.uri] });
	}

	// Step 3: apply=false allows internal candidate assembly only.
	if (!input.mutation.apply) {
		journal("prepared", { mode: "candidate-assembly-only", manifestUri: input.manifest.uri });
		input.store.finalizePublication({ ...lease, state: "pending" });
		return receipt(input, publicationId, "pending", {
			candidate: input.expectedCandidate,
			changesApplied: false,
		});
	}

	// Step 4: user-workspace publication requires exact candidate approval.
	if (input.target === "user-workspace") {
		if (!input.approvalRef) {
			journal("prepared", { rejected: "approval-missing" });
			input.store.finalizePublication({ ...lease, state: "rejected" });
			return receipt(input, publicationId, "rejected", {
				recoveryRefs: [input.manifest.uri],
				obligationIds: [`approval-missing:${input.attemptId}`],
			});
		}
		if (input.mutation.approvalRef !== input.approvalRef) {
			journal("prepared", { rejected: "approval-changed" });
			input.store.finalizePublication({ ...lease, state: "rejected" });
			return receipt(input, publicationId, "rejected", {
				recoveryRefs: [input.manifest.uri],
				obligationIds: [`approval-changed:${input.attemptId}`],
			});
		}
	}

	// Step 5: nothing to integrate is never a global success.
	if (input.repositories.length === 0) {
		journal("prepared", { rejected: "no-repositories" });
		input.store.finalizePublication({ ...lease, state: "rejected" });
		return receipt(input, publicationId, "rejected", {
			recoveryRefs: [input.manifest.uri],
			obligationIds: [`publication-empty:${input.attemptId}`],
		});
	}

	// Step 6: prepare — read the persisted patch artifacts and durably record
	// per-repo before snapshots and the approved action digest before effects.
	const beforeImages: RepoBeforeImage[] = [];
	const unappliable: string[] = [];
	for (const repo of input.repositories) {
		let patchText: string;
		try {
			patchText = await readPatchText(repo.patchUri);
		} catch {
			unappliable.push(repo.targetId);
			continue;
		}
		const image = await readRepoImage(repo.repoRoot, input.signal);
		if (!image.clean) {
			unappliable.push(repo.targetId);
			continue;
		}
		beforeImages.push({
			targetId: repo.targetId,
			repoRoot: repo.repoRoot,
			patchUri: repo.patchUri,
			patchSha256: createHash("sha256").update(patchText, "utf8").digest("hex"),
			...image,
		});
	}

	journal("prepared", {
		approvedActionDigest: input.manifest.sha256,
		approvalRef: input.approvalRef,
		repositories: beforeImages.map(b => ({
			targetId: b.targetId,
			patchUri: b.patchUri,
			patchSha256: b.patchSha256,
			headCommit: b.headCommit,
			beforeTree: b.beforeTree,
			worktreeHash: b.worktreeHash,
			clean: b.clean,
		})),
		unappliable,
	});

	if (unappliable.length > 0) {
		// Live before-images changed or patches are missing: both sides retained.
		input.store.finalizePublication({ ...lease, state: "conflicted" });
		return receipt(input, publicationId, "conflicted", {
			recoveryRefs: [input.manifest.uri, ...unappliable.map(id => `recovery://${id}`)],
			obligationIds: [`publication-conflict:${input.attemptId}`],
		});
	}

	const beforeByTarget = new Map(beforeImages.map(image => [image.targetId, image]));
	// Step 7: apply — recheck lease, cancellation and the live before-image
	// immediately before each effect (§7.2). A repo whose recorded image has
	// diverged fails at its own turn; earlier effects already stand, which is
	// exactly the partial outcome.
	const applied: string[] = [];
	const failed: string[] = [];
	for (const repo of input.repositories) {
		if (input.signal?.aborted) {
			failed.push(repo.targetId);
			continue;
		}
		if (!input.store.renewPublicationLease(lease)) {
			// Lost the fenced claim mid-flight: stop, retain everything.
			failed.push(repo.targetId);
			continue;
		}
		try {
			const beforeImage = beforeByTarget.get(repo.targetId);
			if (!beforeImage || !(await hasExactBeforeImage(repo, beforeImage, input.signal))) {
				// A human or another controller changed the target after our
				// prepared journal. Never rely on hunk applicability alone.
				failed.push(repo.targetId);
				continue;
			}
			const patchText = await readPatchText(repo.patchUri);
			if (!(await git.patch.canApplyText(repo.repoRoot, patchText))) {
				failed.push(repo.targetId);
				continue;
			}
			await git.patch.applyText(repo.repoRoot, patchText, { signal: input.signal });
			applied.push(repo.targetId);
		} catch {
			failed.push(repo.targetId);
		}
	}

	journal("applied", { applied, failed });

	if (applied.length === 0) {
		input.store.finalizePublication({ ...lease, state: "conflicted" });
		return receipt(input, publicationId, "conflicted", {
			recoveryRefs: [input.manifest.uri],
			obligationIds: [`publication-conflict:${input.attemptId}`],
		});
	}

	// Step 8: verify — observe the resulting state per repo after effects.
	const afterTrees: Record<string, string | null> = {};
	for (const repo of input.repositories) {
		if (!applied.includes(repo.targetId)) continue;
		const image = await readRepoImage(repo.repoRoot, input.signal);
		afterTrees[repo.targetId] = image.worktreeHash;
	}
	const resultingSnapshotHash = Object.values(afterTrees).find(Boolean) ?? input.expectedCandidate.manifestHash;
	journal("verified", { afterTrees, resultingSnapshotHash });

	if (failed.length > 0) {
		// Root success plus nested failure is partial, never global success.
		input.store.finalizePublication({
			...lease,
			state: "partial",
			resultingSnapshotHash,
		});
		return receipt(input, publicationId, "partial", {
			mutatedRepositories: [...applied],
			changesApplied: false,
			recoveryRefs: [input.manifest.uri, ...failed.map(repo => `recovery://${repo}`)],
			obligationIds: [`publication-partial:${input.attemptId}`],
		});
	}

	// Step 9: observed resulting state + durable finalization = integrated.
	const integrated = input.store.finalizePublication({
		...lease,
		state: "integrated",
		resultingSnapshotHash,
	});
	if (!integrated) {
		// Could not durably finalize: do not claim success.
		return receipt(input, publicationId, "pending", { recoveryRefs: [input.manifest.uri] });
	}
	return receipt(input, publicationId, "integrated", {
		mutatedRepositories: [...applied],
		changesApplied: input.target === "user-workspace",
	});
}
