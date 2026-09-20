/**
 * Valid test fixtures for frozen lifecycle contracts (W1 freeze).
 * Strictly typed, valid hashes, no mock/fake shortcuts.
 */

import type { AgentExecutionProfile } from "../../src/orchestration/agent-execution-profile";
import type { CollaborationPolicy } from "../../src/orchestration/collaboration-policy";
import type { HarnessManifestV1 } from "../../src/orchestration/harness-manifest";
import { computeHarnessManifestHash } from "../../src/orchestration/harness-manifest";
import type { LifecycleCompletionSnapshot, VerificationReceiptV1 } from "../../src/orchestration/snapshot-completion";
import type {
	ArtifactRefV1,
	CompiledLaunchContract,
	MissionCapsule,
	MutationContractV1,
	RunLimitsV1,
	RuntimePolicySnapshotV1,
	SnapshotRefV1,
} from "../../src/task/launch-contract";
import { compileLaunchContract } from "../../src/task/launch-contract";
import type { ResolvedToolProfile } from "../../src/tools/tool-profiles";

export const DUMMY_HASH_1 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const DUMMY_HASH_2 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

export function createTestSnapshotRef(hash: string = DUMMY_HASH_1, uri = "snapshot://base-1"): SnapshotRefV1 {
	return Object.freeze({
		schemaVersion: 1 as const,
		manifestHash: hash,
		manifestUri: uri,
	});
}

export function createTestArtifactRef(
	id = "art-1",
	hash: string = DUMMY_HASH_2,
	uri = "artifact://art-1",
): ArtifactRefV1 {
	return Object.freeze({
		schemaVersion: 1 as const,
		artifactId: id,
		uri,
		sha256: hash,
		bytes: 1024,
		mediaType: "application/octet-stream",
		provenanceId: "prov-1",
	});
}

export function createTestExecutionProfile(): AgentExecutionProfile {
	return Object.freeze({
		tier: "mid",
		autonomy: "supervised",
		collaboration: "report-only",
		workClass: "mechanical",
		editMode: "replace",
		maxRequests: 10,
		maxRuntimeMs: 60_000,
		modelPool: Object.freeze(["anthropic/claude-3-5-sonnet"]),
		modelPoolConstrained: true,
	});
}

export function createTestToolProfile(): ResolvedToolProfile {
	return Object.freeze({
		maximum: Object.freeze([
			{ source: "builtin" as const, name: "read" },
			{ source: "builtin" as const, name: "edit" },
		]),
		editMode: "replace",
		allowDiscovery: false,
		tier: "mid",
		autonomy: "supervised",
		toolsConstrained: true,
	});
}

export function createTestCollaborationPolicy(): CollaborationPolicy {
	return Object.freeze({
		mode: "report-only",
		peerScope: "parent",
		allowedPeers: Object.freeze([]),
		familyIds: Object.freeze([]),
		wakePolicy: "deny",
		wakeBudget: 0,
		allowBusyModelReply: false,
	});
}

export function createTestMutationContract(): MutationContractV1 {
	return Object.freeze({
		schemaVersion: 1 as const,
		apply: true,
		allowCommit: false,
		allowPush: false,
		allowMerge: false,
		approvalRef: null,
	});
}

export function createTestRunLimits(): RunLimitsV1 {
	return Object.freeze({
		schemaVersion: 1 as const,
		maxNodes: 10,
		maxDepth: 3,
		maxAttemptsPerNode: 2,
		maxOutstanding: 4,
		maxActiveCompute: 2,
		maxRequests: 50,
		maxRuntimeMs: 300_000,
		maxComputeRuntimeMs: 180_000,
		maxTokens: 100_000,
		maxCostMicrounits: 5_000_000,
		currency: "USD",
		maxHandoffBytes: 16_384,
		maxInboxEvents: 50,
	});
}

export function createTestPolicy(overrides?: Partial<RuntimePolicySnapshotV1>): RuntimePolicySnapshotV1 {
	return Object.freeze({
		schemaVersion: 1 as const,
		role: "worker",
		topology: "hierarchical",
		executionProfile: createTestExecutionProfile(),
		toolProfile: createTestToolProfile(),
		collaborationPolicy: createTestCollaborationPolicy(),
		mutation: createTestMutationContract(),
		limits: createTestRunLimits(),
		baseline: createTestSnapshotRef(),
		grantRefs: Object.freeze(["grant-1"]),
		harnessRef: "harness-v1",
		projectionVersion: 1 as const,
		environmentRef: "env-local",
		isolationLevel: "cooperative-worktree",
		...overrides,
	});
}

