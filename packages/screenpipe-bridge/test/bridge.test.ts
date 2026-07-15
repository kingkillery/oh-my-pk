import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createGopkActivitySink,
	type GopkClipIngestionPolicy,
	SqliteActivityLedger,
} from "@pk-nerdsaver-ai/pi-activity-journal";
import type { ConsentRecord } from "@pk-nerdsaver-ai/pi-context-policy";
import type { FrameSource } from "../src/bridge";
import { ScreenpipeBridge } from "../src/bridge";
import { createFileCursorStore } from "../src/cursor";
import { frame } from "./fixtures";

const consent: ConsentRecord = {
	userId: "user-1",
	deviceId: "device-1",
	identityVerified: true,
	enabled: true,
	scope: "device",
	remoteStorageEnabled: false,
	policyVersion: "context-retention/v1",
};

const policy: GopkClipIngestionPolicy = {
	enabled: true,
	allowedApplicationIds: [],
	deniedApplicationIds: ["1password"],
	maximumRawClipRetentionMs: 10 * 60_000,
};

const capture = { userId: "user-1", deviceId: "device-1", sessionId: "session-1" };

function fakeFrameSource(frames: readonly ReturnType<typeof frame>[]): FrameSource {
	return {
		async fetchRedactedFrames({ sinceFrameId, limit }) {
			return frames.filter(f => f.id > sinceFrameId).slice(0, limit);
		},
	};
}

describe("ScreenpipeBridge", () => {
	it("emits closed segments as corroborating screen evidence and advances the cursor", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-e2e-"));
		try {
			const ledger = new SqliteActivityLedger(":memory:");
			const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
			const longAgo = Date.now() - 60 * 60_000;
			const frames = [
				frame({ id: 1, timestamp: new Date(longAgo).toISOString() }),
				frame({ id: 2, timestamp: new Date(longAgo + 60_000).toISOString() }),
			];
			const bridge = new ScreenpipeBridge({
				frameSource: fakeFrameSource(frames),
				sink,
				cursorStore: createFileCursorStore(captureRoot),
				sessionId: "session-1",
				captureRoot,
			});

			const summary = await bridge.runOnce();

			expect(summary).toMatchObject({
				fetchedFrameCount: 2,
				emittedClipCount: 1,
				openSegmentCount: 0,
				cursorFrameId: 2,
			});
			const evidence = ledger.list();
			expect(evidence).toHaveLength(1);
			expect(evidence[0]).toMatchObject({ signal: "screen_active", strength: "corroborating" });
			ledger.close();
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("holds back a still-open segment and does not advance the cursor past it", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-e2e-"));
		try {
			const ledger = new SqliteActivityLedger(":memory:");
			const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
			const frames = [frame({ id: 1, timestamp: new Date().toISOString() })];
			const bridge = new ScreenpipeBridge({
				frameSource: fakeFrameSource(frames),
				sink,
				cursorStore: createFileCursorStore(captureRoot),
				sessionId: "session-1",
				captureRoot,
			});

			const summary = await bridge.runOnce();

			expect(summary).toMatchObject({
				fetchedFrameCount: 1,
				emittedClipCount: 0,
				openSegmentCount: 1,
				cursorFrameId: 0,
			});
			expect(ledger.list()).toEqual([]);
			ledger.close();
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("dedupes a segment re-sent by the refetch margin via the ledger's own idempotency", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-e2e-"));
		try {
			const ledger = new SqliteActivityLedger(":memory:");
			const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
			const longAgo = Date.now() - 60 * 60_000;
			const frames = [
				frame({ id: 1, timestamp: new Date(longAgo).toISOString() }),
				frame({ id: 2, timestamp: new Date(longAgo + 60_000).toISOString() }),
			];
			const bridge = new ScreenpipeBridge({
				frameSource: fakeFrameSource(frames),
				sink,
				cursorStore: createFileCursorStore(captureRoot),
				sessionId: "session-1",
				captureRoot,
			});

			await bridge.runOnce();
			// The refetch margin re-sends the same closed segment on the next poll (to catch
			// out-of-order redaction completions); the ledger's INSERT OR IGNORE dedupes it.
			const second = await bridge.runOnce();

			expect(second.emittedClipCount).toBe(1);
			expect(ledger.list()).toHaveLength(1);
			ledger.close();
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("rejects a denied application via the sink's own policy without bridge-side filtering", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-e2e-"));
		try {
			const ledger = new SqliteActivityLedger(":memory:");
			const sink = createGopkActivitySink({ ledger, consent, policy, capture, captureRoot });
			const longAgo = Date.now() - 60 * 60_000;
			const frames = [frame({ id: 1, timestamp: new Date(longAgo).toISOString(), app_name: "1Password" })];
			const bridge = new ScreenpipeBridge({
				frameSource: fakeFrameSource(frames),
				sink,
				cursorStore: createFileCursorStore(captureRoot),
				sessionId: "session-1",
				captureRoot,
			});

			const summary = await bridge.runOnce();

			expect(summary.emittedClipCount).toBe(1);
			expect(ledger.list()).toEqual([]);
			ledger.close();
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});
});
