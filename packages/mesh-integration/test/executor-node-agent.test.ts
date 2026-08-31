import { describe, expect, test } from "bun:test";

import {
	MESH_SCHEMA,
	contractDigest,
	parseAssignmentLease,
	parseNodeAdvertisement,
	parseTaskContract,
	sha256CanonicalJson,
	type AssignmentLeaseV1,
	type JsonRecord,
	type TaskContractV1,
} from "../../mesh-contracts/src/index";
import {
	canonicalExecutorToolPermission,
	ExecutorMeshExecutionPort,
	type ExecutorMcpGateway,
	type ExecutorMcpGatewayRequest,
	type ExecutorMcpGatewayResult,
} from "../../mesh-executor/src/index";
import { MeshNodeAgent, projectNodeAdvertisement, type MeshNodePresence } from "../../mesh-node/src/index";

const T0 = Date.parse("2026-08-31T12:00:00.000Z");
const NODE_ID = "node_executor-integration-001";
const NODE_PUBKEY = "n".repeat(64);
const SCHEDULER_PUBKEY = "s".repeat(64);
const ENDPOINT_ID = "localExecutor";
const CATALOG_FINGERPRINT = "c".repeat(64);
const TOOL_PATH = ["github", "issues", "create"] as const;
const RAW_PAYLOAD = "UNTRUSTED_RAW_PAYLOAD: do-not-forward-this-to-executor";

interface TaskFixtureOptions {
	readonly permissions?: JsonRecord;
}

class RecordingGateway implements ExecutorMcpGateway {
	readonly calls: ExecutorMcpGatewayRequest[] = [];
	readonly #result: ExecutorMcpGatewayResult;

	constructor(result: ExecutorMcpGatewayResult) {
		this.#result = result;
	}

	async invoke(request: ExecutorMcpGatewayRequest): Promise<ExecutorMcpGatewayResult> {
		this.calls.push(request);
		return this.#result;
	}
}

function at(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

/**
 * The task is a canonical, digest-verified contract. Its invocation contains
 * only structured tool data; the goal deliberately includes untrusted text.
 */
function signedTask(options: TaskFixtureOptions = {}): TaskContractV1 {
	const args = {
		labels: ["executor", "mesh"],
		owner: "kingkillery",
		repo: "localmesh",
		title: "Create the bounded integration fixture",
	};
	const invocation = {
		protocol: "executor-mcp-v1" as const,
		endpointId: ENDPOINT_ID,
		toolPath: TOOL_PATH,
		args,
		inputDigest: sha256CanonicalJson(args),
		catalogFingerprint: CATALOG_FINGERPRINT,
	};
	const body = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_executor-integration-001",
		createdAt: at(-1_000),
		requester: { pubkey: "r".repeat(64), role: "human" },
		goal: `Create the approved fixture. ${RAW_PAYLOAD}`,
		mode: "general_tool",
		acceptanceCriteria: [{ id: "created", description: "The exact allowed tool is invoked once.", level: "required" }],
		permissions:
			options.permissions ??
			{
				tools: [canonicalExecutorToolPermission(ENDPOINT_ID, TOOL_PATH)],
				externalSideEffects: "approval_required",
			},
		execution: { profileId: "executor-mcp-v1", timeoutSeconds: 30 },
		executorInvocation: invocation,
		routing: { requiredCapabilities: ["executor.mcp"], trustZoneMin: "private", activeMachineAllowed: false },
		artifactPolicy: {},
		idempotencyKey: "executor-integration-task-001",
		digestAlgorithm: "sha256" as const,
	};
	return parseTaskContract({ ...body, digest: contractDigest(body as unknown as JsonRecord, "digest") });
}

/** The lease binds the task digest, permission digest, worker identity, and scheduler fence. */
function signedAssignment(task: TaskContractV1): AssignmentLeaseV1 {
	return parseAssignmentLease({
		schemaVersion: MESH_SCHEMA.assignment,
		assignmentId: "asg_executor-integration-001",
		taskId: task.taskId,
		taskDigest: task.digest,
		scheduler: { pubkey: SCHEDULER_PUBKEY, role: "scheduler" },
		schedulerEpoch: 23,
		fencingToken: 41,
		workerNodeId: NODE_ID,
		executorPubkey: NODE_PUBKEY,
		executionProfileId: "executor-mcp-v1",
		issuedAt: at(-500),
		leaseExpiresAt: at(60_000),
		renewAfterSeconds: 15,
		permissionsDigest: sha256CanonicalJson(task.permissions),
		placementReason: { selectedNodeId: NODE_ID, reason: "integration_fixture" },
		idempotencyKey: "executor-integration-assignment-001",
	});
}

