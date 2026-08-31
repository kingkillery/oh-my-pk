import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import {
	MeshNodeAgent,
	projectNodeAdvertisement,
	SqliteMeshNodeStateRepository,
	type MeshNodePresence,
	type MeshNodeTerminalOutboxPublication,
} from "../../mesh-node/src/index";

const T0 = Date.parse("2026-08-31T12:00:00.000Z");
const NODE_ID = "node_executor-durable-recovery-001";
const NODE_PUBKEY = "n".repeat(64);
const SCHEDULER_PUBKEY = "s".repeat(64);
const ENDPOINT_ID = "localExecutor";
const CATALOG_FINGERPRINT = "c".repeat(64);
const TOOL_PATH = ["github", "issues", "create"] as const;
const SIGNATURE_ALGORITHM = "executor-durable-recovery-signature-v1";
const SIGNATURE_KEY_ID = "executor-durable-recovery-scheduler-key";
const signatureEncoder = new TextEncoder();
const signatureDecoder = new TextDecoder();

class AmbiguousExecutorTransport implements ExecutorHttpTransport {
	readonly requests: ExecutorHttpTransportRequest[] = [];

	async send(request: ExecutorHttpTransportRequest): Promise<ExecutorHttpTransportResponse> {
		this.requests.push(request);
		throw new Error("executor_request_may_have_been_accepted");
	}
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

function createDatabasePath(): { readonly directory: string; readonly path: string } {
	const directory = mkdtempSync(join(tmpdir(), "mesh-executor-durable-recovery-"));
	return { directory, path: join(directory, "node.sqlite") };
}

function response(value: unknown): ExecutorHttpTransportResponse {
	return Object.freeze({
		ok: true,
		status: 200,
		json: async () => value,
	});
}

function signedTask(): TaskContractV1 {
	const args = {
		labels: ["executor", "mesh"],
		owner: "kingkillery",
		repo: "localmesh",
		title: "Prove durable recovery of an Executor request.",
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
		taskId: "task_executor-durable-recovery-001",
		createdAt: at(-1_000),
		requester: { pubkey: "r".repeat(64), role: "human" },
		goal: "Prove durable recovery of a bounded Executor request.",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "safe-recovery", description: "Ambiguous remote work remains reconciled.", level: "required" }],
		permissions: {
			tools: [canonicalExecutorToolPermission(ENDPOINT_ID, TOOL_PATH)],
			externalSideEffects: "approval_required",
		},
		execution: { profileId: "executor-mcp-v1", timeoutSeconds: 30 },
		executorInvocation: invocation,
		routing: { requiredCapabilities: ["executor.mcp"], trustZoneMin: "private", activeMachineAllowed: false },
		artifactPolicy: {},
		idempotencyKey: "executor-durable-recovery-task-001",
		digestAlgorithm: "sha256" as const,
	};
	return parseTaskContract({ ...body, digest: contractDigest(body as unknown as JsonRecord, "digest") });
}

function assignment(task: TaskContractV1, overrides: Record<string, unknown> = {}): AssignmentLeaseV1 {
	return parseAssignmentLease({
		schemaVersion: MESH_SCHEMA.assignment,
		assignmentId: "asg_executor-durable-recovery-001",
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
		placementReason: { selectedNodeId: NODE_ID, reason: "durable_executor_recovery" },
		idempotencyKey: "executor-durable-recovery-assignment-001",
		...overrides,
	});
}

function assignmentSignature(payload: Uint8Array): Uint8Array {
	return signatureEncoder.encode(`${SIGNATURE_ALGORITHM}:${SIGNATURE_KEY_ID}:${signatureDecoder.decode(payload).split("").reverse().join("")}`);
}

const schedulerSigner: MeshEnvelopeSigner = Object.freeze({
	algorithm: SIGNATURE_ALGORITHM,
	keyId: SIGNATURE_KEY_ID,
	actorPubkey: SCHEDULER_PUBKEY,
	role: "scheduler",
	sign: assignmentSignature,
});

const schedulerVerifier: MeshEnvelopeVerifier = Object.freeze({
	algorithm: SIGNATURE_ALGORITHM,
	keyId: SIGNATURE_KEY_ID,
	actorPubkey: SCHEDULER_PUBKEY,
	role: "scheduler",
	verify(payload, signature) {
		const expected = assignmentSignature(payload);
		return expected.byteLength === signature.byteLength && expected.every((value, index) => value === signature[index]);
	},
});

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
			profileVersion: "executor-durable-recovery-node-v1",
		}),
	);
}

