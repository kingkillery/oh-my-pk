import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildBinaryDownloadUrl,
	buildBunInstallArgs,
	buildHomebrewUpdateArgs,
	buildMiseForceInstallArgs,
	buildMiseUpgradeArgs,
	replaceBinaryForUpdate,
	resolveInvokedBinaryPathForTest,
	resolveUpdateMethodForTest,
	sweepStaleBackups,
	updateViaBinaryAt,
} from "@pk-nerdsaver-ai/pi-coding-agent/cli/update-cli";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

const tempDirs: string[] = [];
const restoreCallbacks: Array<() => void> = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-test-"));
	tempDirs.push(dir);
	return dir;
}

beforeAll(async () => {
	await initTheme(false);
});

afterEach(async () => {
	for (const restore of restoreCallbacks.splice(0)) restore();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

describe("update-cli install target detection", () => {
	it("targets the compiled alias that launched the update", () => {
		expect(resolveInvokedBinaryPathForTest("C:\\Users\\test\\bin\\ompk.exe", "win32")).toBe(
			"C:\\Users\\test\\bin\\ompk.exe",
		);
		expect(resolveInvokedBinaryPathForTest("/Users/test/.local/bin/omp", "darwin")).toBe(
			"/Users/test/.local/bin/omp",
		);
	});

	it("does not mistake the Bun runtime for a compiled CLI binary", () => {
		expect(resolveInvokedBinaryPathForTest("C:\\Users\\test\\.bun\\bin\\bun.exe", "win32")).toBeUndefined();
		expect(resolveInvokedBinaryPathForTest("/Users/test/.bun/bin/bun", "linux")).toBeUndefined();
	});

	it("resolves a Bun-directory alias to the shared binary before choosing an updater", async () => {
		const dir = await makeTempDir();
		const bunBin = path.join(dir, ".bun", "bin");
		const binary = path.join(dir, "oh-my-pk");
		await fs.mkdir(bunBin, { recursive: true });
		await Bun.write(binary, "release binary");
		const alias = path.join(bunBin, "ompk");
		await fs.symlink(binary, alias);
		const target = resolveInvokedBinaryPathForTest(alias, process.platform);
		expect(target).toBe(await fs.realpath(binary));
		expect(resolveUpdateMethodForTest(target!, bunBin)).toBe("binary");
	});

	it("uses bun update when prioritized omp is inside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.bun/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("keeps standalone binaries installed in Bun's bin directory on the binary channel", () => {
		expect(
			resolveUpdateMethodForTest("/Users/test/.bun/bin/oh-my-pk", "/Users/test/.bun/bin", {
				isCompiledBinary: true,
			}),
		).toBe("binary");
	});

	it("uses binary update when prioritized omp is outside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/omp", undefined);

		expect(method).toBe("binary");
	});

	it("uses Homebrew update when prioritized omp resolves into the Homebrew formula", async () => {
		const dir = await makeTempDir();
		const prefix = path.join(dir, "opt", "omp");
		const linkedBin = path.join(dir, "bin");
		await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
		await fs.mkdir(linkedBin, { recursive: true });
		await Bun.write(path.join(prefix, "bin", "omp"), "binary");
		await fs.symlink(path.join(prefix, "bin", "omp"), path.join(linkedBin, "omp"));

		const method = resolveUpdateMethodForTest(path.join(linkedBin, "omp"), "/Users/test/.bun/bin", {
			homebrewPrefix: prefix,
		});

		expect(method).toBe("brew");
	});

	it("uses mise update when prioritized omp is in an active mise bin path", () => {
		const method = resolveUpdateMethodForTest(
			"/Users/test/.local/share/mise/installs/github-can1357-oh-my-pi/latest/bin/omp",
			undefined,
			{
				miseBinDirs: ["/Users/test/.local/share/mise/installs/github-can1357-oh-my-pi/latest/bin"],
			},
		);

		expect(method).toBe("mise");
	});

	it("uses mise update when prioritized omp is a mise shim", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/share/mise/shims/omp", undefined, {
			miseDataDir: "/Users/test/.local/share/mise",
		});

		expect(method).toBe("mise");
	});
});

