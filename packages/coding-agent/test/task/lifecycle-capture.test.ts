import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@pk-nerdsaver-ai/pi-natives";
import { captureLifecycleArtifacts } from "../../src/task/lifecycle-capture";
import type { SingleResult } from "../../src/task/types";
import type { WorktreeBaseline } from "../../src/task/worktree";

function makeBaseline(): WorktreeBaseline {
	return {
		root: {
			repoRoot: "/nonexistent",
			headCommit: "abc123",
			staged: "",
			unstaged: "",
			untracked: [],
			untrackedPatch: "",
		},
		nested: [],
	};
}

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "agent-1",
		agent: "test-agent",
		agentSource: "bundled",
		task: "verify capture",
		exitCode: 0,
		output: "hello output",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

describe("Lifecycle artifact capture", () => {
	it("returns capture-failed rather than throwing when the workspace is missing", async () => {
		const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "lifecycle-art-"));
		const baseline = makeBaseline();
		const manifest = await captureLifecycleArtifacts({
			runId: "run-1",
			nodeId: "node-1",
			attemptId: "att-1",
			contractVersion: 1,
			baseline,
			isolation: {
				mergedDir: path.join(os.tmpdir(), `missing-${Date.now()}`),
				backend: natives.IsoBackendKind.Rcopy,
				fellBack: false,
				fallbackReason: null,
			},
			result: makeResult(),
			artifactRoot,
		});
		expect(manifest.outcome).toBe("capture-failed");
		expect(manifest.manifestHash).toHaveLength(64);
	});

	it("marks cancelled outcome for aborted results without throwing", async () => {
		const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "lifecycle-art-"));
		const baseline = makeBaseline();
		const manifest = await captureLifecycleArtifacts({
			runId: "run-1",
			nodeId: "node-1",
			attemptId: "att-2",
			contractVersion: 1,
			baseline,
			isolation: {
				mergedDir: path.join(os.tmpdir(), `missing-${Date.now()}`),
				backend: natives.IsoBackendKind.Rcopy,
				fellBack: false,
				fallbackReason: null,
			},
			result: makeResult({ aborted: true, exitCode: 1 }),
			artifactRoot,
		});
		expect(["cancelled", "capture-failed"]).toContain(manifest.outcome);
	});
});
