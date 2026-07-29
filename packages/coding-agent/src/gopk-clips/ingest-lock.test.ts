import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { claimIngestPidLock, ingestPidFilePath, readAliveIngestPid } from "./ingest-lock";

// The lock is the arbiter that keeps the activity ledger single-writer, so
// these tests exercise the claim contract against real files: exclusive
// create wins, a live holder repels claimants, and a dead holder's stale
// file is recovered instead of blocking restarts forever.

/** A pid guaranteed dead: a real process we ran to completion. */
function deadPid(): number {
	const result = childProcess.spawnSync(process.execPath, ["--version"], { stdio: "ignore" });
	if (result.pid === undefined || result.pid <= 0) throw new Error("failed to obtain a dead pid");
	return result.pid;
}

describe("gopk-clips ingest pid lock", () => {
	let captureRoot: string;
	let pidPath: string;

	beforeEach(async () => {
		captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gopk-lock-"));
		pidPath = ingestPidFilePath(captureRoot);
	});

	afterEach(async () => {
		await fs.rm(captureRoot, { recursive: true, force: true });
	});

	it("claims an uncontested lock and reads the holder back", async () => {
		expect(claimIngestPidLock(pidPath, process.pid)).toBe(true);
		expect(readAliveIngestPid(pidPath)).toBe(process.pid);
	});

	it("refuses a claim while a live holder exists, keeping the holder intact", async () => {
		expect(claimIngestPidLock(pidPath, process.pid)).toBe(true);
		expect(claimIngestPidLock(pidPath, 4242)).toBe(false);
		expect(readAliveIngestPid(pidPath)).toBe(process.pid);
	});

	it("recovers a stale lock left by a dead process", async () => {
		await fs.writeFile(pidPath, String(deadPid()), "utf8");
		expect(claimIngestPidLock(pidPath, process.pid)).toBe(true);
		expect(readAliveIngestPid(pidPath)).toBe(process.pid);
	});

	it("treats missing and garbage lock files as no holder", async () => {
		expect(readAliveIngestPid(pidPath)).toBeUndefined();
		await fs.writeFile(pidPath, "not-a-pid", "utf8");
		expect(readAliveIngestPid(pidPath)).toBeUndefined();
		await fs.writeFile(pidPath, "-5", "utf8");
		expect(readAliveIngestPid(pidPath)).toBeUndefined();
	});
});
