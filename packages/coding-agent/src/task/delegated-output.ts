import * as fs from "node:fs/promises";
import path from "node:path";
import type { ArtifactManager } from "../session/artifacts";
import type { CodeWriteReceipt } from "./code-write";
import type { SingleResult } from "./types";

export function projectEvidenceDigest(rawOutput: string, reference: string): { output: string; truncated: boolean } {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(rawOutput);
	if (bytes.byteLength <= 8000) return { output: rawOutput, truncated: false };
	const note = `\n[Incomplete evidence digest: capped at 8,000 UTF-8 bytes. Full output: ${reference}]`;
	const budget = 8000 - encoder.encode(note).byteLength;
	if (budget < 0) throw new Error("Evidence digest reference exceeds the 8,000-byte output budget.");
	return {
		output: new TextDecoder().decode(bytes.subarray(0, budget), { stream: true }) + note,
		truncated: true,
	};
}

/** Keep worker prose and source in artifacts, never in codeWrite parent-facing fields. */
export async function projectDelegatedIoResult(options: {
	result: SingleResult;
	kind: "code-write" | "evidence-digest";
	artifactsDir: string;
	artifactManager?: ArtifactManager;
	receipt?: CodeWriteReceipt;
}): Promise<void> {
	const { result, kind, artifactsDir, artifactManager, receipt } = options;
	const rawOutput = result.outputPath
		? await fs.readFile(result.outputPath, "utf8").catch(() => result.output)
		: result.output;
	const transcriptPath = path.join(artifactsDir, `${result.id}.jsonl`);
	const transcript = await fs.readFile(transcriptPath, "utf8").catch(() => "");
	const full =
		kind === "code-write" || result.error || result.isError
			? `${transcript}\n${JSON.stringify(result)}\n${rawOutput}`
			: rawOutput;
	const rawArtifact = path.join(artifactsDir, `${result.id}.delegated.log`);
	let reference: string;
	if (artifactManager) {
		reference = `artifact://${await artifactManager.save(full, kind)}`;
	} else {
		await fs.writeFile(rawArtifact, full);
		reference = rawArtifact;
	}
	result.delegatedIoKind = kind;
	result.transcriptArtifact = reference;
	result.extractedToolData = undefined;
	result.retryFailure = undefined;
	result.lastIntent = undefined;
	result.stderr = "";
	if (kind === "code-write") {
		const succeeded =
			result.exitCode === 0 &&
			!result.error &&
			!result.isError &&
			!result.aborted &&
			receipt?.changesApplied === true;
		result.output = succeeded
			? JSON.stringify(receipt)
			: `[Fusion I/O] codeWrite generation or integration failed. No successful receipt was produced. Inspect ${reference} for the retained diagnostic and transcript.`;
		if (!succeeded) {
			result.exitCode = 1;
			result.isError = true;
			result.error = result.output;
			result.mergeSummary = result.output;
			if (result.abortReason) result.abortReason = "codeWrite interrupted; inspect the retained artifact.";
		}
		result.nestedPatches = undefined;
		result.truncated = false;
	} else {
		const digest = projectEvidenceDigest(rawOutput, reference);
		result.output = digest.output;
		result.truncated = digest.truncated;
		if (result.error) result.error = `[Fusion I/O] Evidence digest failed; inspect ${reference}.`;
	}
	// Consumers of agent://, async completion and provider conversion may reopen outputPath.
	// Point every projected result at the bounded/native receipt, never the raw worker output.
	const projectedPath = path.join(artifactsDir, `${result.id}.md`);
	await fs.writeFile(projectedPath, result.output);
	result.outputPath = projectedPath;
	result.outputMeta = { lineCount: result.output.split("\n").length, charCount: result.output.length };
}

export const ORCHESTRATOR_RECEIPT_MAX_BYTES = 1_200;
const ORCHESTRATOR_MERGE_SUMMARY_MAX_BYTES = 240;
const FENCED_BLOCK_RE = /```[\s\S]*?```/g;

