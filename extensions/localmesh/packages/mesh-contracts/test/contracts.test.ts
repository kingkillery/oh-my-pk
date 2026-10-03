import { describe, expect, test } from "bun:test";

import {
	MESH_SCHEMA,
	MeshValidationError,
	parseTaskContract,
	sha256CanonicalJson,
	validateMeshContract,
} from "../src/index";

function unsignedTask(): Record<string, unknown> {
	return {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_foundation-contracts-001",
		sessionId: "ses_foundation-contracts-001",
		createdAt: "2026-08-31T00:00:00Z",
		requester: { pubkey: "f".repeat(64), role: "human" },
		goal: "Verify the mesh contract foundation.",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "criterion-1", description: "The contract validates.", level: "required" }],
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
		idempotencyKey: "foundation-contracts-001",
		digestAlgorithm: "sha256",
	};
}

function signedTask(): Record<string, unknown> {
	const task = unsignedTask();
	return { ...task, digest: sha256CanonicalJson(task) };
}

function executorInvocation(args: unknown = { owner: "kingkillery", repo: "oh-my-pk" }): Record<string, unknown> {
	return {
		protocol: "executor-mcp-v1",
		endpointId: "localExecutor",
		toolPath: ["github", "issues", "create"],
		args,
		inputDigest: sha256CanonicalJson(args),
		catalogFingerprint: "c".repeat(64),
	};
}

function signedExecutorTask(): Record<string, unknown> {
	const task = { ...unsignedTask(), executorInvocation: executorInvocation() };
	return { ...task, digest: sha256CanonicalJson(task) };
}

describe("mesh contracts", () => {
	test("canonicalizes key order and validates a correctly signed task", () => {
		expect(sha256CanonicalJson({ z: [2, { b: true, a: null }], a: "first" })).toBe(
			sha256CanonicalJson({ a: "first", z: [2, { a: null, b: true }] }),
		);

		const parsed = parseTaskContract(signedTask());
		expect(parsed.taskId).toBe("task_foundation-contracts-001");
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.permissions)).toBe(true);
	});

	test("rejects a payload changed after its digest was created", () => {
		const tampered = { ...signedTask(), goal: "Run an unapproved command." };
		const result = validateMeshContract(tampered);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.issues[0]?.code).toBe("digest_mismatch");
	});

	test("rejects unknown top-level properties without exposing payload values", () => {
		const invalid = { ...signedTask(), unexpected: "secret-value-must-not-appear" };

		expect(() => parseTaskContract(invalid)).toThrow(MeshValidationError);
		try {
			parseTaskContract(invalid);
		} catch (error) {
			expect(error).toBeInstanceOf(MeshValidationError);
			expect(String(error)).not.toContain("secret-value-must-not-appear");
		}
	});

	test("validates a signed, data-only Executor invocation and binds its canonical args", () => {
		const parsed = parseTaskContract(signedExecutorTask());
		expect(parsed.executorInvocation).toEqual({
			protocol: "executor-mcp-v1",
			endpointId: "localExecutor",
			toolPath: ["github", "issues", "create"],
			args: { owner: "kingkillery", repo: "oh-my-pk" },
			inputDigest: sha256CanonicalJson({ repo: "oh-my-pk", owner: "kingkillery" }),
			catalogFingerprint: "c".repeat(64),
		});

		const changedPath = signedExecutorTask();
		const invocation = changedPath.executorInvocation as Record<string, unknown>;
		changedPath.executorInvocation = { ...invocation, toolPath: ["github", "repos", "delete"] };
		expect(() => parseTaskContract(changedPath)).toThrow(MeshValidationError);
	});

	test("rejects unsafe Executor paths, stale arg digests, and extra invocation fields", () => {
		for (const invocation of [
			{ ...executorInvocation(), toolPath: ["github", "issues;process.exit()"] },
			{ ...executorInvocation(), toolPath: ["__proto__", "pollute"] },
			{ ...executorInvocation(), args: { changed: true } },
			{ ...executorInvocation(), extra: "not-allowed" },
		]) {
			const task = { ...unsignedTask(), executorInvocation: invocation };
			const signed = { ...task, digest: sha256CanonicalJson(task) };
			expect(() => parseTaskContract(signed)).toThrow(MeshValidationError);
		}
	});
});
