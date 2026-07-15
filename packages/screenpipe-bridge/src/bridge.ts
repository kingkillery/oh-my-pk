import type { GopkActivitySink } from "@pk-nerdsaver-ai/pi-activity-journal";
import type { BridgeCursorStore } from "./cursor";
import { buildClipDerivative } from "./manifest";
import { segmentFramesIntoClips } from "./segmentation";
import type { FrameSegment, ScreenpipeFrameRow } from "./types";

export interface FrameSource {
	fetchRedactedFrames(options: { sinceFrameId: number; limit: number }): Promise<readonly ScreenpipeFrameRow[]>;
}

export interface ScreenpipeBridgeOptions {
	readonly frameSource: FrameSource;
	readonly sink: GopkActivitySink;
	readonly cursorStore: BridgeCursorStore;
	readonly sessionId: string;
	readonly captureRoot: string;
	readonly fetchLimit?: number;
	readonly maximumIdleMs?: number;
	/**
	 * Re-fetches this many already-cursored frames on every poll so a frame
	 * whose redaction lands out of order (screenpipe's worker does not
	 * guarantee FIFO completion) still gets picked up. A frame that finishes
	 * redaction more than this many rows after the cursor has moved past it
	 * is permanently missed — size this to the worst realistic redaction lag.
	 */
	readonly refetchMargin?: number;
}

export interface BridgeRunSummary {
	readonly fetchedFrameCount: number;
	readonly emittedClipCount: number;
	readonly openSegmentCount: number;
	readonly cursorFrameId: number;
}

const DEFAULT_FETCH_LIMIT = 2_000;
const DEFAULT_REFETCH_MARGIN = 200;

/** Polls a local screenpipe instance for newly redacted frames and forwards them to the activity-journal gopk sink. */
export class ScreenpipeBridge {
	#options: ScreenpipeBridgeOptions;

	constructor(options: ScreenpipeBridgeOptions) {
		this.#options = options;
	}

	async runOnce(): Promise<BridgeRunSummary> {
		const { frameSource, sink, cursorStore, sessionId, captureRoot, maximumIdleMs } = this.#options;
		const fetchLimit = this.#options.fetchLimit ?? DEFAULT_FETCH_LIMIT;
		const refetchMargin = this.#options.refetchMargin ?? DEFAULT_REFETCH_MARGIN;

		const lastFrameId = await cursorStore.read();
		const sinceFrameId = Math.max(0, lastFrameId - refetchMargin);
		const frames = await frameSource.fetchRedactedFrames({ sinceFrameId, limit: fetchLimit });
		if (frames.length === 0)
			return { fetchedFrameCount: 0, emittedClipCount: 0, openSegmentCount: 0, cursorFrameId: lastFrameId };

		const segments = segmentFramesIntoClips(frames, maximumIdleMs !== undefined ? { maximumIdleMs } : {});
		const now = Date.now();
		const idleThresholdMs = maximumIdleMs ?? 5 * 60_000;

		let emittedClipCount = 0;
		let openSegmentCount = 0;
		let cursorFrameId = lastFrameId;
		for (const segment of segments) {
			if (!isSegmentClosed(segment, now, idleThresholdMs)) {
				openSegmentCount++;
				continue;
			}
			const derivative = await buildClipDerivative(segment, { sessionId, captureRoot });
			await sink(derivative);
			emittedClipCount++;
			cursorFrameId = Math.max(cursorFrameId, lastFrameIdOf(segment));
		}

		if (cursorFrameId > lastFrameId) await cursorStore.write(cursorFrameId);
		return { fetchedFrameCount: frames.length, emittedClipCount, openSegmentCount, cursorFrameId };
	}
}

function isSegmentClosed(segment: FrameSegment, now: number, idleThresholdMs: number): boolean {
	return now - Date.parse(segment.window.endedAt) >= idleThresholdMs;
}

function lastFrameIdOf(segment: FrameSegment): number {
	const last = segment.frames[segment.frames.length - 1];
	if (!last) throw new Error("segment must contain at least one frame");
	return last.id;
}
