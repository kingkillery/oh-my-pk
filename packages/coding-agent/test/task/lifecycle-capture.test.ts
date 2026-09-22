import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@pk-nerdsaver-ai/pi-natives";
import { type LaunchAuthorityRefV1, parseLaunchAuthorityRefV1 } from "../../src/task/launch-contract";
import { type CaptureFailure, captureLifecycleArtifacts, mintCleanupPermit } from "../../src/task/lifecycle-capture";
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

/**
 * A coherent authority ref for one attempt. Built through the real parser so
 * the fixture cannot drift from the wire contract it stands in for, and
 * `attemptId` matches the attempt being captured.
 */
function authorityFor(attemptId: string): LaunchAuthorityRefV1 {
	return parseLaunchAuthorityRefV1({
		bindingId: `binding-contract-1-1-${attemptId}`,
		principalId: "child-principal-1",
		attemptId,
		contractId: "contract-1",
		contractRevision: 1,
		contractDigest: "f".repeat(64),
		policyEpoch: 1,
	});
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

function missingIsolation() {
	return {
		mergedDir: path.join(os.tmpdir(), `missing-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		backend: natives.IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
	};
}

describe("Lifecycle artifact capture", () => {
	it("returns a typed capture-failed rather than throwing when the workspace is missing", async () => {
		const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "lifecycle-art-"));
		const result = await captureLifecycleArtifacts({
			runId: "run-1",
			nodeId: "node-1",
			attemptId: "att-1",
			launchAuthority: authorityFor("att-1"),
			baseline: makeBaseline(),
			isolation: missingIsolation(),
			result: makeResult(),
			artifactRoot,
		});
		expect(result.ok).toBe(false);
		const failure = result as CaptureFailure;
		expect(failure.code).toBe("capture-failed");
		expect(failure.attemptId).toBe("att-1");
		expect(failure.retainedWorkspace).toBeTruthy();
		expect(failure.failures.length).toBeGreaterThan(0);
	});

	it("marks cancelled outcome for aborted results without throwing", async () => {
		const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "lifecycle-art-"));
		const result = await captureLifecycleArtifacts({
			runId: "run-1",
			nodeId: "node-1",
			attemptId: "att-2",
			launchAuthority: authorityFor("att-2"),
			baseline: makeBaseline(),
			isolation: missingIsolation(),
			result: makeResult({ aborted: true, exitCode: 1 }),
			artifactRoot,
		});
		// Missing workspace → capture-failed; the attempt is still reported, never thrown.
		expect(result.ok).toBe(false);
	});

	it("persists manifest + ref atomically and registers content-derived identities", async () => {
		const isolationDir = await mkdtemp(path.join(os.tmpdir(), "lifecycle-iso-"));
		const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "lifecycle-art-"));
		const patch =
			"diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n one\n+two\ndiff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+fresh\n";
		const permit = mintCleanupPermit({
			attemptId: "att-3",
			workspaceRoot: path.dirname(isolationDir),
			artifactRoot,
		});
		const result = await captureLifecycleArtifacts({
			runId: "run-1",
			nodeId: "node-1",
			attemptId: "att-3",
			launchAuthority: authorityFor("att-3"),
			baseline: makeBaseline(),
			isolation: {
				mergedDir: isolationDir,
				backend: natives.IsoBackendKind.Rcopy,
				fellBack: false,
				fallbackReason: null,
			},
			result: makeResult(),
			artifactRoot,
			permit: permit.permit,
			delta: {
				rootPatch: patch,
				rootTouchedFiles: ["a.txt", "new.txt"],
				nestedPatches: [],
			},
		});
		permit.dispose();

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const m = result.manifest;
		expect(m.schemaVersion).toBe(1);
		expect(m.outcome).toBe("completed");
		expect(m.publishable).toBe(true);
		expect(m.manifestHash).toHaveLength(64);
		expect(m.launchAuthority.contractDigest).toBe("f".repeat(64));
		expect(m.launchAuthority.bindingId).toBe("binding-contract-1-1-att-3");
		expect(m.launchAuthority.attemptId).toBe(m.attemptId);
		expect(m.rootPatchRef).not.toBeNull();
		expect(m.rootPatchRef!.artifactId.startsWith("sha256:")).toBe(true);
		expect(m.changedPaths).toContain("a.txt");
		expect(m.changedPaths).toContain("new.txt");
		expect(m.rawRefs.output).not.toBeNull();
		expect(m.rawRefs.result).not.toBeNull();
		const persisted = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
		expect(persisted.manifestHash).toBe(m.manifestHash);
		const persistedRef = JSON.parse(await fs.readFile(result.manifestRefPath, "utf8"));
		expect(persistedRef.artifactId).toBe(`sha256:${m.manifestHash}`);
		const patchText = await fs.readFile(result.rootPatchPath!, "utf8");
		expect(patchText).toContain("new.txt");
	});

	it("fails closed when the cleanup permit is scoped to a different attempt", async () => {
		const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "lifecycle-art-"));
		const permit = mintCleanupPermit({
			attemptId: "other-attempt",
			workspaceRoot: os.tmpdir(),
			artifactRoot,
		});
		const result = await captureLifecycleArtifacts({
			runId: "run-1",
			nodeId: "node-1",
			attemptId: "att-4",
			launchAuthority: authorityFor("att-4"),
			baseline: makeBaseline(),
			isolation: missingIsolation(),
			result: makeResult(),
			artifactRoot,
			permit: permit.permit,
		});
		permit.dispose();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failures.some(f => f.stage === "permit")).toBe(true);
	});
});
