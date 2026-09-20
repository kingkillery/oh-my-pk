import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { OperationalStore } from "../../src/operational/store";
import { resolveAgentHarness } from "../../src/orchestration/agent-harness";
import { authorizeGrantAccess, denyEnumeration } from "../../src/orchestration/artifact-grants";
import { resolveHarnessManifest, verifyHarnessManifest } from "../../src/orchestration/harness-manifest";
import { getLifecycleRunView } from "../../src/orchestration/lifecycle-snapshot";
import { compileLaunchContract } from "../../src/task/launch-contract";
import { decideRecovery } from "../../src/task/recovery-capsule";
import { createTestCapsule, createTestPolicy } from "../helpers/lifecycle-fixtures";

describe("Recovery capsule fencing (C2)", () => {
	it("continues only with live lease, unchanged contract, and retained workspace", () => {
		expect(
			decideRecovery({
				leaseLive: true,
				contractUnchanged: true,
				workspaceRetained: true,
				pinnedManifestAvailable: true,
			}),
		).toEqual({ kind: "continue-attempt" });
		expect(
			decideRecovery({
				leaseLive: false,
				contractUnchanged: true,
				workspaceRetained: true,
				pinnedManifestAvailable: true,
			}).kind,
		).toBe("new-attempt");
		expect(
			decideRecovery({
				leaseLive: true,
				contractUnchanged: true,
				workspaceRetained: true,
				pinnedManifestAvailable: false,
			}),
		).toEqual({ kind: "blocked", reason: "missing_pinned_manifest" });
	});
});

describe("Pinned harness and scoped grants (B-quality)", () => {
	it("pins a harness manifest and verifies it against the same harness", () => {
		const harness = resolveAgentHarness({ agentName: "oracle" });
		const manifest = resolveHarnessManifest(harness, "implementation");
		expect(manifest.manifestHash).toHaveLength(64);
		expect(verifyHarnessManifest(manifest)).toBe(true);
	});

	it("authorizes exact-grant retrieval and denies enumeration", () => {
		const grant = {
			grantId: "g-1",
			runId: "run-1",
			ownerNodeId: "node-1",
			resourceIdentity: "artifact://evidence-1",
			resourceHash: "h1",
			rights: ["read"] as const,
			maxReadBytes: 1024,
			expiresAt: null,
			revoked: false,
			provenance: ["run-1/node-1"],
		};
		const allowed = authorizeGrantAccess(grant, {
			runId: "run-1",
			nodeId: "node-1",
			resourceIdentity: "artifact://evidence-1",
			resourceHash: "h1",
			right: "read",
			bytes: 100,
			now: Date.now(),
		});
		expect(allowed.allowed).toBe(true);

		const sibling = authorizeGrantAccess(grant, {
			runId: "run-1",
			nodeId: "node-2",
			resourceIdentity: "artifact://sibling-secret",
			resourceHash: "h2",
			right: "read",
			bytes: 10,
			now: Date.now(),
		});
		expect(sibling.allowed).toBe(false);
		expect(denyEnumeration().allowed).toBe(false);
	});
});

describe("Operator lifecycle view (F0)", () => {
	it("renders an execution/delivery/acceptance tree without prompt content", () => {
		const dbPath = path.join(os.tmpdir(), `runview-${Date.now()}.db`);
		const store = OperationalStore.open({ dbPath });
		try {
			const capsule = createTestCapsule({
				objective: "Operator view fixture",
				nonGoals: [],
				inputs: [],
				readableScope: ["src/"],
				writableScope: ["src/out.ts"],
				acceptance: [{ id: "c1", description: "done" }],
				capabilitySummary: [],
				localBudget: { maxRequests: 1, maxRuntimeMs: 5000 },
			});
			const policy = createTestPolicy({
				mutation: {
					schemaVersion: 1 as const,
					apply: false,
					allowCommit: false,
					allowPush: false,
					allowMerge: false,
					approvalRef: null,
				},
				limits: {
					schemaVersion: 1 as const,
					maxNodes: 2,
					maxDepth: 1,
					maxAttemptsPerNode: 1,
					maxOutstanding: 2,
					maxActiveCompute: 1,
					maxRequests: 5,
					maxRuntimeMs: 30000,
					maxComputeRuntimeMs: 15000,
					maxTokens: null,
					maxCostMicrounits: null,
					currency: null,
					maxHandoffBytes: 16384,
					maxInboxEvents: 10,
				},
				grantRefs: [],
				harnessRef: "harness-v1",
				projectionVersion: 1 as const,
				environmentRef: "env-test",
				isolationLevel: "cooperative-worktree",
			});
			const compiled = compileLaunchContract({ capsule, policy, parentPolicy: null, requiredInputIds: [] });
			expect(compiled.ok).toBe(true);
			if (!compiled.ok) return;
			const created = store.createLifecycleRun("run-1", compiled.compiled, policy.limits, "key-1");
			expect(created.ok).toBe(true);

			const view = getLifecycleRunView(store, "run-1");
			expect(view).not.toBeNull();
			expect(view?.nodes.length).toBeGreaterThan(0);
			expect(JSON.stringify(view)).not.toContain("objective");
		} finally {
			store.close();
		}
	});
});
