import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OperationalStore } from "../../src/operational/store";
import { type PublicationInput, publishLifecycleCandidate } from "../../src/task/lifecycle-publisher";
import {
	createTestArtifactRef,
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
	const proc = Bun.spawnSync(["git", "-c", "user.email=pub@example.com", "-c", "user.name=Pub Fixture", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
	}
}

async function makeRepo(base: string, name: string): Promise<{ repoRoot: string; filePath: string }> {
	const repoRoot = path.join(base, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await fs.mkdir(repoRoot, { recursive: true });
	runGit(repoRoot, ["init", "-q"]);
	runGit(repoRoot, ["config", "core.autocrlf", "false"]);
	runGit(repoRoot, ["config", "core.safecrlf", "false"]);
	const filePath = path.join(repoRoot, "file.txt");
	await fs.writeFile(filePath, "original content\n", "utf8");
	runGit(repoRoot, ["add", "."]);
	runGit(repoRoot, ["commit", "-q", "-m", "init"]);
	return { repoRoot, filePath };
}

async function makePatch(repoRoot: string, filePath: string, newContent: string, patchPath: string): Promise<string> {
	await fs.writeFile(filePath, newContent, "utf8");
	const proc = Bun.spawnSync(["git", "diff"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error("git diff failed");
	const patchText = proc.stdout.toString();
	await fs.writeFile(patchPath, patchText, "utf8");
	runGit(repoRoot, ["checkout", "--", "."]);
	return patchText;
}

function gitText(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
	return proc.stdout.toString().trim();
}

function gitRaw(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
	return proc.stdout.toString();
}

function worktreeHash(cwd: string): string {
	const tree = gitText(cwd, ["write-tree"]);
	const unstaged = gitRaw(cwd, ["diff", "--binary"]);
	const staged = gitRaw(cwd, ["diff", "--binary", "--cached"]);
	const status = gitRaw(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
	return createHash("sha256").update(`${tree}\u0000${unstaged}\u0000${staged}\u0000${status}`, "utf8").digest("hex");
}

function journalBeforeImage(
	repo: { readonly targetId: string; readonly repoRoot: string; readonly patchUri: string },
	patchText: string,
) {
	return {
		targetId: repo.targetId,
		patchUri: repo.patchUri,
		patchSha256: createHash("sha256").update(patchText, "utf8").digest("hex"),
		headCommit: gitText(repo.repoRoot, ["rev-parse", "HEAD"]),
		beforeTree: gitText(repo.repoRoot, ["write-tree"]),
		worktreeHash: worktreeHash(repo.repoRoot),
		clean: true,
	};
}

interface Fixture {
	readonly store: OperationalStore;
	readonly attemptId: string;
	readonly runId: string;
}

function makeStoreAndAttempt(dbPath: string, options: { readonly now?: () => number } = {}): Fixture {
	const store = OperationalStore.open({ dbPath, ...options });
	const compiled = createTestCompiledContract({ objective: "Publisher fixture" }, { limits: LIMITS });
	const runId = `run-pub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const created = store.createLifecycleRun(runId, compiled, LIMITS, `${runId}-key-root`);
	if (!created.ok) throw new Error(`run creation failed: ${created.code}`);
	const child = store.admitLifecycleAttempt({
		runId,
		ownerNodeId: `${runId}-root`,
		nodeId: "node-pub",
		idempotencyKey: `${runId}-key-pub`,
		compiled,
		expectedPlanVersion: 1,
		expectedCancellationGeneration: 0,
		reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
		prerequisiteIds: [],
	});
	if (!child.ok) throw new Error(`attempt admission failed: ${child.code}`);
	return { store, attemptId: child.launch.binding.attemptId, runId };
}

function makeInput(fixture: Fixture, overrides: Partial<PublicationInput> = {}): PublicationInput {
	return {
		runId: fixture.runId,
		attemptId: fixture.attemptId,
		manifest: createTestArtifactRef("pub-manifest", "f".repeat(64), "artifact://pub-manifest"),
		expectedCandidate: createTestSnapshotRef("c".repeat(64), "snapshot://candidate"),
		target: "run-candidate",
		mutation: createTestMutationContract(),
		approvalRef: null,
		idempotencyKey: `pub-${Math.random().toString(36).slice(2)}`,
		store: fixture.store,
		publisherOwner: "publisher-test",
		repositories: [],
		...overrides,
	};
}

async function removeWithRetry(target: string): Promise<void> {
	// Diagnosed owner: bun:sqlite releases the store.db handle a few hundred
	// milliseconds after close() on Windows, and node's fs.rm retry options
	// do not cover EBUSY on file deletion. Retry explicitly and fail loudly.
	const deadline = Date.now() + 15_000;
	for (;;) {
		try {
			await fs.rm(target, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if ((code === "EBUSY" || code === "EPERM") && Date.now() < deadline) {
				await new Promise(resolve => setTimeout(resolve, 250));
				continue;
			}
			throw error;
		}
	}
}

async function withTempBase(fn: (base: string, dbPath: () => string) => Promise<void>): Promise<void> {
	const base = path.join(os.tmpdir(), `pubtest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await fs.mkdir(base, { recursive: true });
	const dbPaths: string[] = [];
	try {
		await fn(base, () => {
			// Each store gets its own file outside the repo tree so git/Defender
			// churn during real-effect tests cannot wedge the whole base dir.
			const dbPath = path.join(os.tmpdir(), `pubtest-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
			dbPaths.push(dbPath);
			return dbPath;
		});
	} finally {
		// Inline-prepared statements in the store's publication path are only
		// released on GC; collect them so the DB handle drops deterministically.
		Bun.gc(true);
		// One-shot store files in the OS temp dir follow the same disposal
		// precedent as the scheduler-delivery/admission-contention fixtures:
		// the store is closed (the resource is disposed) and the file itself
		// is offered for removal once. An external scanner can hold a freshly
		// written SQLite file for many seconds; that is reported, not retried
		// into a test failure, and never masks a publication-contract outcome.
		for (const dbPath of dbPaths) {
			try {
				await fs.rm(dbPath, { force: true });
			} catch (error) {
				console.warn(
					`[publisher-test] temp store left for OS cleanup: ${dbPath} (${(error as NodeJS.ErrnoException).code})`,
				);
			}
		}
		await removeWithRetry(base);
	}
}

describe("Lifecycle publisher (A10, §7.2–7.3)", () => {
	it("keeps apply=false candidates pending with no workspace mutation and a durable pending row", async () => {
		await withTempBase(async (base, dbPath) => {
			const { repoRoot, filePath } = await makeRepo(base, "nofx");
			const fixture = makeStoreAndAttempt(dbPath());
			try {
				const before = await fs.readFile(filePath, "utf8");
				const input = makeInput(fixture, {
					mutation: { ...createTestMutationContract(), apply: false },
					repositories: [{ targetId: "root", repoRoot, patchUri: path.join(base, "none.patch") }],
				});
				const receipt = await publishLifecycleCandidate(input);
				expect(receipt.state).toBe("pending");
				expect(receipt.changesApplied).toBe(false);
				expect(receipt.mutatedRepositories).toHaveLength(0);
				expect(await fs.readFile(filePath, "utf8")).toBe(before);

				// A retry must retain candidate-only semantics rather than treating
				// its own `prepared` journal as an ambiguous crashed apply.
				const replay = await publishLifecycleCandidate(input);
				expect(replay.state).toBe("pending");
				expect(replay.publicationId).toBe(receipt.publicationId);
				expect(await fs.readFile(filePath, "utf8")).toBe(before);
				expect(fixture.store.getPublication(receipt.publicationId)?.state).toBe("pending");
			} finally {
				fixture.store.close();
			}
		});
	}, 30_000);

	it("rejects user-workspace publication without exact approval, durably", async () => {
		await withTempBase(async (base, dbPath) => {
			const { filePath } = await makeRepo(base, "appr");
			const fixture = makeStoreAndAttempt(dbPath());
			try {
				const before = await fs.readFile(filePath, "utf8");
				const missing = await publishLifecycleCandidate(
					makeInput(fixture, { target: "user-workspace", repositories: [] }),
				);
				expect(missing.state).toBe("rejected");
				expect(missing.changesApplied).toBe(false);
				expect(fixture.store.getPublication(missing.publicationId)?.state).toBe("rejected");

				const changed = await publishLifecycleCandidate(
					makeInput(fixture, {
						target: "user-workspace",
						approvalRef: "approval-now",
						mutation: { ...createTestMutationContract(), approvalRef: "approval-then" },
						repositories: [],
					}),
				);
				expect(changed.state).toBe("rejected");
				expect(changed.obligationIds.some(id => id.startsWith("approval-changed"))).toBe(true);
				expect(await fs.readFile(filePath, "utf8")).toBe(before);
			} finally {
				fixture.store.close();
			}
		});
	}, 30_000);

	it("integrates an approved user-workspace publication with real Git effects and a durable journal", async () => {
		await withTempBase(async (base, dbPath) => {
			const { repoRoot, filePath } = await makeRepo(base, "ok");
			const patchPath = path.join(base, "root.patch");
			const patchText = await makePatch(repoRoot, filePath, "published content\n", patchPath);
			const fixture = makeStoreAndAttempt(dbPath());
			try {
				const receipt = await publishLifecycleCandidate(
					makeInput(fixture, {
						target: "user-workspace",
						approvalRef: "approval-1",
						mutation: { ...createTestMutationContract(), approvalRef: "approval-1" },
						manifest: createTestArtifactRef(
							"pub-manifest",
							createHash("sha256").update(patchText, "utf8").digest("hex"),
							`file://${patchPath}`,
						),
						repositories: [{ targetId: "root", repoRoot, patchUri: patchPath }],
					}),
				);
				expect(receipt.state).toBe("integrated");
				expect(receipt.changesApplied).toBe(true);
				expect(receipt.mutatedRepositories).toContain("root");
				// The real effect is observable on disk.
				expect(await fs.readFile(filePath, "utf8")).toBe("published content\n");

				const row = fixture.store.getPublication(receipt.publicationId);
				expect(row?.state).toBe("integrated");
				expect(row?.resultingSnapshotHash).toBeTruthy();
				const stages = (row?.stageJournal ?? []) as { stage: string }[];
				expect(stages.map(s => s.stage)).toEqual(["prepared", "applied", "verified"]);

				// Idempotent replay returns the finalized state without reapplying.
				const replay = await publishLifecycleCandidate(
					makeInput(fixture, {
						target: "user-workspace",
						approvalRef: "approval-1",
						mutation: { ...createTestMutationContract(), approvalRef: "approval-1" },
						manifest: createTestArtifactRef(
							"pub-manifest",
							createHash("sha256").update(patchText, "utf8").digest("hex"),
							`file://${patchPath}`,
						),
						repositories: [{ targetId: "root", repoRoot, patchUri: patchPath }],
						idempotencyKey: "replay-same",
					}),
				);
				expect(replay.state).toBe("integrated");
			} finally {
				fixture.store.close();
			}
		});
	}, 30_000);

	it("rejects a dirty nested target before mutating the root", async () => {
		await withTempBase(async (base, dbPath) => {
			const root = await makeRepo(base, "proot");
			const nested = await makeRepo(base, "pnested");
			const rootPatch = path.join(base, "root.patch");
			const nestedPatch = path.join(base, "nested.patch");
			await makePatch(root.repoRoot, root.filePath, "root published\n", rootPatch);
			await makePatch(nested.repoRoot, nested.filePath, "nested published\n", nestedPatch);
			// A human edit before the controller records a clean before-image is
			// an ambiguity, not a chance to apply the root and call it partial.
			await fs.writeFile(nested.filePath, "concurrent nested edit\n", "utf8");
			const fixture = makeStoreAndAttempt(dbPath());
			try {
				const receipt = await publishLifecycleCandidate(
					makeInput(fixture, {
						target: "user-workspace",
						approvalRef: "approval-2",
						mutation: { ...createTestMutationContract(), approvalRef: "approval-2" },
						repositories: [
							{ targetId: "root", repoRoot: root.repoRoot, patchUri: rootPatch },
							{ targetId: "nested", repoRoot: nested.repoRoot, patchUri: nestedPatch },
						],
					}),
				);
				expect(receipt.state).toBe("conflicted");
				expect(receipt.changesApplied).toBe(false);
				expect(receipt.mutatedRepositories).toEqual([]);
				expect(receipt.recoveryRefs.some(ref => ref.includes("nested"))).toBe(true);
				expect(await fs.readFile(root.filePath, "utf8")).toBe("original content\n");
				expect(await fs.readFile(nested.filePath, "utf8")).toBe("concurrent nested edit\n");
				expect(fixture.store.getPublication(receipt.publicationId)?.state).toBe("conflicted");
			} finally {
				fixture.store.close();
			}
		});
	}, 30_000);

	it("records conflict when nothing applies, preserving both sides", async () => {
		await withTempBase(async (base, dbPath) => {
			const { repoRoot, filePath } = await makeRepo(base, "conf");
			const patchPath = path.join(base, "stale.patch");
			const patchText = await makePatch(repoRoot, filePath, "stale change\n", patchPath);
			// Diverge the live target so the recorded before-image no longer matches.
			await fs.writeFile(filePath, "concurrent human edit\n", "utf8");
			const fixture = makeStoreAndAttempt(dbPath());
			try {
				const receipt = await publishLifecycleCandidate(
					makeInput(fixture, {
						target: "user-workspace",
						approvalRef: "approval-3",
						mutation: { ...createTestMutationContract(), approvalRef: "approval-3" },
						manifest: createTestArtifactRef(
							"pub-manifest",
							createHash("sha256").update(patchText, "utf8").digest("hex"),
							`file://${patchPath}`,
						),
						repositories: [{ targetId: "root", repoRoot, patchUri: patchPath }],
					}),
				);
				expect(receipt.state).toBe("conflicted");
				expect(receipt.changesApplied).toBe(false);
				expect(receipt.recoveryRefs).toContain(`file://${patchPath}`);
				// Both sides retained: the human edit is untouched.
				expect(await fs.readFile(filePath, "utf8")).toBe("concurrent human edit\n");
				expect(fixture.store.getPublication(receipt.publicationId)?.state).toBe("conflicted");
			} finally {
				fixture.store.close();
			}
		});
	}, 30_000);

	it("never steals a publication lease held by another controller", async () => {
		await withTempBase(async (base, dbPath) => {
			const { repoRoot } = await makeRepo(base, "lease");
			const patchPath = path.join(base, "root.patch");
			const patchText = await makePatch(repoRoot, path.join(repoRoot, "file.txt"), "leased content\n", patchPath);
			const manifestHash = createHash("sha256").update(patchText, "utf8").digest("hex");
			const fixture = makeStoreAndAttempt(dbPath());
			try {
				// Another controller already holds a long-lived fenced claim.
				const held = fixture.store.claimPublication({
					attemptId: fixture.attemptId,
					targetKind: "user-workspace",
					targetId: "root",
					manifestHash,
					expectedSnapshotHash: "c".repeat(64),
					publisherOwner: "other-controller",
					leaseMs: 3_600_000,
					mutationPolicy: { ...createTestMutationContract(), approvalRef: "approval-4" },
				});
				expect(held.ok).toBe(true);

				const receipt = await publishLifecycleCandidate(
					makeInput(fixture, {
						target: "user-workspace",
						approvalRef: "approval-4",
						mutation: { ...createTestMutationContract(), approvalRef: "approval-4" },
						manifest: createTestArtifactRef("pub-manifest", manifestHash, `file://${patchPath}`),
						repositories: [{ targetId: "root", repoRoot, patchUri: patchPath }],
					}),
				);
				expect(receipt.state).toBe("pending");
				expect(receipt.recoveryRefs).toContain(`file://${patchPath}`);
				// The workspace was not mutated by the losing controller.
				expect(await fs.readFile(path.join(repoRoot, "file.txt"), "utf8")).toBe("original content\n");
			} finally {
				fixture.store.close();
			}
		});
	}, 30_000);
});

