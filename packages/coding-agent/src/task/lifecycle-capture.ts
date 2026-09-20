import { createHash } from "node:crypto";
import * as path from "node:path";
import type { ArtifactRefV1 } from "./launch-contract";
import type { SingleResult } from "./types";
import { captureDeltaPatch, type IsolationHandle, type WorktreeBaseline } from "./worktree";

export interface LifecycleCaptureInput {
	readonly runId: string;
	readonly nodeId: string;
	readonly attemptId: string;
	readonly contractVersion: number;
	readonly baseline: WorktreeBaseline;
	readonly isolation: IsolationHandle;
	readonly result: SingleResult;
	readonly artifactRoot: string;
	readonly cleanupSignal?: AbortSignal;
}

export interface ArtifactManifestEntry {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly mediaType: string;
}

export interface ArtifactManifest {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly nodeId: string;
	readonly attemptId: string;
	readonly contractVersion: number;
	readonly outcome: "completed" | "failed" | "cancelled" | "partial" | "capture-failed";
	readonly baselineHash: string;
	readonly rootPatchRef: ArtifactRefV1 | null;
	readonly nestedPatchRefs: readonly ArtifactRefV1[];
	readonly changedPaths: readonly string[];
	readonly rawOutputRef: ArtifactRefV1 | null;
	readonly manifestHash: string;
}

function hashBytes(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * Common, durable lifecycle artifact capture function (A09).
 * Captures root + nested patches, untracked changes, and raw outputs
 * before isolation cleanup.
 */
export async function captureLifecycleArtifacts(input: LifecycleCaptureInput): Promise<ArtifactManifest> {
	const isolationDir = input.isolation.mergedDir;
	let outcome: ArtifactManifest["outcome"] = "completed";

	if (input.result.aborted) {
		outcome = "cancelled";
	} else if (input.result.exitCode !== 0 || input.result.error) {
		outcome = "failed";
	}

	try {
		const delta = await captureDeltaPatch(isolationDir, input.baseline);
		let rootPatchRef: ArtifactRefV1 | null = null;
		const nestedPatchRefs: ArtifactRefV1[] = [];
		const changedPaths: string[] = [...delta.rootTouchedFiles];
		for (const np of delta.nestedPatches) {
			for (const touched of np.touchedFiles ?? []) changedPaths.push(`${np.relativePath}/${touched}`);
		}

		if (delta.rootPatch.trim()) {
			const patchFileName = `${input.attemptId}.patch`;
			const patchPath = path.join(input.artifactRoot, patchFileName);
			await Bun.write(patchPath, delta.rootPatch);

			const sha256 = hashBytes(delta.rootPatch);
			const bytes = Buffer.byteLength(delta.rootPatch, "utf-8");

			rootPatchRef = {
				schemaVersion: 1,
				artifactId: `art-patch-${input.attemptId}`,
				uri: `artifact://${patchFileName}`,
				sha256,
				bytes,
				mediaType: "text/x-diff",
				provenanceId: input.attemptId,
			};
		}

		for (let i = 0; i < delta.nestedPatches.length; i++) {
			const np = delta.nestedPatches[i];
			if (np.patch.trim()) {
				const npFileName = `${input.attemptId}.nested-${i}.patch`;
				const npPath = path.join(input.artifactRoot, npFileName);
				await Bun.write(npPath, np.patch);

				const sha256 = hashBytes(np.patch);
				const bytes = Buffer.byteLength(np.patch, "utf-8");

				nestedPatchRefs.push({
					schemaVersion: 1,
					artifactId: `art-nested-${input.attemptId}-${i}`,
					uri: `artifact://${npFileName}`,
					sha256,
					bytes,
					mediaType: "text/x-diff",
					provenanceId: input.attemptId,
				});
			}
		}

		let rawOutputRef: ArtifactRefV1 | null = null;
		if (input.result.output) {
			const rawFileName = `${input.attemptId}.raw.txt`;
			const rawPath = path.join(input.artifactRoot, rawFileName);
			await Bun.write(rawPath, input.result.output);

			const sha256 = hashBytes(input.result.output);
			const bytes = Buffer.byteLength(input.result.output, "utf-8");

			rawOutputRef = {
				schemaVersion: 1,
				artifactId: `art-raw-${input.attemptId}`,
				uri: `artifact://${rawFileName}`,
				sha256,
				bytes,
				mediaType: "text/plain",
				provenanceId: input.attemptId,
			};
		}

		const baselineHash = hashBytes(JSON.stringify(input.baseline));
		const contentForDigest = JSON.stringify({
			runId: input.runId,
			nodeId: input.nodeId,
			attemptId: input.attemptId,
			outcome,
			baselineHash,
			rootPatchHash: rootPatchRef?.sha256 ?? null,
			nestedHashes: nestedPatchRefs.map(n => n.sha256),
		});
		const manifestHash = hashBytes(contentForDigest);

		return Object.freeze({
			schemaVersion: 1,
			runId: input.runId,
			nodeId: input.nodeId,
			attemptId: input.attemptId,
			contractVersion: input.contractVersion,
			outcome,
			baselineHash,
			rootPatchRef,
			nestedPatchRefs: Object.freeze(nestedPatchRefs),
			changedPaths: Object.freeze(changedPaths),
			rawOutputRef,
			manifestHash,
		});
	} catch (err) {
		const failureDigest = hashBytes(`failure:${input.attemptId}:${String(err)}`);
		return Object.freeze({
			schemaVersion: 1,
			runId: input.runId,
			nodeId: input.nodeId,
			attemptId: input.attemptId,
			contractVersion: input.contractVersion,
			outcome: "capture-failed",
			baselineHash: hashBytes(JSON.stringify(input.baseline)),
			rootPatchRef: null,
			nestedPatchRefs: Object.freeze([]),
			changedPaths: Object.freeze([]),
			rawOutputRef: null,
			manifestHash: failureDigest,
		});
	}
}
