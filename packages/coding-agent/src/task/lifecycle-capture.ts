import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ArtifactManager } from "../session/artifacts";
import { type ArtifactRefV1, canonicalJson, type LaunchAuthorityRefV1 } from "./launch-contract";
import type { SingleResult } from "./types";
import { captureDeltaPatch, type DeltaPatchResult, type IsolationHandle, type WorktreeBaseline } from "./worktree";

/** Default bound on controller-owned cleanup/capture work (§7.1). */
export const CLEANUP_PERMIT_DEADLINE_MS = 60_000;

/**
 * Opaque, controller-minted cleanup permit (§7.1). Cancellation or
 * expired-lease capture is controller-owned cleanup, not continued worker
 * execution: the permit carries an independent bounded signal (never the
 * already-aborted execution signal) and is scoped to exactly one attempt's
 * retained workspace and artifact namespace. It authorizes capture and
 * quarantine only — never provider calls, user-target mutation, or
 * settlement under an old fence.
 */
export interface CleanupPermit {
	readonly attemptId: string;
	readonly workspaceRoot: string;
	readonly artifactRoot: string;
	readonly deadlineMs: number;
	readonly signal: AbortSignal;
}

export interface CleanupPermitHandle {
	readonly permit: CleanupPermit;
	/** Release the underlying deadline timer once capture/quarantine settles. */
	readonly dispose: () => void;
}

/**
 * Mint a bounded cleanup permit for one attempt. The signal is independent
 * of the execution signal so capture still runs after the worker's own
 * signal aborted; it fires only on the deadline.
 */
export function mintCleanupPermit(input: {
	readonly attemptId: string;
	readonly workspaceRoot: string;
	readonly artifactRoot: string;
	readonly deadlineMs?: number;
}): CleanupPermitHandle {
	const deadlineMs = input.deadlineMs ?? CLEANUP_PERMIT_DEADLINE_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("cleanup permit deadline exceeded")), deadlineMs);
	// Keep the process exit path clean: an idle timer must not hold the loop.
	if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
	return {
		permit: Object.freeze({
			attemptId: input.attemptId,
			workspaceRoot: input.workspaceRoot,
			artifactRoot: input.artifactRoot,
			deadlineMs,
			signal: controller.signal,
		}),
		dispose: () => clearTimeout(timer),
	};
}

export interface LifecycleCaptureInput {
	readonly runId: string;
	readonly nodeId: string;
	readonly attemptId: string;
	/**
	 * The persisted binding this attempt executed under. Required: evidence
	 * that cannot name the authority it was captured under cannot later be
	 * fenced against a superseded or revoked one, which a bare contract
	 * revision integer never could.
	 */
	readonly launchAuthority: LaunchAuthorityRefV1;
	readonly baseline: WorktreeBaseline;
	readonly isolation: IsolationHandle;
	readonly result: SingleResult;
	readonly artifactRoot: string;
	/**
	 * Session artifact registry. When present, artifact identities are
	 * allocated through it (real ids, resolvable `artifact://` URIs) BEFORE
	 * the manifest links them. When absent, identities are content-derived
	 * (`sha256:<digest>`) — never fabricated sequential or attempt-derived
	 * ids.
	 */
	readonly artifactManager?: Pick<ArtifactManager, "allocatePath"> | null;
	/**
	 * Controller-owned cleanup permit. When present it is validated against
	 * this attempt/workspace/artifact root and its bounded signal gates every
	 * stage; an expired permit fails capture rather than running unbounded.
	 */
	readonly permit?: CleanupPermit;
	/** Legacy alias for `permit.signal`; folded into the effective signal. */
	readonly cleanupSignal?: AbortSignal;
	/**
	 * Pre-captured delta, when the caller already diffed the worktree (e.g.
	 * the TaskTool patch/branch path). Skips a second diff; the same bytes
	 * are what the manifest hashes.
	 */
	readonly delta?: DeltaPatchResult;
	/**
	 * `false` marks the captured evidence nonpublishable (late/cancelled
	 * artifacts linked to a superseded attempt). Defaults to `true` for
	 * completed/failed and `false` for cancelled outcomes.
	 */
	readonly publishable?: boolean;
}

export interface CaptureFailureRecord {
	readonly stage: "delta" | "write" | "rename" | "registration" | "manifest" | "acknowledgement" | "permit";
	readonly message: string;
	readonly artifact?: string;
}

