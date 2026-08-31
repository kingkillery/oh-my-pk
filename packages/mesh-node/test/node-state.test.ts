import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	MESH_SCHEMA,
	parseAssignmentLease,
	parseNodeAdvertisement,
	parseTaskContract,
	sha256CanonicalJson,
	type AssignmentLeaseV1,
	type TaskContractV1,
} from "@pk-nerdsaver-ai/mesh-contracts";
import { signAssignmentLease, type MeshEnvelopeSigner, type MeshEnvelopeVerifier } from "@pk-nerdsaver-ai/mesh-auth";
import {
	MeshNodeAgent,
	MeshNodeAgentError,
	MeshNodeStateCorruptionError,
	InMemoryMeshNodeStateRepository,
	projectNodeAdvertisement,
	SqliteMeshNodeStateRepository,
	type MeshExecutionRunResult,
	type MeshNodeExecutionContext,
	type MeshNodeExecutionPort,
	type MeshNodePresence,
	type MeshNodeStateRepository,
	type MeshNodeStateSnapshot,
	type MeshNodeStateTransaction,
} from "../src";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const NODE_ID = "node_durable-001";
const NODE_PUBKEY = "n".repeat(64);
const SCHEDULER_PUBKEY = "s".repeat(64);
const SIGNATURE_ALGORITHM = "node-state-test-signature-v1";
const SIGNATURE_KEY_ID = "node-state-test-scheduler-key";
const signatureEncoder = new TextEncoder();
const signatureDecoder = new TextDecoder();

interface ExecutionCalls {
	start: number;
	run: number;
	cancel: number;
	cleanup: number;
}

interface StoredAssignmentSnapshot {
	bounds?: {
		timeoutSeconds: number;
	};
	signedAssignment: {
		signature: {
			signatureBase64: string;
		};
	};
}

interface StoredNodeSnapshot {
	assignments: Record<string, StoredAssignmentSnapshot>;
}

function createDatabasePath(): { readonly directory: string; readonly path: string } {
	const directory = mkdtempSync(join(tmpdir(), "mesh-node-state-"));
	return { directory, path: join(directory, "node.sqlite") };
}

function makeTask(overrides: Record<string, unknown> = {}): TaskContractV1 {
	const unsigned = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_node-state-001",
		createdAt: "2026-08-31T11:59:00.000Z",
		requester: { pubkey: "r".repeat(64), role: "human" },
		goal: "Run a bounded durable-node task.",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "criterion-1", description: "Exit safely.", level: "required" }],
		permissions: { tools: ["safe.tool"], externalSideEffects: "none" },
		execution: { profileId: "safe-profile", timeoutSeconds: 30, cpuMax: 1, retriesMax: 0 },
		routing: { requiredCapabilities: ["safe.tool"], trustZoneMin: "private", activeMachineAllowed: false },
		artifactPolicy: {},
		idempotencyKey: "task-node-state-key",
		digestAlgorithm: "sha256",
		...overrides,
	};
	return parseTaskContract({ ...unsigned, digest: sha256CanonicalJson(unsigned) });
}

function makeAssignment(task: TaskContractV1, overrides: Record<string, unknown> = {}): AssignmentLeaseV1 {
	return parseAssignmentLease({
		schemaVersion: MESH_SCHEMA.assignment,
		assignmentId: "asg_node-state-001",
		taskId: task.taskId,
		taskDigest: task.digest,
		scheduler: { pubkey: SCHEDULER_PUBKEY, role: "scheduler" },
		schedulerEpoch: 1,
		fencingToken: 1,
		workerNodeId: NODE_ID,
		executorPubkey: NODE_PUBKEY,
		executionProfileId: "safe-profile",
		issuedAt: "2026-08-31T11:59:00.000Z",
		leaseExpiresAt: "2026-08-31T12:05:00.000Z",
		renewAfterSeconds: 15,
		permissionsDigest: sha256CanonicalJson(task.permissions),
		placementReason: { source: "test" },
		idempotencyKey: "assignment-node-state-key",
		...overrides,
	});
}

