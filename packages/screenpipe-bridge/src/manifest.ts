import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GopkCapturedDerivative } from "@pk-nerdsaver-ai/pi-activity-journal";
import type { FrameSegment } from "./types";

export interface BuildClipDerivativeOptions {
	readonly sessionId: string;
	readonly captureRoot: string;
}

/**
 * Turns a segment of already-redacted screenpipe frames into a
 * `GopkCapturedDerivative` the activity-journal gopk sink will accept:
 * a manifest listing the frame range (written under `captureRoot`), a
 * cryptographic clip/keyframe hash this bridge computes itself (screenpipe's
 * own `content_hash` is a perceptual dedup hash, not an integrity hash), and
 * an attestation built from screenpipe's redaction watermarks. No raw media
 * is copied or retained here — `rawClip` is intentionally omitted, since
 * screenpipe owns the lifecycle of its own snapshot files.
 */
export async function buildClipDerivative(
	segment: FrameSegment,
	options: BuildClipDerivativeOptions,
): Promise<GopkCapturedDerivative> {
	const first = segment.frames[0];
	const last = segment.frames[segment.frames.length - 1];
	if (!first || !last) throw new Error("segment must contain at least one frame");

	const clipId = `${segment.deviceName}:${first.id}-${last.id}`;
	const frameIds = segment.frames.map(frame => frame.id);
	const contentHashes = segment.frames
		.map(frame => frame.content_hash)
		.filter((hash): hash is number => hash !== null);

	const clipHash = `sha256:${sha256Hex(
		JSON.stringify({
			deviceName: segment.deviceName,
			frameIds,
			contentHashes,
			window: segment.window,
			appIdentity: segment.appIdentity,
		}),
	)}`;

	const keyframeFrame = segment.frames.find(frame => frame.snapshot_path !== null);
	const keyframeHash = keyframeFrame?.snapshot_path ? await hashLocalFile(keyframeFrame.snapshot_path) : undefined;

	const completedAtMs = Math.max(
		...segment.frames
			.flatMap(frame => [
				frame.full_text_redacted_at,
				frame.accessibility_redacted_at,
				frame.accessibility_tree_redacted_at,
				frame.window_name_redacted_at,
				frame.browser_url_redacted_at,
				frame.text_json_redacted_at,
				frame.image_redacted_at,
			])
			.filter((value): value is number => value !== null),
		Date.parse(last.timestamp) / 1000,
	);

	const imageRedactionVersion = segment.frames.find(
		frame => frame.image_redaction_version !== null,
	)?.image_redaction_version;

	const manifestDir = path.join(path.resolve(options.captureRoot), "manifests");
	await fs.mkdir(manifestDir, { recursive: true });
	const manifestPath = path.join(manifestDir, `${sanitizeFileNameSegment(clipId)}.manifest.json`);
	await fs.writeFile(
		manifestPath,
		JSON.stringify(
			{
				clipId,
				deviceName: segment.deviceName,
				appIdentity: segment.appIdentity,
				window: segment.window,
				frameIds,
				contentHashes,
			},
			null,
			2,
		),
	);

	return {
		clipId,
		sessionId: options.sessionId,
		window: segment.window,
		appIdentity: segment.appIdentity,
		sanitizedDigest: buildSanitizedDigest(segment),
		sanitizationAttestation: {
			status: "sanitized",
			completedAt: new Date(completedAtMs * 1000).toISOString(),
			sanitizerVersion: `screenpipe-redact;image_redaction_version=${imageRedactionVersion ?? "n/a"}`,
		},
		clipHash,
		...(keyframeHash ? { keyframeHash } : {}),
		localManifestPointer: manifestPath,
	};
}

/** Built only from app/browser-origin identity, never window titles or OCR text, even though those are redacted too. */
function buildSanitizedDigest(segment: FrameSegment): string {
	const { processName, browserOrigin } = segment.appIdentity;
	const suffix = browserOrigin ? ` (${browserOrigin})` : "";
	return `${processName} activity from ${segment.window.startedAt} to ${segment.window.endedAt}${suffix}`;
}

function sanitizeFileNameSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function hashLocalFile(filePath: string): Promise<string | undefined> {
	try {
		const bytes = await fs.readFile(filePath);
		return `sha256:${sha256Hex(bytes)}`;
	} catch {
		return undefined;
	}
}

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}