function healthyPresence(): MeshNodePresence {
	return projectNodeAdvertisement(
		parseNodeAdvertisement({
			schemaVersion: MESH_SCHEMA.node,
			nodeId: NODE_ID,
			actorPubkey: NODE_PUBKEY,
			generatedAt: at(-500),
			expiresAt: at(60_000),
			trustZone: "private",
			interactive: false,
			draining: false,
			static: { totalSlots: 1 },
			dynamic: { availableSlots: 1, health: "healthy", activeInteractiveUser: false },
			capabilities: { names: ["executor.mcp"], executionProfiles: ["executor-mcp-v1"] },
			reservations: {},
			profileVersion: "executor-integration-node-v1",
		}),
	);
}

function createAgent(gateway: ExecutorMcpGateway): MeshNodeAgent {
	return new MeshNodeAgent({
		identity: { nodeId: NODE_ID, pubkey: NODE_PUBKEY },
		execution: new ExecutorMeshExecutionPort({
			gateway,
			trustedEndpoints: [{ endpointId: ENDPOINT_ID, catalogFingerprint: CATALOG_FINGERPRINT }],
		}),
		getPresence: healthyPresence,
		now: () => T0,
	});
}

describe("Executor through the MeshNodeAgent boundary", () => {
	test("admits a digest-bound lease before sending exactly one canonical, provenance-bound gateway call", async () => {
		const gateway = new RecordingGateway({ status: "succeeded", exitCode: 0 });
		const agent = createAgent(gateway);
		const task = signedTask();
		const assignment = signedAssignment(task);

		expect(agent.accept({ task, assignment })).toMatchObject({ type: "assignment.accepted", state: "admitted" });
		expect(gateway.calls).toHaveLength(0);

		await expect(agent.start(assignment.assignmentId)).resolves.toMatchObject({ type: "execution.started", state: "started" });
		expect(gateway.calls).toHaveLength(0);

		await expect(agent.run(assignment.assignmentId)).resolves.toMatchObject({
			type: "execution.completed",
			state: "completed",
			outcome: "succeeded",
			exitCode: 0,
		});
		expect(gateway.calls).toHaveLength(1);

		const call = gateway.calls[0];
		expect(call).toEqual({
			endpointId: ENDPOINT_ID,
			code: 'return await tools.github.issues.create({"labels":["executor","mesh"],"owner":"kingkillery","repo":"localmesh","title":"Create the bounded integration fixture"});',
			metadata: {
				taskId: task.taskId,
				taskDigest: task.digest,
				assignmentId: assignment.assignmentId,
				schedulerEpoch: assignment.schedulerEpoch,
				fencingToken: assignment.fencingToken,
				inputDigest: task.executorInvocation?.inputDigest,
				catalogFingerprint: CATALOG_FINGERPRINT,
				toolPermission: canonicalExecutorToolPermission(ENDPOINT_ID, TOOL_PATH),
			},
		});
		expect(call.code).not.toContain(task.goal);
		expect(call.code).not.toContain(RAW_PAYLOAD);
		expect(JSON.stringify(call)).not.toContain(RAW_PAYLOAD);
	});

	test("blocks a wildcard permission before the Executor gateway is contacted", async () => {
		const gateway = new RecordingGateway({ status: "succeeded", exitCode: 0 });
		const agent = createAgent(gateway);
		const task = signedTask({
			permissions: { tools: ["executor:localExecutor:tools.github.issues.*"], externalSideEffects: "approval_required" },
		});
		const assignment = signedAssignment(task);

		agent.accept({ task, assignment });
		await expect(agent.start(assignment.assignmentId)).rejects.toMatchObject({ code: "execution_adapter_failed" });
		expect(agent.state(assignment.assignmentId)).toBe("failed");
		expect(agent.assignmentEvents(assignment.assignmentId).at(-1)).toMatchObject({
			type: "execution.start_failed",
			code: "execution_adapter_failed",
		});
		expect(gateway.calls).toHaveLength(0);
	});

	test("turns an Executor approval pause into a safe terminal failure without automatic resume", async () => {
		const gateway = new RecordingGateway({ status: "approval_required" });
		const agent = createAgent(gateway);
		const task = signedTask();
		const assignment = signedAssignment(task);

		agent.accept({ task, assignment });
		await agent.start(assignment.assignmentId);
		await expect(agent.run(assignment.assignmentId)).rejects.toMatchObject({ code: "execution_adapter_failed" });
		expect(agent.state(assignment.assignmentId)).toBe("failed");
		expect(agent.assignmentEvents(assignment.assignmentId).at(-1)).toMatchObject({
			type: "execution.failed",
			state: "failed",
			code: "execution_adapter_failed",
		});

		await expect(agent.run(assignment.assignmentId)).rejects.toMatchObject({ code: "assignment_state_invalid" });
		expect(gateway.calls).toHaveLength(1);
	});
});
