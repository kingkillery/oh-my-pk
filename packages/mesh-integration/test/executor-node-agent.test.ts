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
import { signAssignmentLease, type MeshEnvelopeSigner, type MeshEnvelopeVerifier } from "../../mesh-auth/src/index";
import {
	canonicalExecutorToolPermission,
	ExecutorHttpCodeGateway,
	ExecutorMeshExecutionPort,
	type ExecutorHttpTransport,
	type ExecutorHttpTransportRequest,
	type ExecutorHttpTransportResponse,
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
const ASSIGNMENT_SIGNATURE_ALGORITHM = "executor-node-test-signature-v1";
const ASSIGNMENT_SIGNATURE_KEY_ID = "executor-node-test-scheduler-key";
const signatureEncoder = new TextEncoder();
const signatureDecoder = new TextDecoder();

interface TaskFixtureOptions {
	readonly permissions?: JsonRecord;
}

class RecordingExecutorTransport implements ExecutorHttpTransport {
	readonly requests: ExecutorHttpTransportRequest[] = [];
	readonly #response: ExecutorHttpTransportResponse;

	constructor(response: ExecutorHttpTransportResponse) {
		this.#response = response;
	}

	async send(request: ExecutorHttpTransportRequest): Promise<ExecutorHttpTransportResponse> {
		this.requests.push(request);
		return this.#response;
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
function assignment(task: TaskContractV1): AssignmentLeaseV1 {
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

function assignmentSignature(payload: Uint8Array): Uint8Array {
	return signatureEncoder.encode(`${ASSIGNMENT_SIGNATURE_ALGORITHM}:${ASSIGNMENT_SIGNATURE_KEY_ID}:${signatureDecoder.decode(payload).split("").reverse().join("")}`);
}

const schedulerSigner: MeshEnvelopeSigner = Object.freeze({
	algorithm: ASSIGNMENT_SIGNATURE_ALGORITHM,
	keyId: ASSIGNMENT_SIGNATURE_KEY_ID,
	actorPubkey: SCHEDULER_PUBKEY,
	role: "scheduler",
	sign: assignmentSignature,
});

const schedulerVerifier: MeshEnvelopeVerifier = Object.freeze({
	algorithm: ASSIGNMENT_SIGNATURE_ALGORITHM,
	keyId: ASSIGNMENT_SIGNATURE_KEY_ID,
	actorPubkey: SCHEDULER_PUBKEY,
	role: "scheduler",
	verify(payload, signature) {
		const expected = assignmentSignature(payload);
		return expected.byteLength === signature.byteLength && expected.every((value, index) => value === signature[index]);
	},
});

async function signedDelivery(input: AssignmentLeaseV1) {
	return signAssignmentLease(input, schedulerSigner, { signedAt: at(-250) });
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

function response(value: unknown): ExecutorHttpTransportResponse {
	return Object.freeze({
		ok: true,
		status: 200,
		json: async () => value,
	});
}

function createAgent(transport: ExecutorHttpTransport): MeshNodeAgent {
	return new MeshNodeAgent({
		identity: { nodeId: NODE_ID, pubkey: NODE_PUBKEY },
		execution: new ExecutorMeshExecutionPort({
			gateway: new ExecutorHttpCodeGateway({
				endpoints: [{ endpointId: ENDPOINT_ID, origin: "http://127.0.0.1:4788", authorization: "Bearer integration-host-token" }],
				transport,
			}),
			trustedEndpoints: [{ endpointId: ENDPOINT_ID, catalogFingerprint: CATALOG_FINGERPRINT }],
		}),
		trustedSchedulerVerifiers: [schedulerVerifier],
		getPresence: healthyPresence,
		now: () => T0,
	});
}

describe("Executor through the MeshNodeAgent boundary", () => {
	test("admits a digest-bound lease before sending exactly one canonical Executor HTTP request", async () => {
		const transport = new RecordingExecutorTransport(response({ status: "completed", text: "completed", structured: {}, isError: false }));
		const agent = createAgent(transport);
		const task = signedTask();
		const assigned = assignment(task);

		await expect(agent.accept({ task, signedAssignment: await signedDelivery(assigned) })).resolves.toMatchObject({ type: "assignment.accepted", state: "admitted" });
		expect(transport.requests).toHaveLength(0);

		await expect(agent.start(assigned.assignmentId)).resolves.toMatchObject({ type: "execution.started", state: "started" });
		expect(transport.requests).toHaveLength(0);

		await expect(agent.run(assigned.assignmentId)).resolves.toMatchObject({
			type: "execution.completed",
			state: "completed",
			outcome: "succeeded",
		});
		expect(transport.requests).toHaveLength(1);

		const request = transport.requests[0];
		expect(request).toMatchObject({
			method: "POST",
			url: "http://127.0.0.1:4788/api/executions",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				authorization: "Bearer integration-host-token",
			},
		});
		expect(JSON.parse(request?.body ?? "")).toEqual({
			code: 'return await tools.github.issues.create({"labels":["executor","mesh"],"owner":"kingkillery","repo":"localmesh","title":"Create the bounded integration fixture"});',
		});
		expect(request?.body).not.toContain(task.goal);
		expect(request?.body).not.toContain(RAW_PAYLOAD);
		expect(request?.body).not.toContain("autoApprove");
	});

	test("blocks a wildcard permission before the Executor gateway is contacted", async () => {
		const transport = new RecordingExecutorTransport(response({ status: "completed", text: "completed", structured: {}, isError: false }));
		const agent = createAgent(transport);
		const task = signedTask({
			permissions: { tools: ["executor:localExecutor:tools.github.issues.*"], externalSideEffects: "approval_required" },
		});
		const assigned = assignment(task);

		await agent.accept({ task, signedAssignment: await signedDelivery(assigned) });
		await expect(agent.start(assigned.assignmentId)).rejects.toMatchObject({ code: "execution_adapter_failed" });
		expect(agent.state(assigned.assignmentId)).toBe("reconciliation_required");
		expect(agent.assignmentEvents(assigned.assignmentId).at(-1)).toMatchObject({
			type: "execution.start_failed",
			state: "reconciliation_required",
			code: "execution_adapter_failed",
		});
		expect(agent.outbox()).toHaveLength(0);
		expect(transport.requests).toHaveLength(0);
	});

	test("turns an Executor approval pause into reconciliation-required state without automatic resume", async () => {
		const transport = new RecordingExecutorTransport(response({ status: "paused", text: "approval required", structured: { executionId: "pause-001" } }));
		const agent = createAgent(transport);
		const task = signedTask();
		const assigned = assignment(task);

		await agent.accept({ task, signedAssignment: await signedDelivery(assigned) });
		await agent.start(assigned.assignmentId);
		await expect(agent.run(assigned.assignmentId)).rejects.toMatchObject({ code: "execution_adapter_failed" });
		expect(agent.state(assigned.assignmentId)).toBe("reconciliation_required");
		expect(agent.assignmentEvents(assigned.assignmentId).at(-1)).toMatchObject({
			type: "execution.failed",
			state: "reconciliation_required",
			code: "execution_adapter_failed",
		});
		expect(agent.outbox()).toHaveLength(0);


		await expect(agent.run(assigned.assignmentId)).rejects.toMatchObject({ code: "assignment_reconciliation_required" });
		expect(transport.requests).toHaveLength(1);
		expect(transport.requests[0]?.body).not.toContain("autoApprove");
		expect(transport.requests[0]?.body).not.toContain("pause-001");
	});
});
