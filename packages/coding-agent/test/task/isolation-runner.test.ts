import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	applyEligibleNestedPatches,
	mergeIsolatedChanges,
} from "@pk-nerdsaver-ai/pi-coding-agent/task/isolation-runner";
import type { SingleResult } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";
import * as worktreeModule from "@pk-nerdsaver-ai/pi-coding-agent/task/worktree";

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "NestedOnly",
		agent: "task",
		agentSource: "bundled",
		task: "Do nested work",
		assignment: "Do nested work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

describe("mergeIsolatedChanges", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("allows nested-only branch-mode patches to apply when no root branch was created", async () => {
		const mergeSpy = vi.spyOn(worktreeModule, "mergeTaskBranches");
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		});

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
		expect(outcome.mergedBranchForNestedPatches).toBe(true);
		expect(outcome.summary).toContain("nested repository patches captured");
	});

	it("does not mark failed branch-mode runs as nested-patch eligible", async () => {
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				exitCode: 1,
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.mergedBranchForNestedPatches).toBe(false);
	});
	it("surfaces partial patch artifact in patch mode when run was aborted or failed", async () => {
		const res = result({ aborted: true, patchPath: "/tmp/x.partial.patch" });
		const outcome = await mergeIsolatedChanges({ result: res, repoRoot: "/tmp/repo", mergeMode: "patch" });
		expect(outcome.changesApplied).toBe(false);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.summary).toContain("must be handled manually");
		expect(outcome.summary).toContain("/tmp/x.partial.patch");
	});

	it("surfaces partial patch artifact in branch mode when run did not complete", async () => {
		const res = result({ aborted: true, patchPath: "/tmp/y.partial.patch" });
		const outcome = await mergeIsolatedChanges({ result: res, repoRoot: "/tmp/repo", mergeMode: "branch" });
		expect(outcome.changesApplied).toBe(false);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.summary).toContain("did not complete");
		expect(outcome.summary).toContain("/tmp/y.partial.patch");
	});

	it("returns no changes to apply when run aborted without a partial patch artifact", async () => {
		const res = result({ aborted: true });
		const patchOutcome = await mergeIsolatedChanges({ result: res, repoRoot: "/tmp/repo", mergeMode: "patch" });
		expect(patchOutcome.changesApplied).toBe(true);
		expect(patchOutcome.summary).toContain("No changes to apply");

		const branchOutcome = await mergeIsolatedChanges({ result: res, repoRoot: "/tmp/repo", mergeMode: "branch" });
		expect(branchOutcome.changesApplied).toBe(true);
		expect(branchOutcome.summary).toContain("No changes to apply");
	});
});

describe("applyEligibleNestedPatches", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const nestedPatch = { relativePath: "nested", patch: "diff --git a/file b/file\n" };

	it("skips when patch-mode parent merge failed", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches");
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: false,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("skips when branch mode did not actually merge the root branch", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches");
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "branch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("applies nested patches and returns no warning on success", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue([]);
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).toHaveBeenCalledTimes(1);
	});

	it("returns a system-notification suffix on apply failure", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockRejectedValue(new Error("boom"));
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "branch",
			changesApplied: true,
			mergedBranchForNestedPatches: true,
		});
		expect(suffix).toContain("Some nested repository patches failed to apply");
	});

	it("surfaces stash-restore warnings from applyNestedPatches as a system-notification", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue([
			"Pre-existing dirty state in nested repo `nested` could not be auto-restored after the agent commit; stash entry preserved (conflict).",
		]);
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toContain("could not be auto-restored");
		expect(suffix).toContain("stash entry preserved");
		expect(suffix).toContain("<system-notification>");
	});
});

