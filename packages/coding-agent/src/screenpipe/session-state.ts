/**
 * Runtime host for the screenpipe activity bridge: assembles the local
 * activity ledger, the gopk sink, and the screenpipe client into a
 * {@link ScreenpipeBridgeRunner}, then starts polling. Everything stays on
 * this machine — the ledger is a local SQLite file under the agent dir, the
 * consent record is device-scoped with remote storage off, and the bridge
 * only ever reads already-redacted frame metadata from the local daemon.
 *
 * Built once per session when `screenpipe.enabled` is on (see
 * `AgentSession`); torn down in the session's `dispose()`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createGopkActivitySink,
	type GopkClipIngestionPolicy,
	SqliteActivityLedger,
} from "@pk-nerdsaver-ai/pi-activity-journal";
import type { ConsentRecord } from "@pk-nerdsaver-ai/pi-context-policy";
import {
	createFileCursorStore,
	ScreenpipeBridge,
	ScreenpipeBridgeRunner,
	ScreenpipeClient,
} from "@pk-nerdsaver-ai/pi-screenpipe-bridge";
import { getAgentDir, getInstallId, logger } from "@pk-nerdsaver-ai/pi-utils";

/**
 * Applications whose windows must never become activity evidence, even in
 * redacted-metadata form. Matched against screenpipe's lowercased process
 * name by the gopk ingestion policy.
 */
const DENIED_APPLICATION_IDS: readonly string[] = [
	"1password",
	"bitwarden",
	"dashlane",
	"keepassxc",
	"keeper",
	"lastpass",
	"protonpass",
];

/** How long a rejected clip's raw pointer may linger before retention purges it. */
const MAXIMUM_RAW_CLIP_RETENTION_MS = 10 * 60_000;

export interface ScreenpipeSessionConfig {
	readonly sessionId: string;
	readonly baseUrl: string;
	readonly pollIntervalMs: number;
	/** When set, keyframe hashes are recorded for snapshots contained in it. */
	readonly mediaRoot?: string;
}

export interface ScreenpipeSessionState {
	/** Stops the poll loop (awaiting any in-flight poll) and closes the ledger. */
	dispose(): Promise<void>;
}

/**
 * Build the bridge stack and start polling. Throws when the capture
 * directory or ledger cannot be created — callers gate session startup on
 * that never propagating (see the try/catch at the construction site).
 */
export function createScreenpipeSessionState(config: ScreenpipeSessionConfig): ScreenpipeSessionState {
	const installId = getInstallId();
	const captureRoot = path.join(getAgentDir(), "screenpipe");
	fs.mkdirSync(captureRoot, { recursive: true });

	const consent: ConsentRecord = {
		userId: installId,
		deviceId: installId,
		identityVerified: true,
		enabled: true,
		scope: "device",
		remoteStorageEnabled: false,
		policyVersion: "context-retention/v1",
	};
	const policy: GopkClipIngestionPolicy = {
		enabled: true,
		allowedApplicationIds: [],
		deniedApplicationIds: [...DENIED_APPLICATION_IDS],
		maximumRawClipRetentionMs: MAXIMUM_RAW_CLIP_RETENTION_MS,
	};

	const ledger = new SqliteActivityLedger(path.join(captureRoot, "activity-ledger.sqlite"));
	let runner: ScreenpipeBridgeRunner;
	try {
		const sink = createGopkActivitySink({
			ledger,
			consent,
			policy,
			capture: { userId: installId, deviceId: installId, sessionId: config.sessionId },
			captureRoot,
			logger,
		});
		const bridge = new ScreenpipeBridge({
			frameSource: new ScreenpipeClient({ baseUrl: config.baseUrl, logger }),
			sink,
			cursorStore: createFileCursorStore(captureRoot),
			sessionId: config.sessionId,
			captureRoot,
			...(config.mediaRoot ? { mediaRoot: config.mediaRoot } : {}),
		});
		runner = new ScreenpipeBridgeRunner({ bridge, pollIntervalMs: config.pollIntervalMs, logger });
	} catch (error) {
		ledger.close();
		throw error;
	}
	runner.start();
	logger.info("screenpipe bridge started", {
		sessionId: config.sessionId,
		baseUrl: config.baseUrl,
		pollIntervalMs: config.pollIntervalMs,
		captureRoot,
		keyframeHashing: config.mediaRoot !== undefined,
	});

	let disposed: Promise<void> | undefined;
	return {
		dispose(): Promise<void> {
			disposed ??= runner.stop().finally(() => {
				ledger.close();
			});
			return disposed;
		},
	};
}