describe("update-cli package manager commands", () => {
	it("targets the Homebrew tap formula and switches to reinstall for forced updates", () => {
		expect(buildHomebrewUpdateArgs(false)).toEqual(["upgrade", "kingkillery/tap/omp"]);
		expect(buildHomebrewUpdateArgs(true)).toEqual(["reinstall", "kingkillery/tap/omp"]);
	});

	it("targets the mise GitHub backend tool and force-reinstalls the checked version when requested", () => {
		expect(buildMiseUpgradeArgs()).toEqual(["upgrade", "github:kingkillery/oh-my-pk", "--bump"]);
		expect(buildMiseForceInstallArgs("15.10.5")).toEqual([
			"install",
			"--force",
			"github:kingkillery/oh-my-pk@15.10.5",
		]);
	});

	it("downloads the checked version from official GitHub releases by default", () => {
		expect(buildBinaryDownloadUrl("16.4.28", "omp-darwin-arm64")).toBe(
			"https://github.com/kingkillery/oh-my-pk/releases/download/v16.4.28/omp-darwin-arm64",
		);
	});

	it("preserves an explicitly configured distribution endpoint", () => {
		expect(buildBinaryDownloadUrl("16.4.28", "omp-windows-x64.exe", "https://custom.example")).toBe(
			"https://custom.example/bin/v16.4.28/omp-windows-x64.exe",
		);
	});
});

describe("update-cli bun install command", () => {
	it("pins the official npm registry and bypasses the manifest cache so a stale mirror or snapshot cannot mask a freshly published version", () => {
		// Regression: omp queries https://registry.npmjs.org/<pkg>/latest directly.
		// The install MUST hit the same registry, otherwise:
		//   - a lagging mirror (corp proxy, Taobao, …) rejects the version with
		//     `No version matching "X" (but package exists)`,
		//   - or bun's local manifest snapshot does the same when the user's bun
		//     is already pointed at the official registry but its cache predates
		//     the release.
		// See https://github.com/can1357/oh-my-pi/issues/1686.
		const args = buildBunInstallArgs("15.7.6", "linux-x64");
		expect(args.slice(0, 5)).toEqual([
			"install",
			"-g",
			"--no-cache",
			"--registry=https://registry.npmjs.org/",
			"@pk-nerdsaver-ai/pi-coding-agent@15.7.6",
		]);
	});

	it("pins the native addon core and the platform-specific leaf to the same version so the loader sentinel cannot drift on supported tags", () => {
		// Regression: bun install -g <pkg>@<v> would update only the top-level
		// package, leaving @pk-nerdsaver-ai/pi-natives and @pk-nerdsaver-ai/pi-natives-<tag>
		// at their previous version. The next launch then loaded a stale .node
		// file and aborted at validateLoadedBindings with `The .node file on
		// disk is from a different release than this loader`. See
		// https://github.com/can1357/oh-my-pi/issues/1824.
		for (const tag of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
			const args = buildBunInstallArgs("15.9.0", tag);
			expect(args).toContain("@pk-nerdsaver-ai/pi-natives@15.9.0");
			expect(args).toContain(`@pk-nerdsaver-ai/pi-natives-${tag}@15.9.0`);
		}
	});

	it("omits the leaf on unsupported platform tags so an EBADPLATFORM swap does not mask the underlying `no matching version` error", () => {
		// Defensive: an unsupported tag (e.g. linux-arm32) still installs the
		// core natives package — which will fail at module load if the platform
		// truly is unsupported — but we never request a leaf the release
		// pipeline doesn't publish, otherwise bun aborts with EBADPLATFORM
		// and hides the real diagnostic from `loadNative`'s aggregated error.
		const args = buildBunInstallArgs("15.9.0", "linux-arm");
		expect(args).toContain("@pk-nerdsaver-ai/pi-natives@15.9.0");
		expect(args.some(arg => arg.startsWith("@pk-nerdsaver-ai/pi-natives-"))).toBe(false);
	});
});

