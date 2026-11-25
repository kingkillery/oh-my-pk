import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "../src/cli/args";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { buildSessionOptions } from "../src/main";
import { AuthStorage } from "../src/session/auth-storage";

describe("--main / --subagent wet|dry", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dry-mode-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage?.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("parses wet and dry for each side and leaves both unset by default", () => {
		expect(parseArgs(["--main", "dry", "--subagent", "wet"])).toMatchObject({ dryMain: true, drySubagent: false });
		expect(parseArgs(["--subagent", "dry"])).toMatchObject({ drySubagent: true });
		const none = parseArgs([]);
		expect(none.dryMain).toBeUndefined();
		expect(none.drySubagent).toBeUndefined();
	});

	it("starts the main session stripped when dryMode.main is on", async () => {
		const parsed = parseArgs(["--cwd", tempDir]);
		const { options } = await buildSessionOptions(
			parsed,
			[],
			undefined,
			new ModelRegistry(authStorage),
			Settings.isolated({ "dryMode.main": true }),
		);

		expect(options.dryMode).toBe(true);
		expect(options.enableMCP).toBe(false);
		expect(options.skills).toEqual([]);
		expect(options.preloadedCustomToolPaths).toEqual([]);
		expect(options.disableExtensionDiscovery).toBe(true);
	});

	it("leaves the main session untouched by default", async () => {
		const parsed = parseArgs(["--cwd", tempDir]);
		const { options } = await buildSessionOptions(
			parsed,
			[],
			undefined,
			new ModelRegistry(authStorage),
			Settings.isolated(),
		);

		expect(options.dryMode).toBeUndefined();
		expect(options.enableMCP).toBeUndefined();
		expect(options.skills).toBeUndefined();
		expect(options.disableExtensionDiscovery).toBeUndefined();
	});
});
