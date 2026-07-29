/**
 * Pid-file lock for the singleton `gopk-ingest` daemon.
 *
 * The daemon holds `<captureRoot>/ingest.pid` for its lifetime; the
 * session-side launcher (./ensure-daemon.ts) probes the same file to decide
 * whether a daemon needs spawning. Extracted from daemon.ts so both sides
 * share one definition of "running" and can never drift on the file name,
 * the liveness probe, or the claim semantics.
 *
 * Subpath-only imports (node builtins): this module bundles into the
 * compiled gopk-ingest.exe, which must stay free of the pi_natives addon.
 * See ./session-state.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** The lock lives next to the handoff queue, under the shared capture root. */
export function ingestPidFilePath(captureRoot: string): string {
	return path.join(captureRoot, "ingest.pid");
}

/**
 * On Windows, confirm the pid belongs to one of our executables — bun.exe in
 * dev, gopk-*.exe for the standalone build, or the omp/ompk/oh-my-pk CLI that
 * re-enters the daemon — so a recycled pid from a stale lock after a reboot
 * is not mistaken for a live daemon and doesn't block restart forever. Image
 * names are matched as whole quoted CSV fields, not substrings: `tasklist`
 * output like `"CompPkgSrv.exe"` must never satisfy a loose `omp` match.
 * On other platforms, pid existence stands.
 */
function isIngestProcess(pid: number): boolean {
	if (process.platform !== "win32") return true;
	try {
		const result = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const image = result.stdout.toString().toLowerCase();
		if (image.includes("gopk")) return true;
		return ['"bun.exe"', '"omp.exe"', '"ompk.exe"', '"oh-my-pk.exe"'].some(name => image.includes(name));
	} catch {
		return true;
	}
}

/** The pid recorded in the lock when that process is still alive AND ours, else undefined. */
export function readAliveIngestPid(pidPath: string): number | undefined {
	let pid: number;
	try {
		pid = Number(fs.readFileSync(pidPath, "utf8").trim());
	} catch {
		return undefined;
	}
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
	} catch {
		return undefined;
	}
	return isIngestProcess(pid) ? pid : undefined;
}

/**
 * Atomically claim the lock for `pid`, or report that a live daemon already
 * holds it. Exclusive create (`wx`) is the arbiter, so two daemons racing
 * through "nobody's running" cannot both proceed — the loser sees EEXIST and
 * bows out. A dead holder (stale file) is recovered once: unlink and retry,
 * where a concurrent claimant may still legitimately win.
 */
export function claimIngestPidLock(pidPath: string, pid: number): boolean {
	if (tryExclusiveWrite(pidPath, pid)) return true;
	if (readAliveIngestPid(pidPath) !== undefined) return false;
	try {
		fs.unlinkSync(pidPath);
	} catch {
		// Already removed by a concurrent claimant; the retry below decides.
	}
	return tryExclusiveWrite(pidPath, pid);
}

function tryExclusiveWrite(pidPath: string, pid: number): boolean {
	try {
		fs.writeFileSync(pidPath, String(pid), { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}
