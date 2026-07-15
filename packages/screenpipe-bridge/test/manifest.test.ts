import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildClipDerivative } from "../src/manifest";
import type { FrameSegment } from "../src/types";
import { frame } from "./fixtures";

function segment(overrides: Partial<FrameSegment> = {}): FrameSegment {
	return {
		deviceName: "device-1",
		frames: [
			frame({
				id: 10,
				timestamp: "2026-07-13T14:00:00.000Z",
				content_hash: 111,
				full_text_redacted_at: 1_752_415_200,
				has_full_text: 1,
			}),
			frame({
				id: 11,
				timestamp: "2026-07-13T14:01:00.000Z",
				content_hash: 222,
				full_text_redacted_at: 1_752_415_260,
				has_full_text: 1,
			}),
		],
		window: { startedAt: "2026-07-13T14:00:00.000Z", endedAt: "2026-07-13T14:01:00.000Z" },
		appIdentity: { processName: "code" },
		...overrides,
	};
}

describe("buildClipDerivative", () => {
	it("builds a derivative with a manifest file, clip hash, and attestation", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-"));
		try {
			const derivative = await buildClipDerivative(segment(), { sessionId: "session-1", captureRoot });

			expect(derivative.clipId).toBe("device-1:10-11");
			expect(derivative.sessionId).toBe("session-1");
			expect(derivative.window).toEqual({
				startedAt: "2026-07-13T14:00:00.000Z",
				endedAt: "2026-07-13T14:01:00.000Z",
			});
			expect(derivative.appIdentity).toEqual({ processName: "code" });
			expect(derivative.clipHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(derivative.keyframeHash).toBeUndefined();
			expect(derivative.sanitizationAttestation.status).toBe("sanitized");
			expect(derivative.sanitizationAttestation.completedAt).toBe("2026-07-13T14:01:00.000Z");
			expect(derivative.sanitizationAttestation.sanitizerVersion).toBe(
				"screenpipe-redact;image_redaction_version=n/a",
			);

			const manifestRaw = await fs.readFile(derivative.localManifestPointer, "utf8");
			expect(JSON.parse(manifestRaw)).toMatchObject({
				clipId: "device-1:10-11",
				frameIds: [10, 11],
				contentHashes: [111, 222],
			});
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("never leaks OCR text or window titles into the sanitized digest", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-"));
		try {
			const withSensitiveWindow = segment({
				appIdentity: { processName: "chrome", browserOrigin: "https://example.com" },
				frames: [frame({ id: 1, timestamp: "2026-07-13T14:00:00.000Z", window_name: "top secret memo.docx" })],
				window: { startedAt: "2026-07-13T14:00:00.000Z", endedAt: "2026-07-13T14:00:00.000Z" },
			});

			const derivative = await buildClipDerivative(withSensitiveWindow, { sessionId: "session-1", captureRoot });

			expect(derivative.sanitizedDigest).not.toContain("top secret memo");
			expect(derivative.sanitizedDigest).toBe(
				"chrome activity from 2026-07-13T14:00:00.000Z to 2026-07-13T14:00:00.000Z (https://example.com)",
			);
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("hashes a snapshot file as the keyframe when one is present", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-"));
		try {
			const snapshotPath = path.join(captureRoot, "snapshot.jpg");
			await fs.writeFile(snapshotPath, "fake-jpeg-bytes");
			const withSnapshot = segment({
				frames: [
					frame({
						id: 1,
						timestamp: "2026-07-13T14:00:00.000Z",
						snapshot_path: snapshotPath,
						image_redacted_at: 1_752_415_200,
						image_redaction_version: 3,
					}),
				],
				window: { startedAt: "2026-07-13T14:00:00.000Z", endedAt: "2026-07-13T14:00:00.000Z" },
			});

			const derivative = await buildClipDerivative(withSnapshot, { sessionId: "session-1", captureRoot });

			expect(derivative.keyframeHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(derivative.sanitizationAttestation.sanitizerVersion).toBe(
				"screenpipe-redact;image_redaction_version=3",
			);
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("produces a manifest pointer that is a plain local absolute path", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-"));
		try {
			const derivative = await buildClipDerivative(segment(), { sessionId: "session-1", captureRoot });
			expect(path.isAbsolute(derivative.localManifestPointer)).toBe(true);
			expect(derivative.localManifestPointer.startsWith("file://")).toBe(false);
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});
});