function sliceUtf8Bytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const encoder = new TextEncoder();
	const bytes = encoder.encode(text);
	if (bytes.byteLength <= maxBytes) return text;
	return new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true });
}

/**
 * Format a thin parent-facing receipt (`<= 1,200` UTF-8 bytes) for a settled
 * worker in `fusion.mode: "orchestrator"`. Elides fenced blocks > 12 lines and
 * points the parent to `artifactRef` for full detail.
 */
export function formatCompactTaskReceipt(options: {
	result: SingleResult;
	rawOutput: string;
	artifactRef: string;
	mergeSummary?: string;
}): { output: string; truncated: boolean } {
	const { result, rawOutput, artifactRef, mergeSummary } = options;
	const statusLabel = result.aborted
		? "cancelled"
		: result.isError === true
			? "failed"
			: result.exitCode === 0 && result.error
				? "merge-failed"
				: result.exitCode === 0
					? "completed"
					: `failed(${result.exitCode})`;
	const header = `[receipt id=${result.id} agent=${result.agent} status=${statusLabel} model=${result.resolvedModel ?? "unknown"}${
		result.recoveryAttempt ? ` climb=${result.recoveryAttempt}` : ""
	}${result.changesApplied !== undefined ? ` changesApplied=${result.changesApplied}` : ""} full=${artifactRef}]`;

	let elidedFence = false;
	const sanitizedBody = rawOutput
		.replace(FENCED_BLOCK_RE, block => {
			if (block.split("\n").length > 12) {
				elidedFence = true;
				return `[fenced block elided -> ${artifactRef}]`;
			}
			return block;
		})
		.trim();

	const parts = [header];
	const trimmedMerge = mergeSummary?.trim();
	if (trimmedMerge) {
		parts.push(sliceUtf8Bytes(trimmedMerge, ORCHESTRATOR_MERGE_SUMMARY_MAX_BYTES));
	}
	if (sanitizedBody) {
		parts.push(sanitizedBody);
	}

	const combined = parts.join("\n");
	const encoder = new TextEncoder();
	const bytes = encoder.encode(combined);
	if (bytes.byteLength <= ORCHESTRATOR_RECEIPT_MAX_BYTES) {
		return { output: combined, truncated: elidedFence };
	}

	const note = `\n[…truncated to 1,200B; read ${artifactRef}]`;
	const noteBytes = encoder.encode(note).byteLength;
	const budget = ORCHESTRATOR_RECEIPT_MAX_BYTES - noteBytes;
	if (budget <= 0) {
		return { output: sliceUtf8Bytes(combined, ORCHESTRATOR_RECEIPT_MAX_BYTES), truncated: true };
	}
	return {
		output: sliceUtf8Bytes(combined, budget) + note,
		truncated: true,
	};
}

/**
 * Persist full worker output to `artifact://` (falling back to `agent://<id>`)
 * and build a compact `<= 1,200`-byte parent receipt without mutating `result.output`
 * so TUI rendering keeps full visibility.
 */
export async function projectOrchestratorTaskReceipt(options: {
	result: SingleResult;
	artifactsDir: string;
	artifactManager?: ArtifactManager;
	mergeSummary?: string;
}): Promise<{ text: string; truncated: boolean }> {
	const { result, artifactManager, mergeSummary } = options;
	const rawOutput = result.outputPath
		? await fs.readFile(result.outputPath, "utf8").catch(() => result.output)
		: result.output;
	const fullText =
		result.stderr && (result.exitCode !== 0 || result.isError || result.error)
			? `${rawOutput}\n\n--- stderr ---\n${result.stderr}`
			: rawOutput;

	let reference = `agent://${result.id}`;
	if (artifactManager) {
		try {
			const id = await artifactManager.save(fullText, "task-receipt");
			reference = `artifact://${id}`;
		} catch {
			// Non-fatal: fall back to agent:// reference
		}
	}
	result.transcriptArtifact = reference;
	const formatted = formatCompactTaskReceipt({
		result,
		rawOutput,
		artifactRef: reference,
		mergeSummary,
	});
	return { text: formatted.output, truncated: formatted.truncated };
}
