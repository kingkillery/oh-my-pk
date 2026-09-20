/**
 * Verifies the release-install contract: after `install.ps1`/`install.sh`
 * drop `ompk-collector(.exe)` next to the omp binary, local collector mode
 * discovers it via the sibling-of-execPath rule without any settings.
 *
 * The test never touches the real bun install directory — it points
 * `process.execPath` at a temp "install dir" holding a fake helper.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCollectorBinary } from "../../src/autoqa/collector-control";

describe("release layout discovery", () => {
	it("finds the helper as a sibling of the running omp binary", () => {
		const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "ompk-install-"));
		const exeName = process.platform === "win32" ? "omp.exe" : "omp";
		const helperName = process.platform === "win32" ? "ompk-collector.exe" : "ompk-collector";
		const fakeExe = path.join(installDir, exeName);
		const fakeHelper = path.join(installDir, helperName);
		fs.writeFileSync(fakeExe, "");
		fs.writeFileSync(fakeHelper, "");

		const originalExecPath = process.execPath;
		Object.defineProperty(process, "execPath", { value: fakeExe, configurable: true });
		try {
			const found = findCollectorBinary();
			expect(found).toBe(fakeHelper);
		} finally {
			Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
			fs.rmSync(installDir, { recursive: true, force: true });
		}
	});
});
