import { describe, expect, test } from "bun:test";

import { MESH_SCHEMA, parseTaskContract, sha256CanonicalJson, type TaskContractV1 } from "@pk-nerdsaver-ai/mesh-contracts";
import { verifySignedAssignmentLease, type MeshEnvelopeSigner, type MeshEnvelopeVerifier } from "@pk-nerdsaver-ai/mesh-auth";
import {
	FencingViolationError,
	InMemoryMeshRuntimeRepository,
	MeshOrchestrator,
	SchedulerLeaseConflictError,
	WorkerCapacityConflictError,
	WorkerCapacityObservationError,
	type MeshRuntimeRepository,
} from "@pk-nerdsaver-ai/mesh-orchestrator";

import { MeshSchedulerIssuanceCoordinator, type SchedulerIssuanceRequest } from "../src/index";
import type { PlacementNode } from "../src/placement";

const T0 = Date.parse("2026-08-31T12:00:00.000Z");
const SCHEDULER = "s".repeat(64);
const OTHER_SCHEDULER = "x".repeat(64);
const WORKER = "w".repeat(64);
const signatureEncoder = new TextEncoder();
const signatureDecoder = new TextDecoder();

function at(now: number): string {
	return new Date(now).toISOString();
}

function signature(payload: Uint8Array): Uint8Array {
	return signatureEncoder.encode(`scheduler-issuance:${signatureDecoder.decode(payload).split("").reverse().join("")}`);
}

const signer: MeshEnvelopeSigner = Object.freeze({
	algorithm: "scheduler-issuance-test-v1",
	keyId: "scheduler-issuance-key",
	actorPubkey: SCHEDULER,
	role: "scheduler",
	sign: signature,
});

const verifier: MeshEnvelopeVerifier = Object.freeze({
	algorithm: signer.algorithm,
	keyId: signer.keyId,
	actorPubkey: signer.actorPubkey,
	role: "scheduler",
	verify(payload, signed) {
		const expected = signature(payload);
		return expected.byteLength === signed.byteLength && expected.every((value, index) => value === signed[index]);
	},
});

function task(overrides: Partial<Record<string, unknown>> = {}): TaskContractV1 {
	const body = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_scheduler-issuance-001",
		createdAt: at(T0),
		requester: { pubkey: "h".repeat(64), role: "human" },
		goal: "Issue one safe durable assignment.",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "issued", description: "A verified worker lease is issued.", level: "required" }],
		permissions: { tools: ["fixture.run"], externalSideEffects: "none" },
		execution: { profileId: "scheduler-fixture-v1", timeoutSeconds: 60 },
		routing: { requiredCapabilities: ["container"], trustZoneMin: "private", activeMachineAllowed: false },
		artifactPolicy: { encryptionRequired: true },
		idempotencyKey: "scheduler-issuance-task-001",
		digestAlgorithm: "sha256" as const,
		...overrides,
	};
	return parseTaskContract({ ...body, digest: sha256CanonicalJson(body) });
}

function node(overrides: Partial<PlacementNode> = {}): PlacementNode {
	return {
		nodeId: "node_scheduler-worker-001",
		actorPubkey: WORKER,
		trustZone: "private",
		observedAt: at(T0),
		expiresAt: at(T0 + 120_000),
		interactive: false,
		activeInteractiveUser: false,
		draining: false,
		healthy: true,
		capabilities: ["container"],
		executionProfiles: ["scheduler-fixture-v1"],
		availableSlots: 1,
		cpuPressure: 0.1,
		memoryPressure: 0.1,
		estimatedCostUsd: 0,
		...overrides,
	};
}

function request(overrides: Partial<SchedulerIssuanceRequest> = {}): SchedulerIssuanceRequest {
	return {
		assignmentId: "asg_scheduler-issuance-001",
		taskId: "task_scheduler-issuance-001",
		nodes: [node()],
		schedulerLeaseDurationMs: 70_000,
		assignmentLeaseDurationMs: 65_000,
		renewAfterSeconds: 10,
		...overrides,
	};
}