function createAgent(repository: SqliteMeshNodeStateRepository, transport: ExecutorHttpTransport): Promise<MeshNodeAgent> {
	return MeshNodeAgent.create({
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
		stateRepository: repository,
	});
}

async function signedDelivery(input: AssignmentLeaseV1) {
	return signAssignmentLease(input, schedulerSigner, { signedAt: at(-250) });
}

describe("Executor durable recovery through the MeshNodeAgent boundary", () => {
	test("persists an ambiguous Executor POST as reconciliation across SQLite reopen without rerun or terminal release", async () => {
		const database = createDatabasePath();
		let firstRepository: SqliteMeshNodeStateRepository | undefined;
		let reopenedRepository: SqliteMeshNodeStateRepository | undefined;
		let finalRepository: SqliteMeshNodeStateRepository | undefined;
		try {
			const transport = new AmbiguousExecutorTransport();
			const task = signedTask();
			const assigned = assignment(task);
			const signedAssignment = await signedDelivery(assigned);
			firstRepository = new SqliteMeshNodeStateRepository(database.path);
			const first = await createAgent(firstRepository, transport);

			const admission = await first.accept({ task, signedAssignment });
			const preCloseCompeting = assignment(task, {
				assignmentId: "asg_executor-durable-recovery-capacity-preclose",
				idempotencyKey: "executor-durable-recovery-capacity-preclose",
			});
			await expect(first.accept({ task, signedAssignment: await signedDelivery(preCloseCompeting) })).rejects.toMatchObject({ code: "capacity_exhausted" });
			await first.start(assigned.assignmentId);
			await expect(first.run(assigned.assignmentId)).rejects.toMatchObject({ code: "execution_adapter_failed" });
			expect(first.state(assigned.assignmentId)).toBe("reconciliation_required");
			expect(first.outbox()).toHaveLength(0);
			expect(transport.requests).toMatchObject([{ method: "POST", url: "http://127.0.0.1:4788/api/executions" }]);
			firstRepository.close();
			firstRepository = undefined;

			reopenedRepository = new SqliteMeshNodeStateRepository(database.path);
			const reopened = await createAgent(reopenedRepository, transport);
			expect(reopened.state(assigned.assignmentId)).toBe("reconciliation_required");
			expect(reopened.outbox()).toHaveLength(0);
			expect(reopened.assignmentEvents(assigned.assignmentId).filter(event => event.type === "execution.failed")).toHaveLength(1);

			await expect(reopened.accept({ task, signedAssignment })).resolves.toEqual(admission);
			expect(reopened.state(assigned.assignmentId)).toBe("reconciliation_required");
			expect(reopened.assignmentEvents(assigned.assignmentId).filter(event => event.type === "assignment.accepted")).toHaveLength(1);
			expect(transport.requests).toHaveLength(1);
			const altered = assignment(task, { leaseExpiresAt: at(55_000) });
			await expect(reopened.accept({ task, signedAssignment: await signedDelivery(altered) })).rejects.toMatchObject({ code: "assignment_already_known" });
			expect(reopened.state(assigned.assignmentId)).toBe("reconciliation_required");
			expect(reopened.assignmentEvents(assigned.assignmentId).filter(event => event.type === "assignment.accepted")).toHaveLength(1);
			expect(transport.requests).toHaveLength(1);
			await expect(reopened.run(assigned.assignmentId)).rejects.toMatchObject({ code: "assignment_reconciliation_required" });
			expect(transport.requests).toHaveLength(1);
			const second = assignment(task, {
				assignmentId: "asg_executor-durable-recovery-capacity-002",
				idempotencyKey: "executor-durable-recovery-capacity-002",
			});
			await expect(reopened.accept({ task, signedAssignment: await signedDelivery(second) })).rejects.toMatchObject({ code: "capacity_exhausted" });
			expect(transport.requests).toHaveLength(1);

			const resolved = reopened.resolveReconciliationAsLost(assigned.assignmentId);
			expect(resolved).toMatchObject({
				type: "execution.reconciliation_resolved_as_lost",
				state: "lost",
				code: "assignment_reconciliation_required",
			});
			expect(reopened.resolveReconciliationAsLost(assigned.assignmentId)).toBe(resolved);
			expect(reopened.assignmentEvents(assigned.assignmentId).filter(event => event.type === "execution.reconciliation_resolved_as_lost")).toHaveLength(1);
			expect(reopened.outbox()).toHaveLength(1);
			const cleaned = await reopened.cleanup(assigned.assignmentId);
			expect(cleaned).toMatchObject({ type: "execution.cleaned", state: "cleaned" });
			await expect(reopened.cleanup(assigned.assignmentId)).resolves.toBe(cleaned);
			expect(reopened.assignmentEvents(assigned.assignmentId).filter(event => event.type === "execution.cleaned")).toHaveLength(1);
			expect(transport.requests).toHaveLength(1);
			await expect(reopened.accept({ task, signedAssignment: await signedDelivery(second) })).resolves.toMatchObject({ type: "assignment.accepted", state: "admitted" });

			const published: MeshNodeTerminalOutboxPublication[] = [];
			const delivery = await reopened.drainTerminalOutbox({
				async publish(message) {
					published.push(structuredClone(message));
				},
			});
			expect(delivery).toEqual({ delivered: [`node-terminal:${assigned.assignmentId}:23:41`], failed: [] });
			expect(published).toHaveLength(1);
			expect(reopened.outbox()).toMatchObject([{ state: "delivered", record: resolved }]);
			reopenedRepository.close();
			reopenedRepository = undefined;

			finalRepository = new SqliteMeshNodeStateRepository(database.path);
			const final = await createAgent(finalRepository, transport);
			const afterRestart = await final.drainTerminalOutbox({
				async publish() {
					throw new Error("a delivered terminal fact must not be republished");
				},
			});
			expect(afterRestart).toEqual({ delivered: [], failed: [] });
			expect(final.outbox()).toHaveLength(1);
			expect(final.outbox()).toMatchObject([{ state: "delivered", record: resolved }]);
			expect(final.assignmentEvents(assigned.assignmentId).filter(event => event.type === "execution.reconciliation_resolved_as_lost")).toHaveLength(1);
			expect(transport.requests).toHaveLength(1);
		} finally {
			finalRepository?.close();
			reopenedRepository?.close();
			firstRepository?.close();
			rmSync(database.directory, { recursive: true, force: true });
		}
	});

	test("keeps an explicit completed/isError Executor result as a durable terminal failure with an outbox fact", async () => {
		const database = createDatabasePath();
		let firstRepository: SqliteMeshNodeStateRepository | undefined;
		let reopenedRepository: SqliteMeshNodeStateRepository | undefined;
		try {
			const transport = new RecordingExecutorTransport(response({ status: "completed", text: "failed", structured: {}, isError: true }));
			const task = signedTask();
			const assigned = assignment(task);
			firstRepository = new SqliteMeshNodeStateRepository(database.path);
			const first = await createAgent(firstRepository, transport);

			await first.accept({ task, signedAssignment: await signedDelivery(assigned) });
			await first.start(assigned.assignmentId);
			await expect(first.run(assigned.assignmentId)).resolves.toMatchObject({
				type: "execution.failed",
				state: "failed",
				outcome: "failed",
			});
			expect(first.outbox()).toMatchObject([{ record: { type: "execution.failed", state: "failed", outcome: "failed" } }]);
			expect(transport.requests).toHaveLength(1);
			firstRepository.close();
			firstRepository = undefined;

			reopenedRepository = new SqliteMeshNodeStateRepository(database.path);
			const reopenedTransport = new RecordingExecutorTransport(response({ status: "completed", text: "completed", structured: {}, isError: false }));
			const reopened = await createAgent(reopenedRepository, reopenedTransport);
			expect(reopened.state(assigned.assignmentId)).toBe("failed");
			expect(reopened.outbox()).toMatchObject([{ record: { type: "execution.failed", state: "failed", outcome: "failed" } }]);
			expect(reopenedTransport.requests).toHaveLength(0);
		} finally {
			reopenedRepository?.close();
			firstRepository?.close();
			rmSync(database.directory, { recursive: true, force: true });
		}
	});
});
