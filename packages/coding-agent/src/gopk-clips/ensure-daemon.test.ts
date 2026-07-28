import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as env from "@pk-nerdsaver-ai/pi-utils/env";
import * as workerHost from "@pk-nerdsaver-ai/pi-utils/worker-host";
import { ensureIngestDaemonRunning, GOPK_INGEST_CLI_ARG } from "./ensure-daemon";
import { ingestPidFilePath } from "./ingest-lock";

// The launcher's contract: probe the pid lock, spawn exactly when nothing
// alive holds it, refuse to spawn when the current process cannot re-enter
// the CLI, and degrade to a logged failure instead of ever throwing into
// session startup.

const quiet = { warn() {}, info() {} };

describe("ensureIngestDaemonRunning", () => {
	let captureRoot: string;
	let paths: { captureRoot: string; ledgerPath: string };
	let spawned: (readonly string[])[];
	const recordSpawn = (command: readonly string[]): number => {
		spawned.push(command);
		return 4242;
	};

	beforeEach(async () => {
		captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gopk-ensure-"));
		paths = { captureRoot, ledgerPath: path.join(captureRoot, "ledger.sqlite") };
		spawned = [];
	});

	afterEach(async () => {
		await fs.rm(captureRoot, { recursive: true, force: true });
	});

	it("reports an already-running daemon without spawning", async () => {
		await fs.writeFile(ingestPidFilePath(captureRoot), String(process.pid), "utf8");
		const result = ensureIngestDaemonRunning({ paths, logger: quiet, spawnDaemon: recordSpawn });
		expect(result).toEqual({ status: "already-running", pid: process.pid });
		expect(spawned).toEqual([]);
	});

	it("spawns the daemon command when no live daemon holds the lock", async () => {
		const command = ["fake-omp", GOPK_INGEST_CLI_ARG];
		const result = ensureIngestDaemonRunning({
			paths,
			logger: quiet,
			daemonCommand: command,
			spawnDaemon: recordSpawn,
		});
		expect(result).toEqual({ status: "spawned", pid: 4242 });
		expect(spawned).toEqual([command]);
	});

	it("treats a stale lock from a dead pid as absent and spawns", async () => {
		const dead = childProcess.spawnSync(process.execPath, ["--version"], { stdio: "ignore" }).pid;
		await fs.writeFile(ingestPidFilePath(captureRoot), String(dead), "utf8");
		const result = ensureIngestDaemonRunning({
			paths,
			logger: quiet,
			daemonCommand: ["fake-omp", GOPK_INGEST_CLI_ARG],
			spawnDaemon: recordSpawn,
		});
		expect(result.status).toBe("spawned");
		expect(spawned).toHaveLength(1);
	});

	it("reports unavailable outside the CLI host instead of spawning a stray process", () => {
		// SDK embedding / bun test: not a compiled binary and no worker-host
		// entry — re-invoking Bun.main would launch the embedder's app with a
		// stray selector argument, so the launcher must refuse.
		const compiledSpy = spyOn(env, "isCompiledBinary").mockReturnValue(false);
		const entrySpy = spyOn(workerHost, "workerHostEntry").mockReturnValue(null);
		try {
			const result = ensureIngestDaemonRunning({ paths, logger: quiet, spawnDaemon: recordSpawn });
			expect(result).toEqual({ status: "unavailable" });
			expect(spawned).toEqual([]);
		} finally {
			compiledSpy.mockRestore();
			entrySpy.mockRestore();
		}
	});

	it("degrades a spawn failure to a logged warning, never a throw", () => {
		const warnings: string[] = [];
		const logger = { info() {}, warn: (message: string) => void warnings.push(message) };
		const result = ensureIngestDaemonRunning({
			paths,
			logger,
			daemonCommand: ["fake-omp", GOPK_INGEST_CLI_ARG],
			spawnDaemon: () => {
				throw new Error("spawn exploded");
			},
		});
		expect(result).toEqual({ status: "failed" });
		expect(warnings).toHaveLength(1);
	});
});
