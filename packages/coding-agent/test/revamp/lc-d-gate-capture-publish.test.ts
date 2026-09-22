import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@pk-nerdsaver-ai/pi-natives";
import { OperationalStore } from "../../src/operational/store";
import { OperationalTrajectoryRecorder } from "../../src/operational/trajectory-recorder";
import { parseLaunchAuthorityRefV1 } from "../../src/task/launch-contract";
import { captureLifecycleArtifacts, mintCleanupPermit } from "../../src/task/lifecycle-capture";
import { publishLifecycleCandidate } from "../../src/task/lifecycle-publisher";
import { captureBaseline, captureDeltaPatch } from "../../src/task/worktree";
import {
	createTestCompiledContract,
	createTestMutationContract,
	createTestRunLimits,
	createTestSnapshotRef,
} from "../helpers/lifecycle-fixtures";

const LIMITS = Object.freeze({
	...createTestRunLimits(),
	maxNodes: 4,
	maxDepth: 2,
	maxAttemptsPerNode: 2,
	maxOutstanding: 4,
	maxActiveCompute: 2,
	maxRequests: 10,
	maxRuntimeMs: 60_000,
	maxComputeRuntimeMs: 30_000,
	maxTokens: null,
	maxCostMicrounits: null,
	currency: null,
	maxHandoffBytes: 16_384,
	maxInboxEvents: 20,
});

