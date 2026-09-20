import { createHash } from "node:crypto";

export interface ObservationRecordV1 {
	readonly schemaVersion: 1;
	readonly observationId: string;
	readonly runId: string;
	readonly nodeId: string;
	readonly attemptId: string;
	readonly toolCallId: string;
	readonly sourceHash: string;
	readonly byteLength: number;
	readonly exitCode: number;
	readonly rawArtifactId: string;
	readonly projectionProvenance: readonly string[];
}

export interface ReducedObservationV1 {
	readonly schemaVersion: 1;
	readonly observationId: string;
	readonly sourceHash: string;
	readonly quotes: readonly { readonly start: number; readonly end: number; readonly text: string }[];
	readonly exitCode: number;
	readonly complete: boolean;
}

export type ReduceResult =
	| { readonly ok: true; readonly reduced: ReducedObservationV1 }
	| {
			readonly ok: false;
			readonly code: "hash_mismatch" | "span_invalid" | "quote_mismatch" | "exit_mismatch";
			readonly fallback: "raw";
	  };

/**
 * Recoverable observations (A16).
 * Exact permitted raw bytes are always retained before optional reduction.
 * The deterministic validator checks source hash, byte spans, quotes, exit
 * code, and artifact ownership; invalid or incomplete extraction falls back
 * to the permitted raw path with explicit incompleteness — never a
 * fabricated pass. A nonzero exit never becomes a pass.
 */
export function recordObservation(input: {
	runId: string;
	nodeId: string;
	attemptId: string;
	toolCallId: string;
	rawBytes: string;
	exitCode: number;
	provenance: readonly string[];
}): { record: ObservationRecordV1; raw: string } {
	const sourceHash = createHash("sha256").update(input.rawBytes, "utf-8").digest("hex");
	return {
		record: {
			schemaVersion: 1,
			observationId: `obs-${input.attemptId}-${input.toolCallId}`,
			runId: input.runId,
			nodeId: input.nodeId,
			attemptId: input.attemptId,
			toolCallId: input.toolCallId,
			sourceHash,
			byteLength: Buffer.byteLength(input.rawBytes, "utf-8"),
			exitCode: input.exitCode,
			rawArtifactId: `art-raw-${input.attemptId}-${input.toolCallId}`,
			projectionProvenance: [...input.provenance],
		},
		raw: input.rawBytes,
	};
}

export function validateReduction(
	record: ObservationRecordV1,
	raw: string,
	candidate: { quotes: readonly { start: number; end: number; text: string }[]; exitCode: number },
): ReduceResult {
	const sourceHash = createHash("sha256").update(raw, "utf-8").digest("hex");
	if (sourceHash !== record.sourceHash) {
		return { ok: false, code: "hash_mismatch", fallback: "raw" };
	}
	if (candidate.exitCode !== record.exitCode) {
		return { ok: false, code: "exit_mismatch", fallback: "raw" };
	}
	for (const quote of candidate.quotes) {
		if (quote.start < 0 || quote.end > raw.length || quote.start >= quote.end) {
			return { ok: false, code: "span_invalid", fallback: "raw" };
		}
		if (raw.slice(quote.start, quote.end) !== quote.text) {
			return { ok: false, code: "quote_mismatch", fallback: "raw" };
		}
	}
	return {
		ok: true,
		reduced: {
			schemaVersion: 1,
			observationId: record.observationId,
			sourceHash: record.sourceHash,
			quotes: candidate.quotes.map(q => ({ ...q })),
			exitCode: record.exitCode,
			complete: true,
		},
	};
}
