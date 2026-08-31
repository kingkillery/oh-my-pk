import { describe, expect, test } from "bun:test";

import {
	MESH_SCHEMA,
	parseTaskContract,
	sha256CanonicalJson,
} from "../../mesh-contracts/src/index";
import {
	evaluateAssignmentAttenuation,
	evaluateAuthorization,
	parseIdentityDelegation,
} from "../src/index";

function task(): ReturnType<typeof parseTaskContract> {
	const unsigned = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_policy-attenuation-001",
		createdAt: "2026-08-31T00:00:00Z",
		requester: { pubkey: "f".repeat(64), role: "human" },
		goal: "Run a constrained mesh action.",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "criterion-1", description: "Policy holds.", level: "required" }],
		permissions: {
			tools: ["shell"],
			secrets: ["mesh-token"],
			network: ["https://relay.example"],
			filesystem: ["/workspace"],
			externalSideEffects: "approval_required",
		},
		execution: { timeoutSeconds: 120, cpuMax: 2, memoryBytesMax: 1_073_741_824 },
		routing: {
			requiredCapabilities: ["container"],
			forbiddenNodes: ["node_interactive-001"],
			trustZoneMin: "private",
			activeMachineAllowed: false,
			costCeilingUsd: 1,
		},
		artifactPolicy: { encryptionRequired: true, replicasMin: 2, retentionClass: "project" },
		approvalPolicy: { requiredFor: ["publish"], approvalTimeoutSeconds: 900 },
		idempotencyKey: "policy-attenuation-001",
		digestAlgorithm: "sha256" as const,
	};
	return parseTaskContract({ ...unsigned, digest: sha256CanonicalJson(unsigned) });
}

function scopeFor(root: ReturnType<typeof task>) {
	return {
		goal: root.goal,
		permissions: root.permissions,
		execution: root.execution,
		routing: root.routing,
		artifactPolicy: root.artifactPolicy,
		approvalPolicy: root.approvalPolicy,
	};
}

describe("mesh policy", () => {
	test("allows an assignment whose authority is unchanged or narrower", () => {
		const root = task();
		const decision = evaluateAssignmentAttenuation(root, {
			...scopeFor(root),
			permissions: { ...root.permissions, network: [] },
			execution: { ...root.execution, timeoutSeconds: 60 },
			artifactPolicy: { ...root.artifactPolicy, allowedContentTypes: [] },
		});

		expect(decision).toEqual({ outcome: "allow", reasons: [], obligations: [] });
	});

	test("denies an assignment that weakens active-machine protection or expands tools", () => {
		const root = task();
		const decision = evaluateAssignmentAttenuation(root, {
			...scopeFor(root),
			permissions: { ...root.permissions, tools: ["shell", "browser"] },
			routing: { ...root.routing, activeMachineAllowed: true },
		});

		expect(decision.outcome).toBe("deny");
		expect(decision.reasons).toContain("tool_scope_broadened");
		expect(decision.reasons).toContain("active_machine_protection_weakened");
	});

	test("requires approval only after signature, delegation, and scope checks pass", () => {
		const root = task();
		const delegation = parseIdentityDelegation({
			schemaVersion: "ompk.identity-delegation/v1",
			delegationId: "delegation-policy-001",
			issuerPubkey: "a".repeat(64),
			subjectPubkey: "b".repeat(64),
			role: "agent",
			allowedActions: ["publish"],
			toolScopes: ["shell"],
			secretScopes: ["mesh-token"],
			repositoryScopes: ["kingkillery/localmesh"],
			trustZone: "private",
			maxCostUsd: 1,
			notBefore: "2026-08-01T00:00:00Z",
			expiresAt: "2026-09-01T00:00:00Z",
			revocationEpoch: 1,
			serial: 1,
		});
		const decision = evaluateAuthorization({
			task: root,
			scope: scopeFor(root),
			evaluatedAt: "2026-08-31T00:00:00Z",
			signatureVerified: true,
			delegation,
			revocations: [],
			subjectPubkey: delegation.subjectPubkey,
			action: "publish",
			tools: ["shell"],
			secrets: ["mesh-token"],
			repository: "kingkillery/localmesh",
			trustZone: "private",
			costUsd: 1,
		});

		expect(decision).toEqual({
			outcome: "require_approval",
			reasons: ["approval_required"],
			obligations: ["bind_exact_action_parameters"],
		});
	});

	test("permits a more trusted local placement under a private delegation", () => {
		const root = task();
		const delegation = parseIdentityDelegation({
			schemaVersion: "ompk.identity-delegation/v1",
			delegationId: "delegation-local-001",
			issuerPubkey: "a".repeat(64),
			subjectPubkey: "b".repeat(64),
			role: "agent",
			allowedActions: ["publish"],
			toolScopes: ["shell"],
			secretScopes: ["mesh-token"],
			repositoryScopes: ["kingkillery/localmesh"],
			trustZone: "private",
			notBefore: "2026-08-01T00:00:00Z",
			expiresAt: "2026-09-01T00:00:00Z",
			revocationEpoch: 1,
			serial: 1,
		});
		const decision = evaluateAuthorization({
			task: root,
			scope: { ...scopeFor(root), routing: { ...root.routing, trustZoneMin: "local" } },
			evaluatedAt: "2026-08-31T00:00:00Z",
			signatureVerified: true,
			delegation,
			revocations: [],
			subjectPubkey: delegation.subjectPubkey,
			action: "publish",
			tools: ["shell"],
			secrets: ["mesh-token"],
			repository: "kingkillery/localmesh",
			trustZone: "local",
			approvalGranted: true,
		});

		expect(decision).toEqual({ outcome: "allow", reasons: [], obligations: [] });
	});
});