function signature(payload: Uint8Array): Uint8Array {
	return signatureEncoder.encode(`${SIGNATURE_ALGORITHM}:${SIGNATURE_KEY_ID}:${signatureDecoder.decode(payload).split("").reverse().join("")}`);
}

const schedulerVerifier: MeshEnvelopeVerifier = Object.freeze({
	algorithm: SIGNATURE_ALGORITHM,
	keyId: SIGNATURE_KEY_ID,
	actorPubkey: SCHEDULER_PUBKEY,
	role: "scheduler",
	verify(payload, signed) {
		const expected = signature(payload);
		return expected.byteLength === signed.byteLength && expected.every((value, index) => value === signed[index]);
	},
});

const schedulerSigner: MeshEnvelopeSigner = Object.freeze({
	algorithm: SIGNATURE_ALGORITHM,
	keyId: SIGNATURE_KEY_ID,
	actorPubkey: SCHEDULER_PUBKEY,
	role: "scheduler",
	sign: signature,
});

async function signedAssignment(assignment: AssignmentLeaseV1, signedAt = "2026-08-31T11:59:30.000Z") {
	return signAssignmentLease(assignment, schedulerSigner, { signedAt });
}

function makePresence(): MeshNodePresence {
	return projectNodeAdvertisement(
		parseNodeAdvertisement({
			schemaVersion: MESH_SCHEMA.node,
			nodeId: NODE_ID,
			actorPubkey: NODE_PUBKEY,
			generatedAt: "2026-08-31T11:59:00.000Z",
			expiresAt: "2026-08-31T12:10:00.000Z",
			trustZone: "private",
			interactive: false,
			draining: false,
			static: { totalSlots: 1 },
			dynamic: { availableSlots: 1, health: "healthy", activeInteractiveUser: false },
			capabilities: { names: ["safe.tool"], executionProfiles: ["safe-profile"] },
			reservations: {},
			profileVersion: "node-profile-1",
		}),
	);
}

function calls(): ExecutionCalls {
	return { start: 0, run: 0, cancel: 0, cleanup: 0 };
}

function makePort(
	executionCalls: ExecutionCalls,
	overrides: Partial<MeshNodeExecutionPort> = {},
): MeshNodeExecutionPort {
	return {
		async start(_context: MeshNodeExecutionContext) {
			executionCalls.start += 1;
		},
		async run(_context: MeshNodeExecutionContext): Promise<MeshExecutionRunResult> {
			executionCalls.run += 1;
			return { outcome: "succeeded", exitCode: 0 };
		},
		async heartbeat(_context: MeshNodeExecutionContext) {},
		async cancel(_context: MeshNodeExecutionContext) {
			executionCalls.cancel += 1;
		},
		async cleanup(_context: MeshNodeExecutionContext) {
			executionCalls.cleanup += 1;
		},
		...overrides,
	};
}

/** Makes a durable-write fault observable without ever calling an execution port. */
class FailingMeshNodeStateRepository implements MeshNodeStateRepository {
	readonly #delegate: MeshNodeStateRepository;
	#remainingFailures = 0;

	constructor(delegate: MeshNodeStateRepository) {
		this.#delegate = delegate;
	}

	failNextTransactions(count: number): void {
		this.#remainingFailures += count;
	}

	read<T>(select: (snapshot: MeshNodeStateSnapshot) => T): T {
		return this.#delegate.read(select);
	}

	transaction<T>(operation: (transaction: MeshNodeStateTransaction) => T): T {
		if (this.#remainingFailures > 0) {
			this.#remainingFailures -= 1;
			throw new Error("injected node-state transaction failure");
		}
		return this.#delegate.transaction(operation);
	}
}

