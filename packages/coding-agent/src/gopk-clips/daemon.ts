/**
 * Always-on Activity Memory ingest daemon.
 *
 * This is the fix for the "See my day is empty" defect: historically the only
 * thing that turned the sampler's handoff JSON into the activity ledger was
 * {@link createGopkClipsHost} built inside an `AgentSession` and torn down in
 * its `dispose()`. So unless a coding-agent session happened to be open with
 * `gopkClips.enabled`, the sampler wrote handoffs forever and the ledger — and
 * therefore the report and recall — stayed permanently empty.
 *
 * This daemon runs that same host (poll handoffs -> sanitizing ingest ->
 * retention purge) as a standalone, lifecycle-independent process, reusing
 * `createGopkClipsHost` wholesale rather than duplicating the logic.
 *
 * It is now the ONLY ingester. The agent-session host was removed: two
 * consumers raced to unlink the same handoff files and contended for the
 * ledger's write lock. Sessions read the ledger (see ./read.ts and the
 * `activity` tool); they never drain the queue. Do not reintroduce a second
 * caller of `createGopkClipsHost`.
 *
 * Enabled CLI sessions ensure this detached singleton is running. Sessions
 * never ingest directly; the daemon remains the sole ledger writer.
 *
 * Single instance per ledger via an `ingest.pid` lock next to the capture
 * root; graceful shutdown on SIGINT/SIGTERM. Paths come from the shared
 * gopk-clips config.json when present, else the agent-dir default.
 *
 * Usage: bun packages/coding-agent/src/gopk-clips/daemon.ts [--stop] [--once]
 *   --stop  terminate a running daemon via its pid file
 *   --once  run a single poll+cleanup pass and exit (smoke test)
 */
import * as fs from "node:fs";
// Subpath import keeps the compiled gopk-ingest.exe free of the pi_natives
// native addon (which the pi-utils barrel eagerly loads). See session-state.ts.
import * as logger from "@pk-nerdsaver-ai/pi-utils/logger";
import { claimIngestPidLock, ingestPidFilePath, readAliveIngestPid } from "./ingest-lock";
import { resolveGopkClipsPaths, resolveSharedGopkClipsCapturePolicy } from "./paths";
import { createGopkClipsHost, type GopkClipsHostState } from "./session-state";

const POLL_INTERVAL_MS = 15_000;
const CLEANUP_INTERVAL_MS = 600_000;

export async function runIngestDaemon(argv: string[] = process.argv.slice(2)): Promise<void> {
	const stop = argv.includes("--stop");
	const once = argv.includes("--once");
	// Absolute and `~`-expanded, so the pid lock below can never land somewhere
	// other than the capture root the host itself resolves.
	const { captureRoot, ledgerPath } = resolveGopkClipsPaths();
	fs.mkdirSync(captureRoot, { recursive: true });
	const pidPath = ingestPidFilePath(captureRoot);

	if (stop) {
		const running = readAliveIngestPid(pidPath);
		if (running === undefined) {
			logger.info("ingest daemon: not running");
			return;
		}
		process.kill(running, "SIGTERM");
		logger.info("ingest daemon: stopped", { pid: running });
		return;
	}

	if (!claimIngestPidLock(pidPath, process.pid)) {
		logger.info("ingest daemon: already running; exiting", { pid: readAliveIngestPid(pidPath) });
		return;
	}
	const cleanupPid = (): void => {
		try {
			if (fs.readFileSync(pidPath, "utf8").trim() === String(process.pid)) fs.unlinkSync(pidPath);
		} catch {
			// Already gone or owned by another process.
		}
	};

	let host: GopkClipsHostState;
	try {
		host = createGopkClipsHost({
			captureRoot,
			ledgerPath,
			capturePolicyProvider: resolveSharedGopkClipsCapturePolicy,
			pollIntervalMs: POLL_INTERVAL_MS,
			cleanupIntervalMs: CLEANUP_INTERVAL_MS,
		});
	} catch (error) {
		cleanupPid();
		logger.warn("ingest daemon: failed to start", { error: String(error) });
		process.exitCode = 1;
		return;
	}

	if (once) {
		try {
			await host.pollOnce();
			await host.cleanupOnce();
		} finally {
			try {
				await host.dispose();
			} finally {
				cleanupPid();
			}
		}
		logger.info("ingest daemon: single pass complete");
		return;
	}
	let shuttingDown = false;
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		void host.dispose().finally(() => {
			cleanupPid();
			process.exit(0);
		});
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	process.on("exit", cleanupPid);

	logger.info("ingest daemon: running", { captureRoot, ledgerPath, pollIntervalMs: POLL_INTERVAL_MS });
	// Keep the event loop alive; the host's own timers drive the work.
	await Promise.withResolvers<void>().promise;
}

// Floating call instead of top-level await, as in cli.ts: TLA makes `--bytecode`
// builds fail. The catch reproduces an unhandled TLA rejection (dump, exit 1).
if (import.meta.main) {
	runIngestDaemon().catch((err: unknown) => {
		process.stderr.write(`${Bun.inspect(err, { colors: process.stderr.isTTY === true })}\n`);
		process.exit(1);
	});
}