/** Per-repo baseline identity + delta binding in the manifest. */
export interface ManifestRepoEntry {
	/** "" for the root repo; repo-relative path for nested repos. */
	readonly relativePath: string;
	readonly repoRoot: string;
	readonly headCommit: string;
	readonly stagedSha256: string;
	readonly unstagedSha256: string;
	readonly untrackedSha256: string;
	readonly untrackedPaths: readonly string[];
	readonly patchRef: ArtifactRefV1 | null;
	readonly touchedFiles: readonly string[];
}

export interface ArtifactManifest {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly nodeId: string;
	readonly attemptId: string;
	/** The persisted binding the captured evidence was produced under. */
	readonly launchAuthority: LaunchAuthorityRefV1;
	readonly outcome: "completed" | "failed" | "cancelled" | "partial" | "capture-failed";
	/** False for late/cancelled evidence linked to a superseded attempt. */
	readonly publishable: boolean;
	readonly baselineHash: string;
	readonly repos: readonly ManifestRepoEntry[];
	readonly rootPatchRef: ArtifactRefV1 | null;
	readonly nestedPatchRefs: readonly ArtifactRefV1[];
	readonly changedPaths: readonly string[];
	readonly rawRefs: {
		readonly output: ArtifactRefV1 | null;
		readonly result: ArtifactRefV1 | null;
		readonly transcript: ArtifactRefV1 | null;
	};
	readonly completeness: {
		readonly complete: boolean;
		readonly rawOutputSource: "executor-sink" | "capped-result" | "none";
		readonly rawOutputTruncated: boolean;
		readonly missingRefs: readonly string[];
	};
	readonly failures: readonly CaptureFailureRecord[];
	readonly manifestHash: string;
}

/** Durable acknowledgement: every artifact + the manifest + the ref pointer are persisted. */
export interface CaptureAck {
	readonly ok: true;
	readonly manifest: ArtifactManifest;
	readonly manifestRef: ArtifactRefV1;
	/** Absolute path of the persisted manifest file. */
	readonly manifestPath: string;
	/** Absolute path of the persisted manifest-ref pointer (written last). */
	readonly manifestRefPath: string;
	/** The delta the manifest was built from (reusable by the caller). */
	readonly delta: DeltaPatchResult;
	/** Absolute path of the persisted root patch artifact, when non-empty. */
	readonly rootPatchPath: string | null;
}

/** Typed capture failure. A caught error is NOT durable success. */
export interface CaptureFailure {
	readonly ok: false;
	readonly code: "capture-failed";
	readonly attemptId: string;
	readonly error: string;
	readonly failures: readonly CaptureFailureRecord[];
	/** Best-effort copy of the retained workspace for recovery. */
	readonly quarantinePath: string | null;
	/** The workspace the caller MUST retain (no cleanup) after this failure. */
	readonly retainedWorkspace: string;
}

export type LifecycleCaptureResult = CaptureAck | CaptureFailure;