function createAgent(repository: MeshNodeStateRepository, port: MeshNodeExecutionPort): Promise<MeshNodeAgent> {
	return MeshNodeAgent.create({
		identity: { nodeId: NODE_ID, pubkey: NODE_PUBKEY },
		execution: port,
		trustedSchedulerVerifiers: [schedulerVerifier],
		getPresence: makePresence,
		now: () => NOW,
		stateRepository: repository,
	});
}

describe("SqliteMeshNodeStateRepository", () => {
	test("fails closed instead of replacing a malformed durable snapshot", () => {
		const database = createDatabasePath();
		try {
			const repository = new SqliteMeshNodeStateRepository(database.path);
			repository.close();
			const raw = new Database(database.path, { create: false, readwrite: true, strict: true });
			raw.run("UPDATE mesh_node_state SET snapshot_json = ? WHERE singleton = 1", ["not-json"]);
			raw.close();

			expect(() => new SqliteMeshNodeStateRepository(database.path)).toThrow(MeshNodeStateCorruptionError);
		} finally {
			rmSync(database.directory, { recursive: true, force: true });
		}
	});

	test("persists an admitted reservation and deduplicates exact signed payloads after reopen", async () => {
		const database = createDatabasePath();
		try {
			const task = makeTask();
			const assignment = makeAssignment(task);
			const firstRepository = new SqliteMeshNodeStateRepository(database.path);
			const first = await createAgent(firstRepository, makePort(calls()));
			const admission = await first.accept({ task, signedAssignment: await signedAssignment(assignment) });
			firstRepository.close();

			const reopenedRepository = new SqliteMeshNodeStateRepository(database.path);
			const reopenedCalls = calls();
			const reopened = await createAgent(reopenedRepository, makePort(reopenedCalls));
			const duplicate = await reopened.accept({ task, signedAssignment: await signedAssignment(assignment, "2026-08-31T11:59:45.000Z") });
			expect(duplicate).toEqual(admission);
			expect(reopened.state(assignment.assignmentId)).toBe("admitted");
			expect(reopened.assignmentEvents(assignment.assignmentId).filter(event => event.type === "assignment.accepted")).toHaveLength(1);

			const conflicting = makeAssignment(task, { leaseExpiresAt: "2026-08-31T12:06:00.000Z" });
			await expect(reopened.accept({ task, signedAssignment: await signedAssignment(conflicting) })).rejects.toMatchObject({ code: "assignment_already_known" });
			const second = makeAssignment(task, { assignmentId: "asg_node-state-capacity-002", idempotencyKey: "assignment-node-state-capacity-002" });
			await expect(reopened.accept({ task, signedAssignment: await signedAssignment(second) })).rejects.toMatchObject({ code: "capacity_exhausted" });
			expect(reopenedCalls).toEqual({ start: 0, run: 0, cancel: 0, cleanup: 0 });
			reopenedRepository.close();
		} finally {
			rmSync(database.directory, { recursive: true, force: true });
		}
	});

	test("re-verifies a persisted scheduler signature before admitting a reopened assignment", async () => {
		const database = createDatabasePath();
		try {
			const task = makeTask();
			const assignment = makeAssignment(task);
			const firstRepository = new SqliteMeshNodeStateRepository(database.path);
			const first = await createAgent(firstRepository, makePort(calls()));
			await first.accept({ task, signedAssignment: await signedAssignment(assignment) });
			firstRepository.close();

			const raw = new Database(database.path, { create: false, readwrite: true, strict: true });
			const row = raw.query<{ readonly snapshotJson: string }, []>("SELECT snapshot_json AS snapshotJson FROM mesh_node_state WHERE singleton = 1").get();
			if (row === null || row === undefined) throw new Error("durable node state row is missing");
			const snapshot = JSON.parse(row.snapshotJson) as StoredNodeSnapshot;
			const signature = snapshot.assignments[assignment.assignmentId]?.signedAssignment.signature;
			if (signature === undefined) throw new Error("persisted signed assignment is missing");
			signature.signatureBase64 = `${signature.signatureBase64.startsWith("A") ? "B" : "A"}${signature.signatureBase64.slice(1)}`;
			raw.run("UPDATE mesh_node_state SET snapshot_json = ? WHERE singleton = 1", [JSON.stringify(snapshot)]);
			raw.close();

			const reopenedRepository = new SqliteMeshNodeStateRepository(database.path);
			await expect(createAgent(reopenedRepository, makePort(calls()))).rejects.toMatchObject({ code: "assignment_signature_unverified" });
			reopenedRepository.close();
		} finally {
			rmSync(database.directory, { recursive: true, force: true });
		}
	});

	test("derives execution bounds from the verified task instead of stored node state", async () => {
		const database = createDatabasePath();
		try {
			const task = makeTask();
			const assignment = makeAssignment(task);
			const firstRepository = new SqliteMeshNodeStateRepository(database.path);
			const first = await createAgent(firstRepository, makePort(calls()));
			await first.accept({ task, signedAssignment: await signedAssignment(assignment) });
			firstRepository.close();

			const raw = new Database(database.path, { create: false, readwrite: true, strict: true });
			const row = raw.query<{ readonly snapshotJson: string }, []>("SELECT snapshot_json AS snapshotJson FROM mesh_node_state WHERE singleton = 1").get();
			if (row === null || row === undefined) throw new Error("durable node state row is missing");
			const snapshot = JSON.parse(row.snapshotJson) as StoredNodeSnapshot;
			const stored = snapshot.assignments[assignment.assignmentId];
			if (stored === undefined) throw new Error("persisted assignment is missing");
			stored.bounds = { timeoutSeconds: 3_600 };
			raw.run("UPDATE mesh_node_state SET snapshot_json = ? WHERE singleton = 1", [JSON.stringify(snapshot)]);
			raw.close();

			let startContext: MeshNodeExecutionContext | undefined;
			const reopenedRepository = new SqliteMeshNodeStateRepository(database.path);
			const reopened = await createAgent(
				reopenedRepository,
				makePort(calls(), {
					async start(context) {
						startContext = context;
					},
				}),
			);
			await reopened.start(assignment.assignmentId);
			expect(startContext?.bounds).toEqual({ timeoutSeconds: 30, cpuMax: 1, retriesMax: 0 });
			reopenedRepository.close();
		} finally {
			rmSync(database.directory, { recursive: true, force: true });
		}
	});

	test("fails closed when a second stale node process tries to admit the same work", async () => {
		const database = createDatabasePath();
		try {
			const task = makeTask();
			const assignment = makeAssignment(task);
			const firstRepository = new SqliteMeshNodeStateRepository(database.path);
			const secondRepository = new SqliteMeshNodeStateRepository(database.path);
			const firstCalls = calls();
			const secondCalls = calls();
			const first = await createAgent(firstRepository, makePort(firstCalls));
			const second = await createAgent(secondRepository, makePort(secondCalls));
			const delivery = await signedAssignment(assignment);
			const results = await Promise.allSettled([
				first.accept({ task, signedAssignment: delivery }),
				second.accept({ task, signedAssignment: delivery }),
			]);
			expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
			const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
			expect(rejected?.reason).toMatchObject({ code: "node_state_conflict" });
			expect(firstCalls).toEqual({ start: 0, run: 0, cancel: 0, cleanup: 0 });
			expect(secondCalls).toEqual({ start: 0, run: 0, cancel: 0, cleanup: 0 });
			firstRepository.close();
			secondRepository.close();
		} finally {
			rmSync(database.directory, { recursive: true, force: true });
		}
	});

	test("commits start intent before the execution port and never replays an interrupted run", async () => {
		const database = createDatabasePath();
		try {
			const task = makeTask();
			const assignment = makeAssignment(task);
			const firstRepository = new SqliteMeshNodeStateRepository(database.path);
			const firstCalls = calls();
			let observedStartState: string | undefined;
			const runGate = Promise.withResolvers<MeshExecutionRunResult>();
			const firstPort = makePort(firstCalls, {
				async start() {
					firstCalls.start += 1;
					const probe = new SqliteMeshNodeStateRepository(database.path);
					observedStartState = probe.read(snapshot => snapshot.assignments[assignment.assignmentId]?.state);
					probe.close();
				},
				async run() {
					firstCalls.run += 1;
					return runGate.promise;
				},
			});
			const first = await createAgent(firstRepository, firstPort);
			await first.accept({ task, signedAssignment: await signedAssignment(assignment) });
			await first.start(assignment.assignmentId);
			expect(observedStartState).toBe("starting");
			const activeRun = first.run(assignment.assignmentId);
			await Promise.resolve();
			expect(first.state(assignment.assignmentId)).toBe("running");
			firstRepository.close();

			const recoveredRepository = new SqliteMeshNodeStateRepository(database.path);
			const recoveredCalls = calls();
			const recovered = await createAgent(recoveredRepository, makePort(recoveredCalls));
			expect(recovered.state(assignment.assignmentId)).toBe("reconciliation_required");
			expect(recovered.assignmentEvents(assignment.assignmentId).filter(event => event.type === "execution.reconciliation_required")).toHaveLength(1);
				expect(recovered.outbox()).toHaveLength(0);
				await expect(recovered.start(assignment.assignmentId)).rejects.toMatchObject({ code: "assignment_reconciliation_required" });
				expect(recoveredCalls).toEqual({ start: 0, run: 0, cancel: 0, cleanup: 0 });
				const resolved = recovered.resolveReconciliationAsLost(assignment.assignmentId);
				expect(resolved).toMatchObject({
					type: "execution.reconciliation_resolved_as_lost",
					state: "lost",
					code: "assignment_reconciliation_required",
				});
				expect(recovered.resolveReconciliationAsLost(assignment.assignmentId)).toBe(resolved);
				const next = makeAssignment(task, {
					assignmentId: "asg_node-state-reconciled-capacity-002",
					idempotencyKey: "assignment-node-state-reconciled-capacity-002",
				});
				await expect(recovered.accept({ task, signedAssignment: await signedAssignment(next) })).resolves.toMatchObject({ type: "assignment.accepted" });
				recoveredRepository.close();

				const reopenedRepository = new SqliteMeshNodeStateRepository(database.path);
				const reopened = await createAgent(reopenedRepository, makePort(calls()));
				expect(reopened.state(assignment.assignmentId)).toBe("lost");
				expect(reopened.assignmentEvents(assignment.assignmentId).filter(event => event.type === "execution.reconciliation_required")).toHaveLength(1);
				expect(reopened.assignmentEvents(assignment.assignmentId).filter(event => event.type === "execution.reconciliation_resolved_as_lost")).toHaveLength(1);
				expect(reopened.outbox()).toHaveLength(1);
				reopenedRepository.close();

			runGate.resolve({ outcome: "succeeded", exitCode: 0 });
			await expect(activeRun).rejects.toBeInstanceOf(MeshNodeAgentError);
		} finally {
			rmSync(database.directory, { recursive: true, force: true });
		}
	});

	test("quarantines a live node after post-port durable-write failures and resolves only as a local lost fact", async () => {
		const task = makeTask();
		const assignment = makeAssignment(task);
		const repository = new FailingMeshNodeStateRepository(new InMemoryMeshNodeStateRepository());
		const executionCalls = calls();
		let heartbeatCalls = 0;
		const first = await createAgent(
			repository,
			makePort(executionCalls, {
				async run() {
					executionCalls.run += 1;
					repository.failNextTransactions(2);
					return { outcome: "succeeded", exitCode: 0 };
				},
				async heartbeat() {
					heartbeatCalls += 1;
				},
			}),
		);
		await first.accept({ task, signedAssignment: await signedAssignment(assignment) });
		await first.start(assignment.assignmentId);

		await expect(first.run(assignment.assignmentId)).rejects.toMatchObject({ code: "assignment_reconciliation_required" });
		expect(first.state(assignment.assignmentId)).toBe("reconciliation_required");
		expect(first.outbox()).toHaveLength(0);
		await expect(first.heartbeat(assignment.assignmentId)).rejects.toMatchObject({ code: "assignment_reconciliation_required" });
		expect(() => first.cancel(assignment.assignmentId)).toThrow("assignment_reconciliation_required");
		await expect(first.start(assignment.assignmentId)).rejects.toMatchObject({ code: "assignment_reconciliation_required" });
		await expect(first.run(assignment.assignmentId)).rejects.toMatchObject({ code: "assignment_reconciliation_required" });
		expect(() => first.cleanup(assignment.assignmentId)).toThrow("assignment_reconciliation_required");
		expect(executionCalls).toEqual({ start: 1, run: 1, cancel: 0, cleanup: 0 });
		expect(heartbeatCalls).toBe(0);

		repository.failNextTransactions(1);
		expect(() => first.resolveReconciliationAsLost(assignment.assignmentId)).toThrow(MeshNodeAgentError);
		expect(first.state(assignment.assignmentId)).toBe("reconciliation_required");
		const next = makeAssignment(task, {
			assignmentId: "asg_node-state-after-reconciliation-002",
			idempotencyKey: "assignment-node-state-after-reconciliation-002",
		});
		await expect(first.accept({ task, signedAssignment: await signedAssignment(next) })).rejects.toMatchObject({ code: "capacity_exhausted" });

		const resolved = first.resolveReconciliationAsLost(assignment.assignmentId);
		expect(resolved).toMatchObject({
			type: "execution.reconciliation_resolved_as_lost",
			state: "lost",
			code: "assignment_reconciliation_required",
		});
		expect(resolved.outcome).toBeUndefined();
		expect(first.resolveReconciliationAsLost(assignment.assignmentId)).toBe(resolved);
		expect(first.outbox()).toMatchObject([
			{
				assignmentId: assignment.assignmentId,
				taskId: task.taskId,
				type: "node.lifecycle.terminal",
				record: { type: "execution.reconciliation_resolved_as_lost", state: "lost" },
			},
		]);
		await expect(first.accept({ task, signedAssignment: await signedAssignment(next) })).resolves.toMatchObject({ type: "assignment.accepted" });
	});

	test("persists reconciliation from the current assignment after one post-port terminal-write failure", async () => {
		const task = makeTask();
		const assignment = makeAssignment(task);
		const repository = new FailingMeshNodeStateRepository(new InMemoryMeshNodeStateRepository());
		const executionCalls = calls();
		let heartbeatCalls = 0;
		const agent = await createAgent(
			repository,
			makePort(executionCalls, {
				async run() {
					executionCalls.run += 1;
					repository.failNextTransactions(1);
					return { outcome: "succeeded", exitCode: 0 };
				},
				async heartbeat() {
					heartbeatCalls += 1;
				},
			}),
		);
		await agent.accept({ task, signedAssignment: await signedAssignment(assignment) });
		await agent.start(assignment.assignmentId);

		await expect(agent.run(assignment.assignmentId)).rejects.toMatchObject({ code: "assignment_reconciliation_required" });
		expect(agent.state(assignment.assignmentId)).toBe("reconciliation_required");
		expect(agent.assignmentEvents(assignment.assignmentId).at(-1)).toMatchObject({
			type: "execution.reconciliation_required",
			state: "reconciliation_required",
			code: "node_state_unavailable",
		});
		expect(agent.outbox()).toHaveLength(0);
		await expect(agent.heartbeat(assignment.assignmentId)).rejects.toMatchObject({ code: "assignment_reconciliation_required" });
		expect(heartbeatCalls).toBe(0);
	});

	test("does not emit a stale terminal fact when a concurrent start rollback races cancellation", async () => {
		const task = makeTask();
		const assignment = makeAssignment(task);
		const repository = new FailingMeshNodeStateRepository(new InMemoryMeshNodeStateRepository());
		const executionCalls = calls();
		const startGate = Promise.withResolvers<void>();
		const cancelGate = Promise.withResolvers<void>();
		const agent = await createAgent(
			repository,
			makePort(executionCalls, {
				async start() {
					executionCalls.start += 1;
					await startGate.promise;
				},
				async cancel() {
					executionCalls.cancel += 1;
					await cancelGate.promise;
				},
			}),
		);
		await agent.accept({ task, signedAssignment: await signedAssignment(assignment) });
		const starting = agent.start(assignment.assignmentId);
		await Promise.resolve();
		expect(agent.state(assignment.assignmentId)).toBe("starting");
		const cancelling = agent.cancel(assignment.assignmentId);
		await Promise.resolve();
		expect(agent.state(assignment.assignmentId)).toBe("cancelling");

		repository.failNextTransactions(1);
		startGate.reject(new Error("injected start failure"));
		await expect(starting).rejects.toMatchObject({ code: "execution_adapter_failed" });
		expect(agent.state(assignment.assignmentId)).toBe("reconciliation_required");
		cancelGate.resolve();
		await expect(cancelling).rejects.toMatchObject({ code: "assignment_reconciliation_required" });
		expect(agent.state(assignment.assignmentId)).toBe("reconciliation_required");
		expect(agent.assignmentEvents(assignment.assignmentId).filter(event => event.type === "execution.cancelled")).toHaveLength(0);
		expect(agent.outbox()).toHaveLength(0);

		const reopenedCalls = calls();
		const reopened = await createAgent(repository, makePort(reopenedCalls));
		expect(reopened.state(assignment.assignmentId)).toBe("reconciliation_required");
		expect(reopened.outbox()).toHaveLength(0);
		expect(() => reopened.cancel(assignment.assignmentId)).toThrow("assignment_reconciliation_required");
		expect(reopenedCalls).toEqual({ start: 0, run: 0, cancel: 0, cleanup: 0 });
	});

	test("retains exactly one durable terminal fact and outbox message across reopen", async () => {
		const database = createDatabasePath();
		try {
			const task = makeTask();
			const assignment = makeAssignment(task);
			const firstRepository = new SqliteMeshNodeStateRepository(database.path);
			const first = await createAgent(firstRepository, makePort(calls()));
			await first.accept({ task, signedAssignment: await signedAssignment(assignment) });
			await first.start(assignment.assignmentId);
			await first.run(assignment.assignmentId);
			const firstOutbox = first.outbox();
			expect(firstOutbox).toHaveLength(1);
			expect(firstOutbox[0]).toMatchObject({
				assignmentId: assignment.assignmentId,
				taskId: task.taskId,
				type: "node.lifecycle.terminal",
				idempotencyKey: `node.lifecycle.terminal:${assignment.assignmentId}:${assignment.schedulerEpoch}:${assignment.fencingToken}`,
				record: { type: "execution.completed", state: "completed", outcome: "succeeded" },
			});
			firstRepository.close();

			const reopenedRepository = new SqliteMeshNodeStateRepository(database.path);
			const reopened = await createAgent(reopenedRepository, makePort(calls()));
			expect(reopened.state(assignment.assignmentId)).toBe("completed");
			expect(reopened.outbox()).toEqual(firstOutbox);
			await reopened.accept({ task, signedAssignment: await signedAssignment(assignment, "2026-08-31T11:59:45.000Z") });
			expect(reopened.outbox()).toHaveLength(1);
			expect(reopened.assignmentEvents(assignment.assignmentId).filter(event => event.type === "execution.completed")).toHaveLength(1);
			reopenedRepository.close();
		} finally {
			rmSync(database.directory, { recursive: true, force: true });
		}
	});
});