describe("runIsolatedSubprocess lifecycle capture", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("records capture on branch merge failure and skips cleanup when capture fails", async () => {
		const { runIsolatedSubprocess } = await import("@pk-nerdsaver-ai/pi-coding-agent/task/isolation-runner");
		const captureModule = await import("../../src/task/lifecycle-capture");
		const executorModule = await import("../../src/task/executor");
		const { parseLaunchAuthorityRefV1 } = await import("../../src/task/launch-contract");

		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/tmp/iso-merged",
			backend: 0 as never,
			fellBack: false,
			fallbackReason: null,
		});
		const cleanup = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue(undefined);
		vi.spyOn(worktreeModule, "commitToBranch").mockRejectedValue(new Error("commit refused"));
		const gitModule = await import("../../src/utils/git");
		vi.spyOn(gitModule.branch, "tryDelete").mockResolvedValue(true);
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(
			result({ exitCode: 0, error: undefined, aborted: false }),
		);
		vi.spyOn(captureModule, "captureLifecycleArtifacts").mockResolvedValue({
			ok: false,
			code: "capture-failed",
			attemptId: "att-merge",
			retainedWorkspace: "/tmp/iso-merged",
			failures: [{ stage: "manifest", message: "forced" }],
		} as never);

		const launchAuthority = parseLaunchAuthorityRefV1({
			bindingId: "binding-contract-1-1-att-merge",
			principalId: "child-principal-1",
			attemptId: "att-merge",
			contractId: "contract-1",
			contractRevision: 1,
			contractDigest: "f".repeat(64),
			policyEpoch: 1,
		});

		const isolated = await runIsolatedSubprocess({
			baseOptions: { cwd: "/tmp", agent: { name: "task" } } as never,
			context: {
				repoRoot: "/tmp/repo",
				baseline: {
					root: {
						repoRoot: "/tmp/repo",
						headCommit: "abc",
						staged: "",
						unstaged: "",
						untracked: [],
						untrackedPatch: "",
					},
					nested: [],
				},
			},
			preferredBackend: undefined,
			agentId: "NestedOnly",
			mergeMode: "branch",
			artifactsDir: "/tmp/arts",
			buildFailureResult: err => result({ error: String(err), exitCode: 1 }),
			lifecycle: {
				runId: "run-1",
				nodeId: "node-1",
				attemptId: "att-merge",
				launchAuthority,
			},
		});

		expect(isolated.error).toContain("Merge failed");
		expect(captureModule.captureLifecycleArtifacts).toHaveBeenCalled();
		expect(cleanup).not.toHaveBeenCalled();
	});

	it("derives capture identity from baseOptions.lifecycle when opts.lifecycle is omitted", async () => {
		const { runIsolatedSubprocess } = await import("@pk-nerdsaver-ai/pi-coding-agent/task/isolation-runner");
		const captureModule = await import("../../src/task/lifecycle-capture");
		const executorModule = await import("../../src/task/executor");
		const { parseLaunchAuthorityRefV1 } = await import("../../src/task/launch-contract");
		const { registerLifecycleExecutionContext } = await import("../../src/orchestration/lifecycle-authority");

		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/tmp/iso-derived",
			backend: 0 as never,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue(undefined);
		vi.spyOn(worktreeModule, "commitToBranch").mockResolvedValue({
			branchName: "omp/task/Derived",
			nestedPatches: [],
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(
			result({ exitCode: 0, error: undefined, aborted: false }),
		);
		const capture = vi.spyOn(captureModule, "captureLifecycleArtifacts").mockResolvedValue({
			ok: true,
			manifest: { launchAuthority: { bindingId: "binding-contract-1-1-att-derived" } },
			manifestRef: { uri: "file://manifest" },
			manifestPath: "/tmp/arts/att-derived.manifest.json",
			manifestRefPath: "/tmp/arts/att-derived.manifest-ref.json",
			rootPatchPath: "/tmp/arts/att-derived.patch",
			delta: { rootPatch: "diff", nestedPatches: [] },
		} as never);

		const launchAuthority = parseLaunchAuthorityRefV1({
			bindingId: "binding-contract-1-1-att-derived",
			principalId: "child-principal-1",
			attemptId: "att-derived",
			contractId: "contract-1",
			contractRevision: 1,
			contractDigest: "f".repeat(64),
			policyEpoch: 1,
		});
		const lifecycle = registerLifecycleExecutionContext({
			mode: "direct-v1",
			role: "worker",
			runId: "run-derived",
			nodeId: "node-derived",
			attemptId: "att-derived",
			policyEpoch: 1,
			authority: launchAuthority,
			usableCapabilities: [],
			repoRoot: "/tmp/repo",
			readableRoots: ["/tmp/repo"],
			writableRoots: ["/tmp/repo"],
			allowExternalWrite: false,
		});

		await runIsolatedSubprocess({
			baseOptions: { cwd: "/tmp", agent: { name: "task" }, lifecycle } as never,
			context: {
				repoRoot: "/tmp/repo",
				baseline: {
					root: {
						repoRoot: "/tmp/repo",
						headCommit: "abc",
						staged: "",
						unstaged: "",
						untracked: [],
						untrackedPatch: "",
					},
					nested: [],
				},
			},
			preferredBackend: undefined,
			agentId: "Derived",
			mergeMode: "branch",
			artifactsDir: "/tmp/arts",
			buildFailureResult: err => result({ error: String(err), exitCode: 1 }),
		});

		expect(capture).toHaveBeenCalled();
		const input = capture.mock.calls[0]?.[0] as { attemptId?: string; launchAuthority?: { bindingId: string } };
		expect(input.attemptId).toBe("att-derived");
		expect(input.launchAuthority?.bindingId).toBe(launchAuthority.bindingId);
	});

	it("retains a bound workspace when the subprocess rejects before capture", async () => {
		const { runIsolatedSubprocess } = await import("@pk-nerdsaver-ai/pi-coding-agent/task/isolation-runner");
		const executorModule = await import("../../src/task/executor");
		const { parseLaunchAuthorityRefV1 } = await import("../../src/task/launch-contract");
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/tmp/iso-throw",
			backend: 0 as never,
			fellBack: false,
			fallbackReason: null,
		});
		const cleanup = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue(undefined);
		vi.spyOn(executorModule, "runSubprocess").mockRejectedValue(new Error("pinned provider unavailable"));
		const launchAuthority = parseLaunchAuthorityRefV1({
			bindingId: "binding-contract-1-1-att-throw",
			principalId: "child-principal-1",
			attemptId: "att-throw",
			contractId: "contract-1",
			contractRevision: 1,
			contractDigest: "f".repeat(64),
			policyEpoch: 1,
		});
		const failed = await runIsolatedSubprocess({
			baseOptions: { cwd: "/tmp", agent: { name: "task" } } as never,
			context: {
				repoRoot: "/tmp/repo",
				baseline: {
					root: {
						repoRoot: "/tmp/repo",
						headCommit: "abc",
						staged: "",
						unstaged: "",
						untracked: [],
						untrackedPatch: "",
					},
					nested: [],
				},
			},
			preferredBackend: undefined,
			agentId: "Throwing",
			mergeMode: "patch",
			artifactsDir: "/tmp/arts",
			buildFailureResult: err => result({ error: String(err), exitCode: 1 }),
			lifecycle: { runId: "run-throw", nodeId: "node-throw", attemptId: "att-throw", launchAuthority },
		});
		expect(failed.error).toContain("pinned provider unavailable");
		expect(cleanup).not.toHaveBeenCalled();
	});
});
