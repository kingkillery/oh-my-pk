import { describe, expect, test } from "bun:test";

import { MESH_SCHEMA, parseTaskContract, sha256CanonicalJson, type TaskContractV1 } from "../../mesh-contracts/src/index";
import { type MeshEnvelopeSigner, type MeshEnvelopeVerifier } from "../../mesh-auth/src/index";
import { InMemoryMeshRuntimeRepository, MeshOrchestrator } from "../../mesh-orchestrator/src/index";
import { MeshNodeAgent, type MeshExecutionRunResult, type MeshNodeExecutionContext } from "../../mesh-node/src/index";
import { MeshSchedulerIssuanceCoordinator, type PlacementNode } from "../../mesh-scheduler/src/index";

const T0 = Date.parse("2026-08-31T12:00:00.000Z");
const SCHEDULER = "s".repeat(64);
const WORKER = "w".repeat(64);
const NODE = "node_scheduler-integration-001";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function at(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

function signature(payload: Uint8Array): Uint8Array {
	return encoder.encode(`scheduler-integration:${decoder.decode(payload).split("").reverse().join("")}`);
}

const schedulerSigner: MeshEnvelopeSigner = Object.freeze({
	algorithm: "scheduler-integration-v1",
	keyId: "scheduler-integration-key",
	actorPubkey: SCHEDULER,
	role: "scheduler",
	sign: signature,
});

const schedulerVerifier: MeshEnvelopeVerifier = Object.freeze({
	algorithm: schedulerSigner.algorithm,
	keyId: schedulerSigner.keyId,
	actorPubkey: schedulerSigner.actorPubkey,
	role: "scheduler",
	verify(payload, signed) {
		const expected = signature(payload);
		return expected.byteLength === signed.byteLength && expected.every((value, index) => value === signed[index]);
	},
});

function task(): TaskContractV1 {
	const body = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_scheduler-integration-001",
		createdAt: at(0),
		requester: { pubkey: "h".repeat(64), role: "human" },
		goal: "Deliver one scheduler-issued lease only to the safe worker.",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "admitted", description: "The safe node admits the signed assignment.", level: "required" }],
		permissions: { tools: ["fixture.run"], externalSideEffects: "none" },
		execution: { profileId: "scheduler-integration-v1", timeoutSeconds: 60 },
		routing: { requiredCapabilities: ["container"], trustZoneMin: "private", activeMachineAllowed: false },
		artifactPolicy: { encryptionRequired: true },
		idempotencyKey: "scheduler-integration-task-001",
		digestAlgorithm: "sha256" as const,
	};
	return parseTaskContract({ ...body, digest: sha256CanonicalJson(body) });
}

function placementNode(overrides: Partial<PlacementNode> = {}): PlacementNode {
	return {
		nodeId: NODE,
		actorPubkey: WORKER,
		trustZone: "private",
		observedAt: at(0),
		expiresAt: at(120_000),
		interactive: false,
		activeInteractiveUser: false,
		draining: false,
		healthy: true,
		capabilities: ["container"],
		executionProfiles: ["scheduler-integration-v1"],
		availableSlots: 1,
		cpuPressure: 0.1,
		memoryPressure: 0.1,
		estimatedCostUsd: 0,
		...overrides,
	};
}

function nodeAgent(): MeshNodeAgent {
	const execution = Object.freeze({
		async start(_context: MeshNodeExecutionContext): Promise<void> {},
		async run(_context: MeshNodeExecutionContext): Promise<MeshExecutionRunResult> {
			return Object.freeze({ outcome: "succeeded" });
		},
		async heartbeat(_context: MeshNodeExecutionContext): Promise<void> {},
		async cancel(_context: MeshNodeExecutionContext): Promise<void> {},
		async cleanup(_context: MeshNodeExecutionContext): Promise<void> {},
	});
	return new MeshNodeAgent({
		identity: { nodeId: NODE, pubkey: WORKER },
		execution,
		trustedSchedulerVerifiers: [schedulerVerifier],
		now: () => T0,
		getPresence: () =>
			Object.freeze({
				nodeId: NODE,
				actorPubkey: WORKER,
				trustZone: "private",
				observedAt: at(0),
				expiresAt: at(120_000),
				interactive: false,
				activeInteractiveUser: false,
				draining: false,
				health: "healthy" as const,
				capabilities: ["container"],
				executionProfiles: ["scheduler-integration-v1"],
				capacity: { totalSlots: 1, availableSlots: 1, cpuPressure: 0.1, memoryPressure: 0.1 },
				profileVersion: "fixture",
			}),
	});
}

describe("scheduler issuance through node admission", () => {
	test("selects a safe node, persists one lease, and delivers a verifier-bound envelope", async () => {
		const repository = new InMemoryMeshRuntimeRepository();
		const runtime = new MeshOrchestrator(repository, {
			receiptVerifierResolver: { resolve: () => undefined },
			clock: { nowEpochMs: () => T0 },
		});
		const contract = task();
		await runtime.submitTask(contract, T0);
		const issuer = new MeshSchedulerIssuanceCoordinator({ runtime, signer: schedulerSigner, verifier: schedulerVerifier, clock: { nowEpochMs: () => T0 } });
		const issued = await issuer.issue({
			assignmentId: "asg_scheduler-integration-001",
			taskId: contract.taskId,
			nodes: [placementNode({ nodeId: "node_active-main-001", interactive: true, activeInteractiveUser: true }), placementNode()],
			schedulerLeaseDurationMs: 70_000,
			assignmentLeaseDurationMs: 65_000,
			renewAfterSeconds: 10,
		});
		const admitted = await nodeAgent().accept({ task: contract, signedAssignment: issued.signedAssignment });

		expect(issued.record.lease.workerNodeId).toBe(NODE);
		expect(admitted).toMatchObject({ assignmentId: issued.record.lease.assignmentId, state: "admitted" });
		expect(await repository.read(snapshot => Object.values(snapshot.assignments))).toEqual([issued.record]);
		expect(await repository.read(snapshot => Object.values(snapshot.outbox).filter(message => message.type === "assignment.issued"))).toHaveLength(1);
	});
});