function createRuntime(repository: MeshRuntimeRepository, now: () => number): MeshOrchestrator {
	return new MeshOrchestrator(repository, {
		receiptVerifierResolver: { resolve: () => undefined },
		clock: { nowEpochMs: now },
	});
}

function coordinator(
	runtime: MeshOrchestrator,
	now: () => number,
	inputSigner: MeshEnvelopeSigner = signer,
	inputVerifier: MeshEnvelopeVerifier = verifier,
): MeshSchedulerIssuanceCoordinator {
	return new MeshSchedulerIssuanceCoordinator({ runtime, signer: inputSigner, verifier: inputVerifier, clock: { nowEpochMs: now } });
}

async function issuedOutboxCount(repository: InMemoryMeshRuntimeRepository): Promise<number> {
	return repository.read(snapshot => Object.values(snapshot.outbox).filter(message => message.type === "assignment.issued").length);
}

describe("MeshSchedulerIssuanceCoordinator", () => {
	test("issues one safe, durable, scheduler-signed assignment", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task(), now);
		const result = await coordinator(runtime, () => now).issue(
			request({
				nodes: [node({ nodeId: "node_active-main-001", interactive: true, activeInteractiveUser: true }), node()],
			}),
		);

		expect(result.replayed).toBeFalse();
		expect(result.record.state).toBe("leased");
		expect(result.signedAssignment.payload).toMatchObject({
			assignmentId: "asg_scheduler-issuance-001",
			workerNodeId: "node_scheduler-worker-001",
			executorPubkey: WORKER,
			scheduler: { pubkey: SCHEDULER, role: "scheduler" },
			placementReason: { selectedNodeId: "node_scheduler-worker-001" },
		});
		const verified = await verifySignedAssignmentLease(result.signedAssignment, verifier);
		expect(verified.ok).toBeTrue();
		expect((await runtime.getTask("task_scheduler-issuance-001"))?.state).toBe("leased");
		expect((await runtime.getAssignment("asg_scheduler-issuance-001"))?.lease).toEqual(result.record.lease);
		expect(await issuedOutboxCount(repository)).toBe(1);
	});

	test("fails before scheduler authority mutation when no candidate or execution profile is issuable", async () => {
		let now = T0;
		const noCandidateRepository = new InMemoryMeshRuntimeRepository();
		const noCandidateRuntime = createRuntime(noCandidateRepository, () => now);
		await noCandidateRuntime.submitTask(task(), now);
		await expect(coordinator(noCandidateRuntime, () => now).issue(request({ nodes: [node({ availableSlots: 0 })] }))).rejects.toMatchObject({ code: "no_eligible_node" });
		expect(await noCandidateRepository.read(snapshot => snapshot.scheduler.ownerId)).toBeUndefined();
		expect(await issuedOutboxCount(noCandidateRepository)).toBe(0);

		const profileRepository = new InMemoryMeshRuntimeRepository();
		const profileRuntime = createRuntime(profileRepository, () => now);
		await profileRuntime.submitTask(task({ execution: {} }), now);
		await expect(coordinator(profileRuntime, () => now).issue(request())).rejects.toMatchObject({ code: "execution_profile_required" });
		expect(await profileRepository.read(snapshot => snapshot.scheduler.ownerId)).toBeUndefined();
		expect(await issuedOutboxCount(profileRepository)).toBe(0);
	});

	test("rejects a ticket lease that would outlive its scheduler authority", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task(), now);

		await expect(
			coordinator(runtime, () => now).issue(request({ schedulerLeaseDurationMs: 20_000, assignmentLeaseDurationMs: 20_000 })),
		).rejects.toMatchObject({ code: "lease_policy_invalid" });
		expect(await repository.read(snapshot => snapshot.scheduler.ownerId)).toBeUndefined();
		expect(await issuedOutboxCount(repository)).toBe(0);
	});

	test("requires a ticket lease that covers the declared execution bound", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task(), now);

		await expect(
			coordinator(runtime, () => now).issue(request({ schedulerLeaseDurationMs: 70_000, assignmentLeaseDurationMs: 60_000 })),
		).rejects.toMatchObject({ code: "lease_policy_invalid" });
		expect(await repository.read(snapshot => snapshot.scheduler.ownerId)).toBeUndefined();
		expect(await issuedOutboxCount(repository)).toBe(0);
	});

	test("requires an explicit bounded execution time before issuing a ticket", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task({ execution: { profileId: "scheduler-fixture-v1" } }), now);

		await expect(coordinator(runtime, () => now).issue(request())).rejects.toMatchObject({ code: "execution_timeout_required" });
		expect(await repository.read(snapshot => snapshot.scheduler.ownerId)).toBeUndefined();
		expect(await issuedOutboxCount(repository)).toBe(0);
	});

	test("does not write a durable assignment when signing fails", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task(), now);
		const failingSigner: MeshEnvelopeSigner = Object.freeze({ ...signer, sign: () => { throw new Error("offline_signer"); } });

		await expect(coordinator(runtime, () => now, failingSigner).issue(request())).rejects.toMatchObject({ code: "signing_failed" });
		expect(await runtime.getAssignment("asg_scheduler-issuance-001")).toBeUndefined();
		expect(await issuedOutboxCount(repository)).toBe(0);
	});

	test("does not persist a nonempty signature rejected by the trusted verifier", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task(), now);
		const wrongSigner: MeshEnvelopeSigner = Object.freeze({
			...signer,
			sign: () => signatureEncoder.encode("not-the-scheduler-signature"),
		});

		await expect(coordinator(runtime, () => now, wrongSigner).issue(request())).rejects.toMatchObject({ code: "signature_unverified" });
		expect(await runtime.getAssignment("asg_scheduler-issuance-001")).toBeUndefined();
		expect(await issuedOutboxCount(repository)).toBe(0);
	});

	test("fails closed when signing outlives the ticket's safe execution window", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task(), now);
		const delayedSigner: MeshEnvelopeSigner = Object.freeze({
			...signer,
			sign(payload) {
				now += 65_002;
				return signature(payload);
			},
		});

		await expect(
			coordinator(runtime, () => now, delayedSigner).issue(request({ schedulerLeaseDurationMs: 65_001, nodes: [node({ expiresAt: at(T0 + 200_000) })] })),
		).rejects.toMatchObject({ code: "assignment_lease_insufficient" });
		expect(await runtime.getAssignment("asg_scheduler-issuance-001")).toBeUndefined();
		expect(await issuedOutboxCount(repository)).toBe(0);
	});

	test("re-signs and replays the authoritative lease without issuing a second fact", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task(), now);
		const issuer = coordinator(runtime, () => now);
		const first = await issuer.issue(request());
		now += 1_000;
		const replay = await issuer.issue(request({ nodes: [] }));

		expect(replay.replayed).toBeTrue();
		expect(replay.record.lease).toEqual(first.record.lease);
		expect(replay.signedAssignment.payload).toEqual(first.signedAssignment.payload);
		expect((await verifySignedAssignmentLease(replay.signedAssignment, verifier)).ok).toBeTrue();
		expect(await issuedOutboxCount(repository)).toBe(1);
		await expect(issuer.issue(request({ assignmentId: "asg_scheduler-issuance-other" }))).rejects.toMatchObject({ code: "task_not_queued" });
		expect(await issuedOutboxCount(repository)).toBe(1);
	});

	test("does not re-sign a recovered lease after its worker reports zero capacity", async () => {
		let now = T0;
		let signCalls = 0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task(), now);
		const countingSigner: MeshEnvelopeSigner = Object.freeze({
			...signer,
			sign(payload) {
				signCalls += 1;
				return signature(payload);
			},
		});
		const issuer = coordinator(runtime, () => now, countingSigner);
		await issuer.issue(request());
		now += 1;

		await expect(issuer.issue(request({ nodes: [node({ availableSlots: 0, observedAt: at(now) })] }))).rejects.toBeInstanceOf(WorkerCapacityConflictError);
		expect(signCalls).toBe(1);
		expect(await repository.read(snapshot => snapshot.workerCapacityObservations["node_scheduler-worker-001"]?.availableSlots)).toBe(0);
		expect(await issuedOutboxCount(repository)).toBe(1);
	});

	test("never re-signs or mutates authority after leadership has turned over", async () => {
		let now = T0;
		let signCalls = 0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task({ execution: { profileId: "scheduler-fixture-v1", timeoutSeconds: 10 } }), now);
		const countingSigner: MeshEnvelopeSigner = Object.freeze({
			...signer,
			sign(payload) {
				signCalls += 1;
				return signature(payload);
			},
		});
		const issuer = coordinator(runtime, () => now, countingSigner);
		await issuer.issue(request());
		await repository.transaction(({ snapshot }) => {
			snapshot.scheduler.ownerId = OTHER_SCHEDULER;
			snapshot.scheduler.epoch += 1;
			snapshot.scheduler.leaseExpiresAt = now + 30_000;
		});
		const authorityBeforeRetry = await repository.read(snapshot => structuredClone(snapshot.scheduler));

		await expect(issuer.issue(request({ nodes: [] }))).rejects.toBeInstanceOf(SchedulerLeaseConflictError);
		expect(signCalls).toBe(1);
		expect(await repository.read(snapshot => snapshot.scheduler)).toEqual(authorityBeforeRetry);
		expect(await issuedOutboxCount(repository)).toBe(1);
	});

	test("rechecks node presence after acquiring authority and refuses a stale target", async () => {
		let clockReads = 0;
		let signCalls = 0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => T0);
		await runtime.submitTask(task(), T0);
		const countingSigner: MeshEnvelopeSigner = Object.freeze({
			...signer,
			sign(payload) {
				signCalls += 1;
				return signature(payload);
			},
		});
		const issuer = coordinator(runtime, () => (clockReads++ === 0 ? T0 : T0 + 2), countingSigner);

		await expect(issuer.issue(request({ nodes: [node({ expiresAt: at(T0 + 1) })] }))).rejects.toMatchObject({ code: "no_eligible_node" });
		expect(signCalls).toBe(0);
		expect(await runtime.getAssignment("asg_scheduler-issuance-001")).toBeUndefined();
		expect(await issuedOutboxCount(repository)).toBe(0);
	});

	test("does not commit a ticket when its target becomes stale during signing", async () => {
		let now = T0;
		let signCalls = 0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task({ execution: { profileId: "scheduler-fixture-v1", timeoutSeconds: 10 } }), now);
		const delayedSigner: MeshEnvelopeSigner = Object.freeze({
			...signer,
			sign(payload) {
				signCalls += 1;
				now += 2;
				return signature(payload);
			},
		});

		await expect(
			coordinator(runtime, () => now, delayedSigner).issue(request({ nodes: [node({ expiresAt: at(T0 + 1) })] })),
		).rejects.toMatchObject({ code: "no_eligible_node" });
		expect(signCalls).toBe(1);
		expect(await runtime.getAssignment("asg_scheduler-issuance-001")).toBeUndefined();
		expect(await issuedOutboxCount(repository)).toBe(0);
	});

	test("does not commit a ticket that loses its declared execution window during signing", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task(), now);
		const delayedSigner: MeshEnvelopeSigner = Object.freeze({
			...signer,
			sign(payload) {
				now += 5_001;
				return signature(payload);
			},
		});

		await expect(
			coordinator(runtime, () => now, delayedSigner).issue(request({ nodes: [node({ expiresAt: at(T0 + 120_000) })] })),
		).rejects.toMatchObject({ code: "assignment_lease_insufficient" });
		expect(await runtime.getAssignment("asg_scheduler-issuance-001")).toBeUndefined();
		expect(await issuedOutboxCount(repository)).toBe(0);
	});

	test("requires a selected node presence window that covers the declared execution bound", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task(), now);

		await expect(
			coordinator(runtime, () => now).issue(request({ nodes: [node({ expiresAt: at(T0 + 60_000) })] })),
		).rejects.toMatchObject({ code: "presence_window_insufficient" });
		expect(await runtime.getAssignment("asg_scheduler-issuance-001")).toBeUndefined();
		expect(await issuedOutboxCount(repository)).toBe(0);
	});

	test("refuses to sign when elapsed placement work erodes the remaining authority window", async () => {
		let clockReads = 0;
		let signCalls = 0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => T0);
		await runtime.submitTask(task(), T0);
		const countingSigner: MeshEnvelopeSigner = Object.freeze({
			...signer,
			sign(payload) {
				signCalls += 1;
				return signature(payload);
			},
		});
		const issuer = coordinator(runtime, () => (clockReads++ === 0 ? T0 : T0 + 10_001), countingSigner);

		await expect(issuer.issue(request())).rejects.toMatchObject({ code: "scheduler_lease_insufficient" });
		expect(signCalls).toBe(0);
		expect(await runtime.getAssignment("asg_scheduler-issuance-001")).toBeUndefined();
		expect(await issuedOutboxCount(repository)).toBe(0);
	});

	test("rejects cross-task stable ID reuse before it can renew scheduler authority", async () => {
		let now = T0;
		let signCalls = 0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task(), now);
		const countingSigner: MeshEnvelopeSigner = Object.freeze({
			...signer,
			sign(payload) {
				signCalls += 1;
				return signature(payload);
			},
		});
		const issuer = coordinator(runtime, () => now, countingSigner);
		await issuer.issue(request());
		const secondTask = task({ taskId: "task_scheduler-issuance-002", idempotencyKey: "scheduler-issuance-task-002" });
		await runtime.submitTask(secondTask, now);
		const authorityBeforeReuse = await repository.read(snapshot => structuredClone(snapshot.scheduler));

		await expect(issuer.issue(request({ taskId: secondTask.taskId }))).rejects.toMatchObject({ code: "recovery_assignment_mismatch" });
		expect(signCalls).toBe(1);
		expect(await repository.read(snapshot => snapshot.scheduler)).toEqual(authorityBeforeReuse);
		expect((await runtime.getTask(secondTask.taskId))?.state).toBe("queued");
		expect(await issuedOutboxCount(repository)).toBe(1);
	});

	test("transactionally reserves the selected worker's durable capacity", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		const secondTask = task({ taskId: "task_scheduler-issuance-002", idempotencyKey: "scheduler-issuance-task-002" });
		const thirdTask = task({ taskId: "task_scheduler-issuance-003", idempotencyKey: "scheduler-issuance-task-003" });
		await runtime.submitTask(task(), now);
		await runtime.submitTask(secondTask, now);
		await runtime.submitTask(thirdTask, now);
		const issuer = coordinator(runtime, () => now);
		const twoSlotNode = node({ availableSlots: 2 });

		await issuer.issue(request({ nodes: [twoSlotNode] }));
		await issuer.issue(request({ assignmentId: "asg_scheduler-issuance-002", taskId: secondTask.taskId, nodes: [twoSlotNode] }));
		await expect(
			issuer.issue(request({ assignmentId: "asg_scheduler-issuance-003", taskId: thirdTask.taskId, nodes: [twoSlotNode] })),
		).rejects.toBeInstanceOf(WorkerCapacityConflictError);

		expect(await repository.read(snapshot => Object.values(snapshot.assignments).filter(record => record.state === "leased"))).toHaveLength(2);
		expect((await runtime.getTask(thirdTask.taskId))?.state).toBe("queued");
		expect(await issuedOutboxCount(repository)).toBe(2);
	});

	test("uses the current durable capacity when presence falls during signing", async () => {
		let now = T0;
		let signCalls = 0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		const secondTask = task({ taskId: "task_scheduler-issuance-002", idempotencyKey: "scheduler-issuance-task-002" });
		await runtime.submitTask(task(), now);
		await runtime.submitTask(secondTask, now);
		const changingNodes: PlacementNode[] = [node({ availableSlots: 2 })];
		const changingSigner: MeshEnvelopeSigner = Object.freeze({
			...signer,
			sign(payload) {
				signCalls += 1;
				if (signCalls === 2) {
					now += 1;
					changingNodes[0] = node({ availableSlots: 1, observedAt: at(now) });
				}
				return signature(payload);
			},
		});
		const issuer = coordinator(runtime, () => now, changingSigner);
		await issuer.issue(request({ nodes: changingNodes }));

		await expect(
			issuer.issue(request({ assignmentId: "asg_scheduler-issuance-002", taskId: secondTask.taskId, nodes: changingNodes })),
		).rejects.toBeInstanceOf(WorkerCapacityConflictError);
		expect(await repository.read(snapshot => Object.values(snapshot.assignments).filter(record => record.state === "leased"))).toHaveLength(1);
		expect((await runtime.getTask(secondTask.taskId))?.state).toBe("queued");
		expect(await issuedOutboxCount(repository)).toBe(1);
	});

	test("does not let an older larger advertisement reopen durable worker capacity", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		const secondTask = task({ taskId: "task_scheduler-issuance-002", idempotencyKey: "scheduler-issuance-task-002" });
		const thirdTask = task({ taskId: "task_scheduler-issuance-003", idempotencyKey: "scheduler-issuance-task-003" });
		await runtime.submitTask(task(), now);
		await runtime.submitTask(secondTask, now);
		await runtime.submitTask(thirdTask, now);
		const issuer = coordinator(runtime, () => now);
		const initialTwoSlots = node({ availableSlots: 2, observedAt: at(T0), expiresAt: at(T0 + 120_000) });

		await issuer.issue(request({ nodes: [initialTwoSlots] }));
		now += 1;
		const newerOneSlot = node({ availableSlots: 1, observedAt: at(now), expiresAt: at(T0 + 120_000) });
		await expect(
			issuer.issue(request({ assignmentId: "asg_scheduler-issuance-002", taskId: secondTask.taskId, nodes: [newerOneSlot] })),
		).rejects.toBeInstanceOf(WorkerCapacityConflictError);
		expect(
			await repository.read(snapshot => snapshot.workerCapacityObservations[initialTwoSlots.nodeId]),
		).toEqual({ actorPubkey: WORKER, availableSlots: 1, observedAt: now, expiresAt: T0 + 120_000 });

		await expect(
			issuer.issue(request({ assignmentId: "asg_scheduler-issuance-003", taskId: thirdTask.taskId, nodes: [initialTwoSlots] })),
		).rejects.toEqual(new WorkerCapacityObservationError("capacity_observation_stale"));
		expect(await repository.read(snapshot => Object.values(snapshot.assignments).filter(record => record.state === "leased"))).toHaveLength(1);
		expect((await runtime.getTask(thirdTask.taskId))?.state).toBe("queued");
		expect(await issuedOutboxCount(repository)).toBe(1);
	});

	test("does not sign an expired recovered assignment even while scheduler authority remains current", async () => {
		let now = T0;
		let signCalls = 0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task({ execution: { profileId: "scheduler-fixture-v1", timeoutSeconds: 10 } }), now);
		const countingSigner: MeshEnvelopeSigner = Object.freeze({
			...signer,
			sign(payload) {
				signCalls += 1;
				return signature(payload);
			},
		});
		const issuer = coordinator(runtime, () => now, countingSigner);
		await issuer.issue(request({ schedulerLeaseDurationMs: 30_000, assignmentLeaseDurationMs: 11_000, renewAfterSeconds: 10 }));
		const authorityBeforeRetry = await repository.read(snapshot => structuredClone(snapshot.scheduler));
		now += 11_001;

		await expect(issuer.issue(request({ nodes: [], schedulerLeaseDurationMs: 30_000, assignmentLeaseDurationMs: 11_000, renewAfterSeconds: 10 }))).rejects.toBeInstanceOf(
			FencingViolationError,
		);
		expect(signCalls).toBe(1);
		expect(await repository.read(snapshot => snapshot.scheduler)).toEqual(authorityBeforeRetry);
		expect(await issuedOutboxCount(repository)).toBe(1);
	});

	test("concurrent issuers with divergent clocks return the one durable signed lease", async () => {
		const leftNow = T0;
		const rightNow = T0 + 250;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => rightNow);
		await runtime.submitTask(task(), leftNow);
		const [first, second] = await Promise.all([
			coordinator(runtime, () => leftNow).issue(request()),
			coordinator(runtime, () => rightNow).issue(request()),
		]);

		expect(first.record.lease).toEqual(second.record.lease);
		expect(first.signedAssignment.payload).toEqual(second.signedAssignment.payload);
		expect(await runtime.getAssignment("asg_scheduler-issuance-001")).toMatchObject({ state: "leased", lease: first.record.lease });
		expect(await issuedOutboxCount(repository)).toBe(1);
	});

	test("refreshes zero capacity before replay after losing the stable-ID issuance race", async () => {
		let now = T0;
		let reads = 0;
		let leftSignCalls = 0;
		let rightSignCalls = 0;
		const backing = new InMemoryMeshRuntimeRepository();
		const replayReadEntered = Promise.withResolvers<void>();
		const releaseReplayRead = Promise.withResolvers<void>();
		const repository: MeshRuntimeRepository = {
			read<T>(select) {
				reads += 1;
				if (reads !== 3) return backing.read(select);
				return (async () => {
					replayReadEntered.resolve();
					await releaseReplayRead.promise;
					return backing.read(select);
				})();
			},
			transaction<T>(operation) {
				return backing.transaction(operation);
			},
		};
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task(), now);
		const leftSigner: MeshEnvelopeSigner = Object.freeze({
			...signer,
			sign(payload) {
				leftSignCalls += 1;
				return signature(payload);
			},
		});
		const rightSigner: MeshEnvelopeSigner = Object.freeze({
			...signer,
			sign(payload) {
				rightSignCalls += 1;
				return signature(payload);
			},
		});
		const leftNodes: PlacementNode[] = [node()];
		const left = coordinator(runtime, () => now, leftSigner).issue(request({ nodes: leftNodes }));
		await replayReadEntered.promise;
		now += 1;
		leftNodes[0] = node({ availableSlots: 0, observedAt: at(now) });

		await coordinator(runtime, () => now, rightSigner).issue(request({ nodes: [node()] }));
		releaseReplayRead.resolve();
		await expect(left).rejects.toBeInstanceOf(WorkerCapacityConflictError);
		expect(leftSignCalls).toBe(0);
		expect(rightSignCalls).toBe(1);
		expect(await backing.read(snapshot => snapshot.workerCapacityObservations["node_scheduler-worker-001"]?.availableSlots)).toBe(0);
		expect(await issuedOutboxCount(backing)).toBe(1);
	});

	test("snapshots signer identity instead of retaining a mutable adapter reference", async () => {
		let now = T0;
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = createRuntime(repository, () => now);
		await runtime.submitTask(task(), now);
		const mutableSigner = {
			algorithm: signer.algorithm,
			keyId: signer.keyId,
			actorPubkey: SCHEDULER,
			role: "scheduler" as const,
			sign: signature,
		};
		const issuer = coordinator(runtime, () => now, mutableSigner);
		mutableSigner.actorPubkey = OTHER_SCHEDULER;

		const result = await issuer.issue(request());
		expect(result.record.lease.scheduler.pubkey).toBe(SCHEDULER);
		expect(result.signedAssignment.signature.actorPubkey).toBe(SCHEDULER);
	});

});