function hashBytes(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Attempt-owned immutable write: temp name in the same directory, flush +
 * close, then atomic rename. Content hashes cover the exact bytes written.
 */
async function writeAtomic(finalPath: string, data: string | Uint8Array): Promise<void> {
	const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const handle = await fs.open(tmpPath, "w");
	try {
		await handle.writeFile(data);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(tmpPath, finalPath);
}

interface AllocatedArtifact {
	readonly ref: ArtifactRefV1;
	readonly path: string;
}

/**
 * Persist one artifact blob and return its registered identity. With an
 * ArtifactManager the id/URI come from `allocatePath` (the registry owns the
 * identity before the manifest links it); without one the identity is the
 * content digest itself. Either way the bytes land atomically.
 */
async function persistArtifact(input: {
	readonly bytes: Uint8Array;
	readonly mediaType: string;
	readonly toolType: string;
	readonly fileName: string;
	readonly artifactRoot: string;
	readonly artifactManager: Pick<ArtifactManager, "allocatePath"> | null;
	readonly provenanceId: string;
}): Promise<AllocatedArtifact> {
	const sha256 = hashBytes(input.bytes);
	if (input.artifactManager) {
		const allocated = await input.artifactManager.allocatePath(input.toolType);
		await writeAtomic(allocated.path, input.bytes);
		return {
			path: allocated.path,
			ref: Object.freeze({
				schemaVersion: 1 as const,
				artifactId: allocated.id,
				uri: `artifact://${allocated.id}`,
				sha256,
				bytes: input.bytes.byteLength,
				mediaType: input.mediaType,
				provenanceId: input.provenanceId,
			}),
		};
	}
	const finalPath = path.join(input.artifactRoot, input.fileName);
	await writeAtomic(finalPath, input.bytes);
	return {
		path: finalPath,
		ref: Object.freeze({
			schemaVersion: 1 as const,
			artifactId: `sha256:${sha256}`,
			uri: pathToFileURL(finalPath).href,
			sha256,
			bytes: input.bytes.byteLength,
			mediaType: input.mediaType,
			provenanceId: input.provenanceId,
		}),
	};
}

function repoBaselineEntry(relativePath: string, rb: WorktreeBaseline["root"]): ManifestRepoEntry {
	return {
		relativePath,
		repoRoot: rb.repoRoot,
		headCommit: rb.headCommit,
		stagedSha256: hashBytes(rb.staged),
		unstagedSha256: hashBytes(rb.unstaged),
		untrackedSha256: hashBytes(rb.untrackedPatch),
		untrackedPaths: Object.freeze([...rb.untracked]),
		patchRef: null,
		touchedFiles: Object.freeze([]),
	};
}

/**
 * Common, durable lifecycle artifact capture (A09, §7.1). Captures the
 * root + nested staged/unstaged/untracked binary-safe delta, raw executor
 * output/result/transcript refs, and a schema-v1 manifest binding
 * run/node/attempt/contract/baseline — all BEFORE isolation cleanup.
 *
 * Every file is written to a temp name, flushed, closed and atomically
 * renamed; the manifest file is written after all artifacts, and the
 * manifest-ref pointer is persisted last as the durable acknowledgement.
 * Callers must clean the workspace up ONLY after receiving `ok: true`; on
 * `ok: false` the workspace is retained/quarantined and the failure is
 * reported separately from the execution outcome.
 */
export async function captureLifecycleArtifacts(input: LifecycleCaptureInput): Promise<LifecycleCaptureResult> {
	const failures: CaptureFailureRecord[] = [];
	const isolationDir = input.isolation.mergedDir;
	const workspaceRoot = path.dirname(isolationDir);
	const encoder = new TextEncoder();

	let outcome: ArtifactManifest["outcome"] = "completed";
	if (input.result.aborted) {
		outcome = "cancelled";
	} else if (input.result.exitCode !== 0 || input.result.error) {
		outcome = "failed";
	}
	const publishable = input.publishable ?? outcome !== "cancelled";

	const permitSignal = input.permit?.signal ?? input.cleanupSignal;
	const checkPermit = (stage: CaptureFailureRecord["stage"]): string | null => {
		if (input.permit) {
			if (input.permit.attemptId !== input.attemptId)
				return `cleanup permit attempt '${input.permit.attemptId}' does not match '${input.attemptId}'`;
			if (path.resolve(input.permit.artifactRoot) !== path.resolve(input.artifactRoot))
				return "cleanup permit artifact root does not match this capture";
			if (path.resolve(input.permit.workspaceRoot) !== path.resolve(workspaceRoot))
				return "cleanup permit workspace does not match this isolation";
		}
		if (permitSignal?.aborted)
			return `capture aborted at stage '${stage}': ${String(permitSignal.reason ?? "deadline")}`;
		return null;
	};

	const fail = async (stage: CaptureFailureRecord["stage"], err: unknown): Promise<CaptureFailure> => {
		failures.push({ stage, message: errorMessage(err) });
		// Quarantine: best-effort copy of the retained merged workspace so
		// recovery has a stable location even if the caller later tears the
		// handle down. Only the attempt's own merged dir is copied — never
		// its parent (which may be a shared temp root) — and only when it
		// actually exists.
		let quarantinePath: string | null = null;
		try {
			if ((await fs.stat(isolationDir).catch(() => null))?.isDirectory()) {
				quarantinePath = path.join(input.artifactRoot, "quarantine", input.attemptId, "workspace");
				await fs.mkdir(path.dirname(quarantinePath), { recursive: true });
				await fs.cp(isolationDir, quarantinePath, { recursive: true, force: true });
			}
		} catch (qErr) {
			failures.push({ stage: "write", message: `quarantine copy failed: ${errorMessage(qErr)}` });
			quarantinePath = null;
		}
		try {
			const recordPath = path.join(input.artifactRoot, "quarantine", input.attemptId, "capture-failed.json");
			await fs.mkdir(path.dirname(recordPath), { recursive: true });
			await writeAtomic(
				recordPath,
				JSON.stringify({
					code: "capture-failed",
					attemptId: input.attemptId,
					runId: input.runId,
					nodeId: input.nodeId,
					outcome,
					failures,
					quarantinePath,
					retainedWorkspace: workspaceRoot,
				}),
			);
		} catch {
			// The typed failure return still carries the quarantine location.
		}
		return {
			ok: false,
			code: "capture-failed",
			attemptId: input.attemptId,
			error: failures.map(f => `[${f.stage}] ${f.message}`).join("; "),
			failures: Object.freeze([...failures]),
			quarantinePath,
			retainedWorkspace: workspaceRoot,
		};
	};

	try {
		const permitError = checkPermit("permit");
		if (permitError) return await fail("permit", new Error(permitError));
		await fs.mkdir(input.artifactRoot, { recursive: true });

		if (!input.delta) {
			const isolationStat = await fs.stat(isolationDir).catch(() => null);
			if (!isolationStat?.isDirectory()) {
				return await fail("delta", new Error(`isolation workspace missing: ${isolationDir}`));
			}
		}
		const delta = input.delta ?? (await captureDeltaPatch(isolationDir, input.baseline));
		if (checkPermit("delta")) return await fail("delta", new Error(checkPermit("delta")!));

		// --- Repo entries: root + each nested baseline, then patch refs -----
		const repos: ManifestRepoEntry[] = [repoBaselineEntry("", input.baseline.root)];
		for (const nested of input.baseline.nested) repos.push(repoBaselineEntry(nested.relativePath, nested.baseline));

		const changedPaths: string[] = [...delta.rootTouchedFiles];
		const nestedPatchRefs: ArtifactRefV1[] = [];
		let rootPatchRef: ArtifactRefV1 | null = null;
		let rootPatchPath: string | null = null;

		if (delta.rootPatch.trim()) {
			const allocated = await persistArtifact({
				bytes: encoder.encode(delta.rootPatch),
				mediaType: "text/x-diff",
				toolType: "lifecycle-root-patch",
				fileName: `${input.attemptId}.root.patch`,
				artifactRoot: input.artifactRoot,
				artifactManager: input.artifactManager ?? null,
				provenanceId: input.attemptId,
			});
			rootPatchRef = allocated.ref;
			rootPatchPath = allocated.path;
			repos[0] = { ...repos[0], patchRef: rootPatchRef, touchedFiles: Object.freeze([...delta.rootTouchedFiles]) };
		}

		for (let i = 0; i < delta.nestedPatches.length; i++) {
			const np = delta.nestedPatches[i];
			for (const touched of np.touchedFiles ?? []) changedPaths.push(`${np.relativePath}/${touched}`);
			if (!np.patch.trim()) continue;
			const allocated = await persistArtifact({
				bytes: encoder.encode(np.patch),
				mediaType: "text/x-diff",
				toolType: "lifecycle-nested-patch",
				fileName: `${input.attemptId}.nested-${i}.patch`,
				artifactRoot: input.artifactRoot,
				artifactManager: input.artifactManager ?? null,
				provenanceId: input.attemptId,
			});
			nestedPatchRefs.push(allocated.ref);
			const repoIndex = repos.findIndex(r => r.relativePath === np.relativePath);
			if (repoIndex >= 0) {
				repos[repoIndex] = {
					...repos[repoIndex],
					patchRef: allocated.ref,
					touchedFiles: Object.freeze([...(np.touchedFiles ?? [])]),
				};
			} else {
				repos.push({
					relativePath: np.relativePath,
					repoRoot: path.join(input.baseline.root.repoRoot, np.relativePath),
					headCommit: "",
					stagedSha256: hashBytes(""),
					unstagedSha256: hashBytes(""),
					untrackedSha256: hashBytes(""),
					untrackedPaths: Object.freeze([]),
					patchRef: allocated.ref,
					touchedFiles: Object.freeze([...(np.touchedFiles ?? [])]),
				});
			}
		}
		if (checkPermit("write")) return await fail("write", new Error(checkPermit("write")!));

		// --- Raw refs: full output comes from the executor's raw sink -------
		// (`result.outputPath`), never reconstructed from the capped
		// `SingleResult.output`. codeWrite/evidence-digest projections stay
		// receipt-only; the pre-projection sink file is what we persist.
		const missingRefs: string[] = [];
		let rawOutputSource: "executor-sink" | "capped-result" | "none" = "none";
		let rawOutputTruncated = false;
		let outputRef: ArtifactRefV1 | null = null;
		let rawOutputBytes: Uint8Array | null = null;
		if (input.result.outputPath) {
			try {
				rawOutputBytes = new Uint8Array(await fs.readFile(input.result.outputPath));
				rawOutputSource = "executor-sink";
			} catch (readErr) {
				failures.push({
					stage: "write",
					message: `raw sink unreadable: ${errorMessage(readErr)}`,
					artifact: input.result.outputPath,
				});
			}
		}
		if (rawOutputBytes === null && input.result.output) {
			rawOutputBytes = encoder.encode(input.result.output);
			rawOutputSource = "capped-result";
			rawOutputTruncated = input.result.truncated === true;
			if (rawOutputTruncated) missingRefs.push("rawOutput:full");
		}
		if (rawOutputBytes !== null) {
			outputRef = (
				await persistArtifact({
					bytes: rawOutputBytes,
					mediaType: "text/plain",
					toolType: "lifecycle-output",
					fileName: `${input.attemptId}.raw.txt`,
					artifactRoot: input.artifactRoot,
					artifactManager: input.artifactManager ?? null,
					provenanceId: input.attemptId,
				})
			).ref;
		} else {
			missingRefs.push("rawOutput");
		}

		const resultRef = (
			await persistArtifact({
				bytes: encoder.encode(JSON.stringify(input.result)),
				mediaType: "application/json",
				toolType: "lifecycle-result",
				fileName: `${input.attemptId}.result.json`,
				artifactRoot: input.artifactRoot,
				artifactManager: input.artifactManager ?? null,
				provenanceId: input.attemptId,
			})
		).ref;

		let transcriptRef: ArtifactRefV1 | null = null;
		const transcriptPath = path.join(input.artifactRoot, `${input.result.id}.jsonl`);
		try {
			const transcriptBytes = new Uint8Array(await fs.readFile(transcriptPath));
			transcriptRef = (
				await persistArtifact({
					bytes: transcriptBytes,
					mediaType: "application/x-ndjson",
					toolType: "lifecycle-transcript",
					fileName: `${input.attemptId}.transcript.jsonl`,
					artifactRoot: input.artifactRoot,
					artifactManager: input.artifactManager ?? null,
					provenanceId: input.attemptId,
				})
			).ref;
		} catch {
			missingRefs.push("transcript");
		}
		if (checkPermit("registration")) return await fail("registration", new Error(checkPermit("registration")!));

		// --- Manifest: content hash covers exact bytes of the canonical body -
		const baselineHash = hashBytes(canonicalJson(input.baseline));
		const manifestBody = {
			schemaVersion: 1 as const,
			runId: input.runId,
			nodeId: input.nodeId,
			attemptId: input.attemptId,
			launchAuthority: input.launchAuthority,
			outcome,
			publishable,
			baselineHash,
			repos,
			rootPatchRef,
			nestedPatchRefs,
			changedPaths,
			rawRefs: { output: outputRef, result: resultRef, transcript: transcriptRef },
			completeness: {
				complete: failures.length === 0 && missingRefs.length === 0,
				rawOutputSource,
				rawOutputTruncated,
				missingRefs,
			},
			failures,
		};
		const manifestHash = hashBytes(canonicalJson(manifestBody));
		const manifest: ArtifactManifest = Object.freeze({
			...manifestBody,
			repos: Object.freeze(repos),
			nestedPatchRefs: Object.freeze(nestedPatchRefs),
			changedPaths: Object.freeze(changedPaths),
			rawRefs: Object.freeze(manifestBody.rawRefs),
			completeness: Object.freeze({
				...manifestBody.completeness,
				missingRefs: Object.freeze(missingRefs),
			}),
			failures: Object.freeze([...failures]),
			manifestHash,
		});

		const manifestPath = path.join(input.artifactRoot, `${input.attemptId}.manifest.json`);
		await writeAtomic(manifestPath, JSON.stringify(manifest));
		const manifestBytes = encoder.encode(JSON.stringify(manifest));
		const manifestRef: ArtifactRefV1 = Object.freeze({
			schemaVersion: 1,
			artifactId: `sha256:${manifestHash}`,
			uri: pathToFileURL(manifestPath).href,
			sha256: hashBytes(manifestBytes),
			bytes: manifestBytes.byteLength,
			mediaType: "application/json",
			provenanceId: input.attemptId,
		});
		if (checkPermit("manifest")) return await fail("manifest", new Error(checkPermit("manifest")!));

		// Durable acknowledgement: the manifest-ref pointer is the LAST write.
		const manifestRefPath = path.join(input.artifactRoot, `${input.attemptId}.manifest-ref.json`);
		await writeAtomic(manifestRefPath, JSON.stringify(manifestRef));
		if (checkPermit("acknowledgement"))
			return await fail("acknowledgement", new Error(checkPermit("acknowledgement")!));

		return {
			ok: true,
			manifest,
			manifestRef,
			manifestPath,
			manifestRefPath,
			delta,
			rootPatchPath,
		};
	} catch (err) {
		return fail(failures.length > 0 ? failures[failures.length - 1].stage : "write", err);
	}
}