export function createTestCapsule(overrides?: Partial<MissionCapsule>): MissionCapsule {
	return Object.freeze({
		schemaVersion: 1 as const,
		objective: "Execute unit test",
		nonGoals: Object.freeze(["out-of-scope"]),
		baselineRef: createTestSnapshotRef(),
		inputs: Object.freeze([
			{
				artifact: createTestArtifactRef("art-1"),
				description: "Input source",
				grantId: "grant-1",
			},
		]),
		readableScope: Object.freeze(["src/"]),
		writableScope: Object.freeze(["src/"]),
		acceptance: Object.freeze([{ id: "crit-1", description: "Passes unit checks" }]),
		capabilitySummary: Object.freeze(["read", "edit"]),
		localBudget: Object.freeze({
			maxRequests: 10,
			maxRuntimeMs: 60_000,
			maxTokens: 20_000,
		}),
		...overrides,
	});
}

export function createTestCompiledContract(
	capsuleOverrides?: Partial<MissionCapsule>,
	policyOverrides?: Partial<RuntimePolicySnapshotV1>,
): CompiledLaunchContract {
	const capsule = createTestCapsule(capsuleOverrides);
	const policy = createTestPolicy(policyOverrides);
	const res = compileLaunchContract({
		capsule,
		policy,
		parentPolicy: null,
		requiredInputIds: [],
	});
	if (!res.ok) {
		throw new Error(`Failed to compile test launch contract: ${res.diagnostics.map(d => d.message).join(", ")}`);
	}
	return res.compiled;
}

export function createTestHarnessManifest(overrides?: Partial<HarnessManifestV1>): HarnessManifestV1 {
	// manifestHash is derived, never a literal: a fixture carrying an arbitrary
	// digest would not survive its own parser's integrity check.
	const body = {
		schemaVersion: 1 as const,
		profile: "implementation" as const,
		kind: "full" as const,
		maxTools: Object.freeze([{ source: "builtin" as const, name: "read" }]),
		skillPolicy: Object.freeze({ mode: "none" as const, allowNames: Object.freeze([]), maxSkills: 0 }),
		projectionVersion: 1 as const,
		observationPolicy: "raw-retained" as const,
		memoryPolicy: "local-only" as const,
		checkpointContract: "durable" as const,
		modelRoute: Object.freeze([{ provider: "default", model: "default" }]),
		returnSchemaRef: "schema://none",
		skillRefs: Object.freeze([]),
		...overrides,
	};
	return Object.freeze({
		...body,
		harnessVersion: overrides?.harnessVersion ?? "harness-1.0.0",
		manifestHash: computeHarnessManifestHash(body),
	});
}

export function createTestVerificationReceipt(overrides?: Partial<VerificationReceiptV1>): VerificationReceiptV1 {
	return Object.freeze({
		schemaVersion: 1 as const,
		receiptId: "rcpt-1",
		runId: "run-1",
		nodeId: "node-1",
		attemptId: "att-1",
		contractVersion: 1,
		contractHash: DUMMY_HASH_1,
		candidateHash: DUMMY_HASH_2,
		environmentHash: DUMMY_HASH_1,
		lockfileHash: DUMMY_HASH_1,
		verifierId: "verifier-1",
		verifierVersion: "1.0.0",
		argv: Object.freeze(["bun", "test"]),
		cwd: "/workspace",
		nonSecretEnvHash: DUMMY_HASH_1,
		startedAt: 1000,
		finishedAt: 2000,
		exitCode: 0,
		outcome: "passed",
		criterionIds: Object.freeze(["crit-1"]),
		artifactIds: Object.freeze(["art-1"]),
		...overrides,
	});
}

export function createTestCompletionSnapshot(
	overrides?: Partial<LifecycleCompletionSnapshot>,
): LifecycleCompletionSnapshot {
	const receipt = createTestVerificationReceipt();
	return Object.freeze({
		runId: "run-1",
		nodeId: "node-1",
		attemptId: "att-1",
		contractHash: DUMMY_HASH_1,
		environmentHash: DUMMY_HASH_1,
		candidateHash: DUMMY_HASH_2,
		mandatoryCriterionIds: Object.freeze(["crit-1"]),
		receipts: Object.freeze([receipt]),
		openObligationIds: Object.freeze([]),
		waivedObligationIds: Object.freeze([]),
		publicationState: "integrated",
		publicationRequired: true,
		scopeReceiptId: "scope-rcpt-1",
		dependencyTerminalStates: Object.freeze([]),
		executionOutcome: "completed",
		...overrides,
	});
}
