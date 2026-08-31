import { describe, expect, test } from "bun:test";

import {
	MESH_SCHEMA,
	parseAssignmentLease,
	parseTaskContract,
	sha256CanonicalJson,
	type AssignmentLeaseV1,
	type TaskContractV1,
} from "@pk-nerdsaver-ai/mesh-contracts";
import type { MeshNodeExecutionContext } from "@pk-nerdsaver-ai/mesh-node";
import {
	canonicalExecutorToolPermission,
	ExecutorMeshExecutionError,
	ExecutorMeshExecutionPort,
	type ExecutorMcpGateway,
	type ExecutorMcpGatewayRequest,
} from "../src";

const NODE_ID = "node_executor-001";
const NODE_PUBKEY = "n".repeat(64);
const ENDPOINT_ID = "localExecutor";
const CATALOG_FINGERPRINT = "c".repeat(64);
const TOOL_PATH = ["github", "issues", "create"] as const;

function makeTask(overrides: Record<string, unknown> = {}): TaskContractV1 {
	const args = { repo: "oh-my-pk", owner: "kingkillery", title: "Safe request" };
	const invocation = {
		protocol: "executor-mcp-v1",
		endpointId: ENDPOINT_ID,
		toolPath: TOOL_PATH,
		args,
		inputDigest: sha256CanonicalJson(args),
		catalogFingerprint: CATALOG_FINGERPRINT,
	};
	const unsigned = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_executor-001",
		createdAt: "2026-08-31T11:59:00.000Z",
		requester: { pubkey: "r".repeat(64), role: "human" },
		goal: "This text must never reach the Executor gateway.",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "criterion-1", description: "Call the exact permitted tool.", level: "required" }],
		permissions: {
			tools: [canonicalExecutorToolPermission(ENDPOINT_ID, TOOL_PATH)],
			externalSideEffects: "approval_required",
		},
		execution: { profileId: "executor-mcp-v1", timeoutSeconds: 30 },
		executorInvocation: invocation,
		routing: { trustZoneMin: "private", activeMachineAllowed: false },
		artifactPolicy: {},
		idempotencyKey: "executor-task-key",
		digestAlgorithm: "sha256",
		...overrides,
	};
	return parseTaskContract({ ...unsigned, digest: sha256CanonicalJson(unsigned) });
}

function makeAssignment(task: TaskContractV1): AssignmentLeaseV1 {
	return parseAssignmentLease({
		schemaVersion: MESH_SCHEMA.assignment,
		assignmentId: "asg_executor-001",
		taskId: task.taskId,
		taskDigest: task.digest,
		scheduler: { pubkey: "s".repeat(64), role: "scheduler" },
		schedulerEpoch: 9,
		fencingToken: 17,
		workerNodeId: NODE_ID,
		executorPubkey: NODE_PUBKEY,
		executionProfileId: "executor-mcp-v1",
		issuedAt: "2026-08-31T11:59:00.000Z",
		leaseExpiresAt: "2026-08-31T12:05:00.000Z",
		renewAfterSeconds: 15,
		permissionsDigest: sha256CanonicalJson(task.permissions),
		placementReason: { source: "test" },
		idempotencyKey: "executor-assignment-key",
	});
}

function makeContext(task: TaskContractV1): MeshNodeExecutionContext {
	const assignment = makeAssignment(task);
	return {
		assignmentId: assignment.assignmentId,
		taskId: task.taskId,
		taskDigest: task.digest,
		nodeId: NODE_ID,
		executorPubkey: NODE_PUBKEY,
		schedulerEpoch: assignment.schedulerEpoch,
		fencingToken: assignment.fencingToken,
		executionProfileId: assignment.executionProfileId,
		bounds: { timeoutSeconds: 30 },
		task,
		assignment,
	};
}

function makePort(gateway: ExecutorMcpGateway, catalogFingerprint = CATALOG_FINGERPRINT): ExecutorMeshExecutionPort {
	return new ExecutorMeshExecutionPort({
		gateway,
		trustedEndpoints: [{ endpointId: ENDPOINT_ID, catalogFingerprint }],
	});
}

describe("ExecutorMeshExecutionPort", () => {
	test("creates one injection-resistant canonical tool call and binds gateway provenance", async () => {
		const calls: ExecutorMcpGatewayRequest[] = [];
		const gateway: ExecutorMcpGateway = {
			async invoke(request) {
				calls.push(request);
				return { status: "succeeded", exitCode: 0 };
			},
		};
		const task = makeTask();
		const context = makeContext(task);
		const port = makePort(gateway);

		await port.start(context);
		await expect(port.run(context)).resolves.toEqual({ outcome: "succeeded", exitCode: 0 });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			endpointId: ENDPOINT_ID,
			code: 'return await tools.github.issues.create({"owner":"kingkillery","repo":"oh-my-pk","title":"Safe request"});',
			metadata: {
				taskId: task.taskId,
				taskDigest: task.digest,
				assignmentId: context.assignmentId,
				schedulerEpoch: 9,
				fencingToken: 17,
				inputDigest: task.executorInvocation?.inputDigest,
				catalogFingerprint: CATALOG_FINGERPRINT,
				toolPermission: canonicalExecutorToolPermission(ENDPOINT_ID, TOOL_PATH),
			},
		});
		expect(JSON.stringify(calls[0])).not.toContain(task.goal);

		const malicious = {
			...task,
			executorInvocation: { ...task.executorInvocation, toolPath: ["github", "issues;process.exit()"] },
		} as TaskContractV1;
		await expect(port.start(makeContext(malicious))).rejects.toMatchObject({ code: "invocation_invalid" });
		expect(calls).toHaveLength(1);
	});

	test("rejects missing exact permission, stale args, and untrusted catalog before the gateway", async () => {
		let callCount = 0;
		const gateway: ExecutorMcpGateway = {
			async invoke() {
				callCount += 1;
				return { status: "succeeded" };
			},
		};
		const noPermission = makeTask({
			permissions: { tools: ["executor:localExecutor:tools.github.issues.*"], externalSideEffects: "approval_required" },
		});
		await expect(makePort(gateway).start(makeContext(noPermission))).rejects.toMatchObject({ code: "tool_permission_denied" });

		const validTask = makeTask();
		const staleArgs = {
			...validTask,
			executorInvocation: { ...validTask.executorInvocation, args: { changed: true } },
		} as TaskContractV1;
		await expect(makePort(gateway).start(makeContext(staleArgs))).rejects.toMatchObject({ code: "invocation_invalid" });

		await expect(makePort(gateway, "d".repeat(64)).start(makeContext(validTask))).rejects.toMatchObject({ code: "catalog_fingerprint_mismatch" });
		expect(callCount).toBe(0);
	});

	test("never resumes approvals and reports cancellation as uncertain", async () => {
		const gateway: ExecutorMcpGateway = {
			async invoke() {
				return { status: "approval_required" };
			},
		};
		const context = makeContext(makeTask());
		const port = makePort(gateway);

		await expect(port.run(context)).rejects.toEqual(new ExecutorMeshExecutionError("approval_required"));
		await expect(port.cancel(context)).rejects.toEqual(new ExecutorMeshExecutionError("cancellation_uncertain"));
	});
});