describe("crash reconciliation", () => {
	function seedPreparedPublication(
		fixture: Fixture,
		input: PublicationInput,
		images: readonly ReturnType<typeof journalBeforeImage>[],
	) {
		const claim = fixture.store.claimPublication({
			attemptId: input.attemptId,
			targetKind: input.target,
			targetId: `run-candidate:${input.runId}`,
			manifestHash: input.manifest.sha256,
			expectedSnapshotHash: input.expectedCandidate.manifestHash,
			publisherOwner: "dead-controller",
			leaseMs: 1,
			mutationPolicy: input.mutation,
		});
		if (!claim.ok) throw new Error(`claim failed: ${claim.code}`);
		expect(
			fixture.store.journalPublicationStage({
				publicationId: claim.publicationId,
				publisherOwner: "dead-controller",
				expectedEpoch: claim.epoch,
				stage: "prepared",
				stageData: { repositories: images },
			}),
		).toBe(true);
		return claim;
	}

	it("reclaims exact-before after a dead controller and applies once", async () => {
		await withTempBase(async (base, dbPath) => {
			let now = 10;
			const fixture = makeStoreAndAttempt(dbPath(), { now: () => now });
			try {
				const { repoRoot, filePath } = await makeRepo(base, "recovery-before");
				const patchPath = path.join(base, "before.patch");
				const patch = await makePatch(repoRoot, filePath, "recovered once\n", patchPath);
				const repo = { targetId: "root", repoRoot, patchUri: patchPath };
				const input = makeInput(fixture, { repositories: [repo], publisherOwner: "recovery-controller" });
				seedPreparedPublication(fixture, input, [journalBeforeImage(repo, patch)]);
				now = 20;
				const receipt = await publishLifecycleCandidate(input);
				expect(receipt.state).toBe("integrated");
				expect(await fs.readFile(filePath, "utf8")).toBe("recovered once\n");
			} finally {
				fixture.store.close();
			}
		});
	});

	it("finalizes verified exact-after without reapplying a dead controller's patch", async () => {
		await withTempBase(async (base, dbPath) => {
			let now = 10;
			const fixture = makeStoreAndAttempt(dbPath(), { now: () => now });
			try {
				const { repoRoot, filePath } = await makeRepo(base, "recovery-after");
				const patchPath = path.join(base, "after.patch");
				const patch = await makePatch(repoRoot, filePath, "already applied\n", patchPath);
				const repo = { targetId: "root", repoRoot, patchUri: patchPath };
				const input = makeInput(fixture, { repositories: [repo], publisherOwner: "recovery-controller" });
				const claim = seedPreparedPublication(fixture, input, [journalBeforeImage(repo, patch)]);
				runGit(repoRoot, ["apply", "--binary", patchPath]);
				expect(
					fixture.store.journalPublicationStage({
						publicationId: claim.publicationId,
						publisherOwner: "dead-controller",
						expectedEpoch: claim.epoch,
						stage: "applied",
						stageData: { applied: ["root"], failed: [] },
					}),
				).toBe(true);
				const afterTree = worktreeHash(repoRoot);
				expect(
					fixture.store.journalPublicationStage({
						publicationId: claim.publicationId,
						publisherOwner: "dead-controller",
						expectedEpoch: claim.epoch,
						stage: "verified",
						stageData: { afterTrees: { root: afterTree }, resultingSnapshotHash: afterTree },
					}),
				).toBe(true);
				now = 20;
				const receipt = await publishLifecycleCandidate(input);
				expect(receipt.state).toBe("integrated");
				expect(await fs.readFile(filePath, "utf8")).toBe("already applied\n");
			} finally {
				fixture.store.close();
			}
		});
	});

	it("blocks ambiguous mixed recovery before applying an untouched nested target", async () => {
		await withTempBase(async (base, dbPath) => {
			let now = 10;
			const fixture = makeStoreAndAttempt(dbPath(), { now: () => now });
			try {
				const root = await makeRepo(base, "recovery-mixed-root");
				const nested = await makeRepo(base, "recovery-mixed-nested");
				const rootPatchPath = path.join(base, "mixed-root.patch");
				const nestedPatchPath = path.join(base, "mixed-nested.patch");
				const rootPatch = await makePatch(root.repoRoot, root.filePath, "root applied\n", rootPatchPath);
				const nestedPatch = await makePatch(nested.repoRoot, nested.filePath, "must not apply\n", nestedPatchPath);
				const repositories = [
					{ targetId: "root", repoRoot: root.repoRoot, patchUri: rootPatchPath },
					{ targetId: "nested", repoRoot: nested.repoRoot, patchUri: nestedPatchPath },
				];
				const input = makeInput(fixture, { repositories, publisherOwner: "recovery-controller" });
				seedPreparedPublication(fixture, input, [
					journalBeforeImage(repositories[0]!, rootPatch),
					journalBeforeImage(repositories[1]!, nestedPatch),
				]);
				runGit(root.repoRoot, ["apply", "--binary", rootPatchPath]);
				now = 20;
				const receipt = await publishLifecycleCandidate(input);
				expect(receipt.state).toBe("conflicted");
				expect(await fs.readFile(root.filePath, "utf8")).toBe("root applied\n");
				expect(await fs.readFile(nested.filePath, "utf8")).toBe("original content\n");
			} finally {
				fixture.store.close();
			}
		});
	});
});
