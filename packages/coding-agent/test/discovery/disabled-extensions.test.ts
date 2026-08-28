import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/context-file";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@pk-nerdsaver-ai/pi-coding-agent/discovery";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@pk-nerdsaver-ai/pi-utils";

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

describe("disabledExtensions runtime filtering", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;
	let originalUserProfile: string | undefined;

	// Restore this spy individually rather than via `vi.restoreAllMocks()`.
	// That call IS `mock.restore()` (same native function), and the global
	// restore walks Bun's mock registry to unpatch the sealed `os` namespace,
	// segfaulting this shared-process bucket (exit 132) once a later file
	// imports an overlapping module graph.
	let homedirSpy: { mockRestore: () => void } | undefined;
	beforeEach(async () => {
		resetSettingsForTest();
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-disabled-ext-home-"));
		process.env.HOME = tempHomeDir;
		process.env.USERPROFILE = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		setAgentDir(path.join(tempHomeDir, ".omp", "agent"));
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-disabled-ext-"));
		await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
		await fs.mkdir(path.join(tempDir, ".ompk"), { recursive: true });
		await fs.writeFile(path.join(tempDir, ".ompk", "AGENTS.md"), "# project instructions\n");
	});

	afterEach(async () => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("OMP_PROFILE", originalOmpProfileEnv);
		restoreEnvValue("PI_PROFILE", originalPiProfileEnv);
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
		restoreEnvValue("USERPROFILE", originalUserProfile);
		__resetDirsFromEnvForTests();
		await removeWithRetries(tempHomeDir);
		await removeWithRetries(tempDir);
	});

	async function initSettings(disabledExtensions: string[], cwd = tempDir): Promise<void> {
		const settings = await Settings.init({ inMemory: true, cwd, overrides: { disabledExtensions } });
		initializeWithSettings(settings);
	}

	test("hides disabled context files from runtime loads by default", async () => {
		await initSettings([PROJECT_CONTEXT_ID]);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });

		expect(result.items).toHaveLength(0);
	});

	test("can include disabled context files for dashboard-style loads", async () => {
		await initSettings([PROJECT_CONTEXT_ID]);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, {
			cwd: tempDir,
			includeDisabled: true,
		});

		expect(result.items).toHaveLength(1);
		expect(path.basename(result.items[0]!.path)).toBe("AGENTS.md");
		expect(result.items[0]!._source.extensionId).toBe(PROJECT_CONTEXT_ID);
	});

	test("honors legacy basename ids so existing configs keep filtering", async () => {
		await initSettings(["context-file:project:AGENTS.md"]);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });

		expect(result.items).toHaveLength(0);
	});

	test("disabling one context file leaves same-named files at other paths alone", async () => {
		const nestedDir = path.join(tempDir, "packages", "app");
		await fs.mkdir(nestedDir, { recursive: true });
		await fs.writeFile(path.join(nestedDir, "AGENTS.md"), "# nested instructions\n");
		await initSettings([PROJECT_CONTEXT_ID], nestedDir);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: nestedDir });

		expect(result.items.map(file => file.path)).toEqual([path.join(nestedDir, "AGENTS.md")]);
	});

	test("stops filtering once the settings instance is discarded", async () => {
		await initSettings([PROJECT_CONTEXT_ID]);
		expect((await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir })).items).toHaveLength(0);

		resetSettingsForTest();

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });

		expect(result.items).toHaveLength(1);
	});
});
