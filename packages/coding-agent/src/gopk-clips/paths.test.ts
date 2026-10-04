import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSharedGopkClipsCapturePolicy, sharedConfigPath } from "./paths";

const originalLocalAppData = process.env.LOCALAPPDATA;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
let root = "";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gopk-shared-policy-"));
	// sharedConfigPath() reads LOCALAPPDATA on Windows and XDG_CONFIG_HOME elsewhere.
	process.env.LOCALAPPDATA = root;
	process.env.XDG_CONFIG_HOME = root;
});

afterEach(async () => {
	restoreEnv("LOCALAPPDATA", originalLocalAppData);
	restoreEnv("XDG_CONFIG_HOME", originalXdgConfigHome);
	await fs.rm(root, { recursive: true, force: true });
});

async function persistConfig(value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(sharedConfigPath()), { recursive: true });
	await fs.writeFile(sharedConfigPath(), JSON.stringify(value), "utf8");
}

describe("shared gopk capture policy", () => {
	it("writes only inside the per-test config root", () => {
		expect(sharedConfigPath().startsWith(root + path.sep)).toBe(true);
	});

	it("fails closed when config or current consent is missing", async () => {
		expect(resolveSharedGopkClipsCapturePolicy()).toEqual({ enabled: false, ocrEnabled: false });
		await persistConfig({
			enabled: true,
			ocrEnabled: true,
			consent: {
				acceptedAt: "2026-07-29T00:00:00.000Z",
				policyVersion: "context-retention/v1",
				framesOptIn: true,
				ocrOptIn: true,
			},
		});
		expect(resolveSharedGopkClipsCapturePolicy()).toEqual({ enabled: false, ocrEnabled: false });
	});

	it("enables OCR only when capture, frames, current consent, and OCR opt-in all agree", async () => {
		const consent = {
			acceptedAt: "2026-07-29T00:00:00.000Z",
			policyVersion: "context-retention/v2",
			framesOptIn: true,
			ocrOptIn: true,
		};
		await persistConfig({ enabled: true, ocrEnabled: true, consent });
		expect(resolveSharedGopkClipsCapturePolicy()).toEqual({ enabled: true, ocrEnabled: true });
		await persistConfig({ enabled: true, ocrEnabled: false, consent: { ...consent, ocrOptIn: false } });
		expect(resolveSharedGopkClipsCapturePolicy()).toEqual({ enabled: true, ocrEnabled: false });
	});
});