describe("update-cli binary replacement", () => {
	it("preserves the shared binary and alias when all download hosts fail", async () => {
		const dir = await makeTempDir();
		const binary = path.join(dir, "oh-my-pk");
		const alias = path.join(dir, "ompk");
		await Bun.write(binary, "working binary");
		await fs.symlink(binary, alias);
		const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
		restoreCallbacks.push(() => fetchSpy.mockRestore());
		await expect(updateViaBinaryAt(alias, "16.4.28")).rejects.toThrow("Download failed for release 16.4.28");
		expect(await Bun.file(alias).text()).toBe("working binary");
		expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
		expect(await fs.readdir(dir)).toEqual(["oh-my-pk", "ompk"]);
	});

	it("updates the shared binary through an alias and pins fallback downloads to the checked version", async () => {
		const dir = await makeTempDir();
		const binary = path.join(dir, "oh-my-pk");
		await Bun.write(binary, "old binary");
		const aliases = [path.join(dir, "ompk"), path.join(dir, "omp")];
		for (const alias of aliases) await fs.symlink(binary, alias);
		const calls: string[] = [];
		const originalFetch = globalThis.fetch;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request) => {
					const url = input instanceof Request ? input.url : String(input);
					calls.push(url);
					return url.includes("github.com")
						? new Response("temporarily unavailable", { status: 503 })
						: new Response("new binary");
				},
				{ preconnect: originalFetch.preconnect },
			),
		);
		restoreCallbacks.push(() => fetchSpy.mockRestore());
		await updateViaBinaryAt(aliases[0], "16.4.28", async expected => {
			expect(expected).toBe("16.4.28");
			return { ok: (await Bun.file(binary).text()) === "new binary", actual: expected, path: binary };
		});
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("/releases/download/v16.4.28/");
		expect(calls[1]).toContain("/bin/v16.4.28/");
		expect(calls.some(url => url.endsWith("/version"))).toBe(false);
		for (const alias of aliases) {
			expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
			expect(await Bun.file(alias).text()).toBe("new binary");
		}
	});

	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous oh-my-pk binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
});

describe("update-cli binary replacement on locked backups", () => {
	it("treats an EPERM on backup cleanup as a successful, completed update", async () => {
		// Regression: on Windows the binary moved aside during the swap is still
		// the running process image, so unlinking it throws EPERM. That cleanup
		// failure must not turn a verified swap into "Update failed" (issue #845).
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp.exe");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.1700000000000.4242.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		const realUnlink = nodeFs.promises.unlink.bind(nodeFs.promises);
		const spy = spyOn(nodeFs.promises, "unlink").mockImplementation(async (p: nodeFs.PathLike) => {
			if (String(p) === backupPath) {
				const err = new Error(`EPERM: operation not permitted, unlink '${p}'`) as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			return realUnlink(p);
		});
		try {
			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(result.ok).toBe(true);
		} finally {
			spy.mockRestore();
		}

		// New binary is installed and the temp consumed even though the locked
		// backup survives; the next run's sweep reclaims it once it is unlocked.
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).text()).toBe("old binary");
	});
});

describe("update-cli stale backup sweep", () => {
	it("reclaims timestamped and legacy backups while leaving unrelated .bak files", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp.exe");
		await Bun.write(targetPath, "current binary");
		await Bun.write(`${targetPath}.bak`, "legacy backup");
		await Bun.write(`${targetPath}.1700000000000.4242.bak`, "timestamped backup");
		await Bun.write(`${targetPath}.1800000000000.99.bak`, "another backup");
		// Must survive: foreign basename and a non-numeric middle segment.
		await Bun.write(path.join(dir, "notes.bak"), "keep me");
		await Bun.write(`${targetPath}.config.bak`, "keep me too");

		await sweepStaleBackups(targetPath);

		expect(await Bun.file(targetPath).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1800000000000.99.bak`).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "notes.bak")).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.bak`).exists()).toBe(true);
	});
});