function runGit(cwd: string, args: string[]): void {
	const proc = Bun.spawnSync(["git", "-c", "user.email=dgate@example.com", "-c", "user.name=DGate", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
	}
}

describe("D-gate real Git capture and publication", () => {
	it("captures a real worktree delta under a named binding then publishes it with store-backed effects", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "dgate-"));
		const targetRoot = path.join(base, "target");
		const isolationDir = path.join(base, "isolation");
		const artifactRoot = path.join(base, "artifacts");
		const dbPath = path.join(os.tmpdir(), `dgate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
		await fs.mkdir(targetRoot, { recursive: true });
		await fs.mkdir(artifactRoot, { recursive: true });
		runGit(targetRoot, ["init", "-q"]);
		runGit(targetRoot, ["config", "core.autocrlf", "false"]);
		const filePath = path.join(targetRoot, "file.txt");
		await fs.writeFile(filePath, "original content\n", "utf8");
		runGit(targetRoot, ["add", "."]);
		runGit(targetRoot, ["commit", "-q", "-m", "init"]);

		runGit(base, ["clone", "-q", targetRoot, isolationDir]);
		const baseline = await captureBaseline(isolationDir);
		await fs.writeFile(path.join(isolationDir, "file.txt"), "published from capture\n", "utf8");
		const delta = await captureDeltaPatch(isolationDir, baseline);
		expect(delta.rootPatch.length).toBeGreaterThan(0);

		const attemptId = "att-dgate-1";
		const launchAuthority = parseLaunchAuthorityRefV1({
			bindingId: `binding-contract-1-1-${attemptId}`,
			principalId: "child-principal-dgate",
			attemptId,
			contractId: "contract-dgate",
			contractRevision: 1,
			contractDigest: "b".repeat(64),
			policyEpoch: 1,
		});
		const permit = mintCleanupPermit({
			attemptId,
			workspaceRoot: path.dirname(isolationDir),
			artifactRoot,
			deadlineMs: 60_000,
		});
		const capture = await captureLifecycleArtifacts({
			runId: "run-dgate",
			nodeId: "node-dgate",
			attemptId,
			launchAuthority,
			baseline,
			isolation: {
				mergedDir: isolationDir,
				backend: natives.IsoBackendKind.Rcopy,
				fellBack: false,
				fallbackReason: null,
			},
			result: {
				index: 0,
				id: "dgate-agent",
				agent: "task",
				agentSource: "bundled",
				task: "capture then publish",
				exitCode: 0,
				output: "raw executor output",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			},
			artifactRoot,
			permit: permit.permit,
			delta,
		});
		permit.dispose();
		expect(capture.ok).toBe(true);
		if (!capture.ok) return;
		expect(capture.manifest.launchAuthority.bindingId).toBe(launchAuthority.bindingId);
		expect(capture.manifest.launchAuthority.attemptId).toBe(attemptId);
		expect(capture.manifest.rootPatchRef).not.toBeNull();
		expect(capture.rootPatchPath).toBeTruthy();

		const store = OperationalStore.open({ dbPath });
		try {
			const compiled = createTestCompiledContract({ objective: "D-gate" }, { limits: LIMITS });
			const runId = `run-dgate-${Date.now()}`;
			const created = store.createLifecycleRun(runId, compiled, LIMITS, `${runId}-key-root`);
			expect(created.ok).toBe(true);
			const child = store.admitLifecycleAttempt({
				runId,
				ownerNodeId: `${runId}-root`,
				nodeId: "node-dgate",
				idempotencyKey: `${runId}-key-pub`,
				compiled,
				expectedPlanVersion: 1,
				expectedCancellationGeneration: 0,
				reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
				prerequisiteIds: [],
			});
			expect(child.ok).toBe(true);
			if (!child.ok) return;

			const recorder = new OperationalTrajectoryRecorder({
				store,
				sessionId: "sess-dgate",
				jobId: child.launch.binding.attemptId,
				launchAuthority,
			});
			recorder.recordOutcome({ status: "ok" });
			const events = store.listEvents({ kind: "outcome", jobId: child.launch.binding.attemptId });
			expect(events.length).toBeGreaterThan(0);
			const stamped = events[0]?.payload as { launchAuthority?: { bindingId: string } };
			expect(stamped.launchAuthority?.bindingId).toBe(launchAuthority.bindingId);

			const receipt = await publishLifecycleCandidate({
				runId,
				attemptId: child.launch.binding.attemptId,
				manifest: capture.manifestRef,
				expectedCandidate: createTestSnapshotRef("c".repeat(64), "snapshot://dgate"),
				target: "user-workspace",
				mutation: { ...createTestMutationContract(), approvalRef: "dgate-approval" },
				approvalRef: "dgate-approval",
				idempotencyKey: `pub-dgate-${Date.now()}`,
				store,
				publisherOwner: "dgate-test",
				repositories: [
					{
						targetId: "root",
						repoRoot: targetRoot,
						patchUri: capture.rootPatchPath!,
					},
				],
			});
			expect(receipt.state).toBe("integrated");
			expect(receipt.changesApplied).toBe(true);
			expect(await fs.readFile(filePath, "utf8")).toBe("published from capture\n");
			const row = store.getPublication(receipt.publicationId);
			expect(row?.state).toBe("integrated");
		} finally {
			store.close();
			Bun.gc(true);
			try {
				await fs.rm(dbPath, { force: true });
			} catch {
				// Windows may retain the SQLite handle briefly; the assertion above is the contract.
			}
			await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
		}
	}, 30_000);

	it("retains the isolation workspace when capture fails closed", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "dgate-fail-"));
		const isolationDir = path.join(base, "isolation-missing");
		const artifactRoot = path.join(base, "artifacts");
		await fs.mkdir(artifactRoot, { recursive: true });
		const attemptId = "att-dgate-fail";
		const launchAuthority = parseLaunchAuthorityRefV1({
			bindingId: `binding-contract-1-1-${attemptId}`,
			principalId: "child-principal-dgate",
			attemptId,
			contractId: "contract-dgate",
			contractRevision: 1,
			contractDigest: "b".repeat(64),
			policyEpoch: 1,
		});
		const result = await captureLifecycleArtifacts({
			runId: "run-dgate-fail",
			nodeId: "node-dgate",
			attemptId,
			launchAuthority,
			baseline: {
				root: {
					repoRoot: isolationDir,
					headCommit: "0".repeat(40),
					staged: "",
					unstaged: "",
					untracked: [],
					untrackedPatch: "",
				},
				nested: [],
			},
			isolation: {
				mergedDir: isolationDir,
				backend: natives.IsoBackendKind.Rcopy,
				fellBack: false,
				fallbackReason: null,
			},
			result: {
				index: 0,
				id: "dgate-fail",
				agent: "task",
				agentSource: "bundled",
				task: "fail capture",
				exitCode: 1,
				output: "",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			},
			artifactRoot,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.retainedWorkspace).toBe(path.dirname(isolationDir));
		expect(result.code).toBe("capture-failed");
		await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
	}, 30_000);

	it("captures and publishes a nested git repository patch independently of the root", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "dgate-nested-"));
		const targetRoot = path.join(base, "target");
		const nestedTarget = path.join(targetRoot, "vendor", "pkg");
		const isolationDir = path.join(base, "isolation");
		const isolationNested = path.join(isolationDir, "vendor", "pkg");
		const artifactRoot = path.join(base, "artifacts");
		const dbPath = path.join(os.tmpdir(), `dgate-nested-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
		await fs.mkdir(nestedTarget, { recursive: true });
		await fs.mkdir(artifactRoot, { recursive: true });
		runGit(targetRoot, ["init", "-q"]);
		runGit(targetRoot, ["config", "core.autocrlf", "false"]);
		await fs.writeFile(path.join(targetRoot, "file.txt"), "root original\n", "utf8");
		runGit(targetRoot, ["add", "."]);
		runGit(targetRoot, ["commit", "-q", "-m", "root init"]);
		runGit(nestedTarget, ["init", "-q"]);
		runGit(nestedTarget, ["config", "core.autocrlf", "false"]);
		await fs.writeFile(path.join(nestedTarget, "nested.txt"), "nested original\n", "utf8");
		runGit(nestedTarget, ["add", "."]);
		runGit(nestedTarget, ["commit", "-q", "-m", "nested init"]);

		runGit(base, ["clone", "-q", targetRoot, isolationDir]);
		await fs.mkdir(path.dirname(isolationNested), { recursive: true });
		runGit(base, ["clone", "-q", nestedTarget, isolationNested]);

		const baseline = await captureBaseline(isolationDir);
		expect(baseline.nested.map(entry => entry.relativePath.split(path.sep).join("/"))).toContain("vendor/pkg");
		await fs.writeFile(path.join(isolationDir, "file.txt"), "root published\n", "utf8");
		await fs.writeFile(path.join(isolationNested, "nested.txt"), "nested published\n", "utf8");
		const delta = await captureDeltaPatch(isolationDir, baseline);
		expect(delta.rootPatch.length).toBeGreaterThan(0);
		expect(delta.nestedPatches.length).toBeGreaterThan(0);

		const attemptId = "att-dgate-nested";
		const launchAuthority = parseLaunchAuthorityRefV1({
			bindingId: `binding-contract-1-1-${attemptId}`,
			principalId: "child-principal-dgate",
			attemptId,
			contractId: "contract-dgate",
			contractRevision: 1,
			contractDigest: "b".repeat(64),
			policyEpoch: 1,
		});
		const permit = mintCleanupPermit({
			attemptId,
			workspaceRoot: path.dirname(isolationDir),
			artifactRoot,
			deadlineMs: 60_000,
		});
		const capture = await captureLifecycleArtifacts({
			runId: "run-dgate-nested",
			nodeId: "node-dgate",
			attemptId,
			launchAuthority,
			baseline,
			isolation: {
				mergedDir: isolationDir,
				backend: natives.IsoBackendKind.Rcopy,
				fellBack: false,
				fallbackReason: null,
			},
			result: {
				index: 0,
				id: "dgate-nested",
				agent: "task",
				agentSource: "bundled",
				task: "nested capture",
				exitCode: 0,
				output: "raw",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			},
			artifactRoot,
			permit: permit.permit,
			delta,
		});
		permit.dispose();
		expect(capture.ok).toBe(true);
		if (!capture.ok) return;
		expect(capture.manifest.nestedPatchRefs.length).toBeGreaterThan(0);
		expect(capture.manifest.launchAuthority.bindingId).toBe(launchAuthority.bindingId);
		const nestedPatchUri = capture.manifest.nestedPatchRefs[0]?.uri;
		expect(nestedPatchUri).toBeTruthy();

		const store = OperationalStore.open({ dbPath });
		try {
			const compiled = createTestCompiledContract({ objective: "D-gate nested" }, { limits: LIMITS });
			const runId = `run-dgate-nested-${Date.now()}`;
			const created = store.createLifecycleRun(runId, compiled, LIMITS, `${runId}-key-root`);
			expect(created.ok).toBe(true);
			const child = store.admitLifecycleAttempt({
				runId,
				ownerNodeId: `${runId}-root`,
				nodeId: "node-dgate",
				idempotencyKey: `${runId}-key-nested`,
				compiled,
				expectedPlanVersion: 1,
				expectedCancellationGeneration: 0,
				reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
				prerequisiteIds: [],
			});
			expect(child.ok).toBe(true);
			if (!child.ok) return;
			const receipt = await publishLifecycleCandidate({
				runId,
				attemptId: child.launch.binding.attemptId,
				manifest: capture.manifestRef,
				expectedCandidate: createTestSnapshotRef("c".repeat(64), "snapshot://dgate-nested"),
				target: "user-workspace",
				mutation: { ...createTestMutationContract(), approvalRef: "dgate-nested-approval" },
				approvalRef: "dgate-nested-approval",
				idempotencyKey: `pub-dgate-nested-${Date.now()}`,
				store,
				publisherOwner: "dgate-test",
				repositories: [
					{ targetId: "root", repoRoot: targetRoot, patchUri: capture.rootPatchPath! },
					{ targetId: "vendor/pkg", repoRoot: nestedTarget, patchUri: nestedPatchUri! },
				],
			});
			expect(receipt.state).toBe("integrated");
			expect(receipt.changesApplied).toBe(true);
			expect(receipt.mutatedRepositories).toEqual(["root", "vendor/pkg"]);
			expect(await fs.readFile(path.join(targetRoot, "file.txt"), "utf8")).toBe("root published\n");
			expect(await fs.readFile(path.join(nestedTarget, "nested.txt"), "utf8")).toBe("nested published\n");
		} finally {
			store.close();
			Bun.gc(true);
			try {
				await fs.rm(dbPath, { force: true });
			} catch {
				// Windows may retain the SQLite handle briefly.
			}
			await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
		}
	}, 30_000);
});
