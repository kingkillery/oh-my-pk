import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestPidFilePath } from "./ingest-lock";

describe("ingest daemon CLI re-entry", () => {
	let root: string;
	let captureRoot: string;
	let environment: Record<string, string | undefined>;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "ompk-ingest-cli-"));
		captureRoot = join(root, "capture");
		const configRoot = join(root, "config");
		await mkdir(join(configRoot, "gopk-clips"), { recursive: true });
		await Bun.write(
			join(configRoot, "gopk-clips", "config.json"),
			JSON.stringify({ captureRoot, ledgerPath: join(root, "ledger.sqlite"), enabled: false }),
		);
		environment = {
			...process.env,
			LOCALAPPDATA: configRoot,
			XDG_CONFIG_HOME: configRoot,
			PI_CODING_AGENT_DIR: join(root, "agent"),
			OMP_PROFILE: undefined,
			PI_PROFILE: undefined,
		};
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});
	async function runOnce() {
		const child = Bun.spawn(
			[process.execPath, join(import.meta.dir, "..", "cli.ts"), "__omp_gopk_ingest", "--once"],
			{
				env: environment,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { exitCode, diagnostics: exitCode === 0 ? "" : stdout + stderr };
	}
	it("dispatches before normal commands and releases its lock after a single pass", async () => {
		expect(await runOnce()).toEqual({ exitCode: 0, diagnostics: "" });
		expect(await Bun.file(ingestPidFilePath(captureRoot)).exists()).toBe(false);
		expect(await Bun.file(join(root, "ledger.sqlite")).exists()).toBe(true);
	});
	it("does not open another ledger writer while a live PID holds the lock", async () => {
		await mkdir(captureRoot, { recursive: true });
		await Bun.write(ingestPidFilePath(captureRoot), String(process.pid));
		expect(await runOnce()).toEqual({ exitCode: 0, diagnostics: "" });
		expect(await Bun.file(ingestPidFilePath(captureRoot)).text()).toBe(String(process.pid));
		expect(await Bun.file(join(root, "ledger.sqlite")).exists()).toBe(false);
	}, 20_000);
});
