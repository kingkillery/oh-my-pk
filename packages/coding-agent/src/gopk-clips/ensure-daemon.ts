/**
 * Session-side launcher for the always-on `gopk-ingest` daemon.
 *
 * Sessions never ingest — the daemon is the single consumer of the handoff
 * queue and single writer of the ledger (see ./daemon.ts) — but a daemon
 * nobody starts drains nothing, and removing the in-session ingester also
 * removed the accidental "a session was open, so ingestion happened"
 * fallback. This restores that guarantee deliberately: a session with
 * `gopkClips.enabled` probes the daemon's pid lock and, when nothing alive
 * holds it, spawns the daemon as a detached process that outlives the
 * session. The daemon's own atomic lock claim (./ingest-lock.ts) collapses
 * concurrent ensures from parallel sessions to one survivor.
 *
 * The daemon process is the current CLI re-entered with the hidden
 * `__omp_gopk_ingest` selector (dispatched in cli.ts before command
 * loading), mirroring the worker-host pattern: compiled binaries re-invoke
 * themselves, bun-script runs re-invoke `bun <cli entry>`. Outside the real
 * CLI host (`bun test`, SDK embedding) there is no entry that understands
 * the selector, so we report `unavailable` instead of spawning the host
 * application with a stray argument.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
// Subpath imports: keep this module native-free like the rest of gopk-clips.
import { isCompiledBinary } from "@pk-nerdsaver-ai/pi-utils/env";
import * as logger from "@pk-nerdsaver-ai/pi-utils/logger";
import { workerHostEntry } from "@pk-nerdsaver-ai/pi-utils/worker-host";
import { ingestPidFilePath, readAliveIngestPid } from "./ingest-lock";
import { type GopkClipsPathOverrides, resolveGopkClipsPaths } from "./paths";
import type { GopkClipsHostLogger } from "./session-state";

/** Hidden CLI selector; must match the literal dispatched in cli.ts. */
export const GOPK_INGEST_CLI_ARG = "__omp_gopk_ingest";

export interface EnsureIngestDaemonOptions {
	/** Path overrides, resolved through the shared gopk-clips resolver. */
	readonly paths?: GopkClipsPathOverrides;
	readonly logger?: GopkClipsHostLogger;
	/** Full daemon argv override for tests; defaults to the CLI re-entry command. */
	readonly daemonCommand?: readonly string[];
	/** Spawn override for tests; returns the child pid when known. */
	readonly spawnDaemon?: (command: readonly string[]) => number | undefined;
}

export type EnsureIngestDaemonResult =
	| { readonly status: "already-running"; readonly pid: number }
	| { readonly status: "spawned"; readonly pid?: number }
	/** Not the CLI host and no override — nothing here can re-enter the daemon. */
	| { readonly status: "unavailable" }
	| { readonly status: "failed" };

/**
 * Make sure a `gopk-ingest` daemon exists, spawning one detached when the pid
 * lock shows none alive. Fire-and-forget safe: never throws, and a failure
 * only means the ledger stops growing until the daemon is started manually —
 * exactly the pre-existing behavior this launcher removes in the common case.
 */
export function ensureIngestDaemonRunning(options: EnsureIngestDaemonOptions = {}): EnsureIngestDaemonResult {
	const log = options.logger ?? logger;
	try {
		const { captureRoot } = resolveGopkClipsPaths(options.paths);
		fs.mkdirSync(captureRoot, { recursive: true });
		const alive = readAliveIngestPid(ingestPidFilePath(captureRoot));
		if (alive !== undefined) return { status: "already-running", pid: alive };

		const command = options.daemonCommand ?? resolveDaemonCommand();
		if (command === undefined) {
			log.info("gopk-clips: no CLI entry to re-enter; start gopk-ingest manually");
			return { status: "unavailable" };
		}
		const pid = (options.spawnDaemon ?? spawnDetached)(command);
		log.info("gopk-clips: started ingest daemon", pid === undefined ? {} : { pid });
		return pid === undefined ? { status: "spawned" } : { status: "spawned", pid };
	} catch (error) {
		log.warn("gopk-clips: failed to start ingest daemon", { error: String(error) });
		return { status: "failed" };
	}
}

/**
 * Argv that re-enters this CLI as the daemon, or undefined when the current
 * process is not the CLI host. Mirrors the worker spawn contract from
 * AGENTS.md: compiled binary → itself; bun script → `bun <entry>`.
 */
function resolveDaemonCommand(): readonly string[] | undefined {
	if (isCompiledBinary()) return [process.execPath, GOPK_INGEST_CLI_ARG];
	const hostEntry = workerHostEntry();
	if (!hostEntry) return undefined;
	return [process.execPath, hostEntry, GOPK_INGEST_CLI_ARG];
}

function spawnDetached(command: readonly string[]): number | undefined {
	const [exe, ...args] = command;
	if (!exe) throw new Error("empty ingest daemon command");
	const child = childProcess.spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true });
	child.unref();
	return child.pid;
}
