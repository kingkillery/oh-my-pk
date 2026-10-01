import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { createLspWritethrough, type FileDiagnosticsResult } from "@pk-nerdsaver-ai/pi-coding-agent/lsp";
import * as lspClient from "@pk-nerdsaver-ai/pi-coding-agent/lsp/client";
import * as lspConfig from "@pk-nerdsaver-ai/pi-coding-agent/lsp/config";
import type { LspClient, ServerConfig } from "@pk-nerdsaver-ai/pi-coding-agent/lsp/types";
import { type ptree, TempDir } from "@pk-nerdsaver-ai/pi-utils";
import type { BunFile } from "bun";

const TEST_SERVER: ServerConfig = {
	command: "test-lsp",
	fileTypes: ["ts"],
	rootMarkers: [],
};

function createClient(cwd: string, config: ServerConfig): LspClient {
	return {
		name: "test-lsp",
		cwd,
		config,
		proc: {} as ptree.ChildProcess<"pipe">,
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(),
		isReading: false,
		status: "ready",
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	};
}

/** Deferred handle stub that records what `finalize` was called with. */
function trackingHandle(finalized: Array<FileDiagnosticsResult | undefined>) {
	return {
		onDeferredDiagnostics: () => {},
		signal: new AbortController().signal,
		finalize: (diagnostics: FileDiagnosticsResult | undefined) => {
			finalized.push(diagnostics);
		},
	};
}

describe("LSP writethrough deferred handle release", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-lsp-deferred-finalize-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	// Contract: the per-file deferred handle is released on EVERY exit path. The
	// regression: `bundle.finalize()` used to sit after a bare
	// `await runLspWritethrough(...)` outside any try/finally, so any rejection
	// escaping the writethrough skipped the release. That left the handle's
	// AbortController neither aborted nor registered for later cleanup, so the
	// background diagnostics fetch ran uncancellable and could inject
	// stale-content diagnostics for a write that never landed.
	//
	// The rejection comes from the write failing inside the operation rather than
	// from the 5s budget expiring, so `timedOut` stays false and no deferred fetch
	// is armed. That keeps the run fast and leaves no 25s `AbortSignal.timeout`
	// holding the process open after the assertion.
	it("finalizes the deferred handle when the write rejects", async () => {
		const filePath = path.join(tempDir.path(), "example.ts");
		const client = createClient(tempDir.path(), TEST_SERVER);

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		// The content sync succeeds, so control reaches the write and the 5s budget
		// is never exhausted.
		vi.spyOn(lspClient, "syncContent").mockResolvedValue(undefined);

		// `getWritePromise` memoizes this rejection, so it surfaces from the write
		// step, is re-read by the catch block, and propagates out of the
		// writethrough — the exact path that used to escape `finalize`.
		const writeFailure = new Error("simulated write failure");
		const failingFile = {
			write: () => Promise.reject(writeFailure),
		} as unknown as BunFile;

		const finalized: Array<FileDiagnosticsResult | undefined> = [];
		const handle = trackingHandle(finalized);

		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: false, enableDiagnostics: true });
		await expect(
			writethrough(filePath, "export const value = 1;\n", undefined, failingFile, undefined, () => handle),
		).rejects.toThrow("simulated write failure");

		// The failure must not be swallowed, and the handle must still be released
		// exactly once, with no diagnostics because the sync never landed.
		expect(finalized).toHaveLength(1);
		expect(finalized[0]).toBeUndefined();
	});

	// Contract: the non-throwing path is unchanged — finalize still receives the
	// diagnostics exactly once.
	it("finalizes the deferred handle exactly once on the success path", async () => {
		const filePath = path.join(tempDir.path(), "clean.ts");

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([]);

		const finalized: Array<FileDiagnosticsResult | undefined> = [];
		const handle = trackingHandle(finalized);

		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: false, enableDiagnostics: true });
		const result = await writethrough(
			filePath,
			"export const clean = true;\n",
			undefined,
			undefined,
			undefined,
			() => handle,
		);

		// No servers configured ⇒ the writethrough degrades to a plain write.
		expect(result).toBeUndefined();
		expect(finalized).toHaveLength(1);
		expect(finalized[0]).toBeUndefined();
		expect(await Bun.file(filePath).text()).toBe("export const clean = true;\n");
	});
});
