import { describe, expect, test } from "bun:test";

import {
	MESH_SCHEMA,
	contractDigest,
	parseAssignmentLease,
	parseEvidenceRecord,
	parseTaskContract,
	sha256CanonicalJson,
	type JsonRecord,
} from "../../mesh-contracts/src/index";
import { InMemoryContentAddressedStore, createArtifactManifest } from "../../mesh-artifacts/src/index";
import { verifyEvidenceChain } from "../../mesh-evidence/src/index";
import { InMemoryDurableEventLog } from "../../mesh-eventbus/src/index";
import { InMemoryMeshRuntimeRepository, MeshOrchestrator, type ReceiptVerifierResolver } from "../../mesh-orchestrator/src/index";
import { signExecutionReceipt, verifySignedExecutionReceipt, type ReceiptSignatureVerifier } from "../../mesh-receipts/src/index";
import { placeTask, type PlacementNode } from "../../mesh-scheduler/src/index";
import { createOmpkExecutionAdapter } from "../../mesh-worker-sdk/src/index";

const T0 = Date.parse("2026-08-31T12:00:00.000Z");
const SCHEDULER = "s".repeat(64);
const WORKER = "w".repeat(64);
const NODE = "node_linux-worker-001";
const signatureEncoder = new TextEncoder();
const signatureDecoder = new TextDecoder();

function at(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

function signedTask() {
	const body = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_first-slice-001",
		createdAt: at(0),
		requester: { pubkey: "h".repeat(64), role: "human" },
		goal: "Run the harmless first-slice fixture.",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "fixture-output", description: "result.json is stored and verified.", level: "required" }],
		permissions: { tools: ["fixture.run"], externalSideEffects: "none" },
		execution: { profileId: "linux-test-v1", timeoutSeconds: 60 },
		routing: { requiredCapabilities: ["container", "isolated"], trustZoneMin: "private", activeMachineAllowed: false },
		artifactPolicy: { encryptionRequired: true, retentionClass: "ephemeral" },
		idempotencyKey: "first-slice-submit-001",
		digestAlgorithm: "sha256" as const,
	};
	return parseTaskContract({ ...body, digest: contractDigest(body as unknown as JsonRecord, "digest") });
}

function node(overrides: Partial<PlacementNode> = {}): PlacementNode {
	return {
		nodeId: NODE,
		actorPubkey: WORKER,
		trustZone: "private",
		observedAt: at(0),
		expiresAt: at(3_600_000),
		interactive: false,
		activeInteractiveUser: false,
		draining: false,
		healthy: true,
		capabilities: ["container", "isolated"],
		executionProfiles: ["linux-test-v1"],
		availableSlots: 1,
		cpuPressure: 0.1,
		memoryPressure: 0.1,
		estimatedCostUsd: 0,
		...overrides,
	};
}

function fixtureSignature(payload: Uint8Array): Uint8Array {
	return signatureEncoder.encode(`fixture-worker:${signatureDecoder.decode(payload)}`);
}

const receiptVerifier: ReceiptSignatureVerifier = Object.freeze({
	algorithm: "fixture-deterministic-v1",
	keyId: "fixture-worker",
	verify: (payload: Uint8Array, signature: Uint8Array) => signatureDecoder.decode(signature) === signatureDecoder.decode(fixtureSignature(payload)),
});

const receiptVerifierResolver: ReceiptVerifierResolver = Object.freeze({
	resolve(lease) {
		if (lease.executorPubkey !== WORKER || lease.workerNodeId !== NODE) return undefined;
		return receiptVerifier;
	},
});

describe("LocalMesh first vertical slice", () => {
	test("moves a harmless fixture from signed task to receipt without using an active computer", async () => {
		const task = signedTask();
		const runtime = new MeshOrchestrator(new InMemoryMeshRuntimeRepository(), {
			receiptVerifierResolver,
			clock: { nowEpochMs: () => T0 + 5 },
		});
		const cas = new InMemoryContentAddressedStore();
		const eventLog = new InMemoryDurableEventLog();
		await runtime.submitTask(task, T0);

		const placement = placeTask({
			task,
			nodes: [node({ nodeId: "node_active-main-001", interactive: true, activeInteractiveUser: true }), node()],
			nowEpochMs: T0,
		});
		expect(placement.selectedNodeId).toBe(NODE);

		const scheduler = await runtime.acquireSchedulerLease({ schedulerId: SCHEDULER, durationMs: 30_000, now: T0 });
		const assignment = parseAssignmentLease({
			schemaVersion: MESH_SCHEMA.assignment,
			assignmentId: "asg_first-slice-001",
			taskId: task.taskId,
			taskDigest: task.digest,
			scheduler: { pubkey: SCHEDULER, role: "scheduler" },
			schedulerEpoch: scheduler.epoch,
			fencingToken: 1,
			workerNodeId: NODE,
			executorPubkey: WORKER,
			executionProfileId: "linux-test-v1",
			issuedAt: at(1),
			leaseExpiresAt: at(20_000),
			renewAfterSeconds: 10,
			permissionsDigest: sha256CanonicalJson(task.permissions),
			placementReason: { selectedNodeId: NODE, reason: "eligible_capability_match" },
			idempotencyKey: "first-slice-assignment-001",
		});
		await runtime.assign({ assignment, now: T0 + 1 });

		const adapter = createOmpkExecutionAdapter(
			{
				async execute() {
					const bytes = new TextEncoder().encode('{"result":"ok"}\n');
					const blob = await cas.put(bytes);
					return {
						outcome: "succeeded" as const,
						summary: "fixture completed",
						artifactIds: ["art_first-slice-result"],
						evidenceIds: ["evd_first-slice-result"],
						metadata: { contentSha256: blob.sha256 },
					};
				},
			},
			{ nodeId: NODE, executorPubkey: WORKER },
		);
		const execution = await adapter.execute({ task, assignment, nowEpochMs: T0 + 2 }, new AbortController().signal);
		const contentSha256 = execution.metadata?.contentSha256;
		expect(typeof contentSha256).toBe("string");

		const artifact = createArtifactManifest({
			artifactId: "art_first-slice-result",
			taskId: task.taskId,
			createdAt: at(3),
			createdBy: { pubkey: WORKER, role: "worker", nodeId: NODE },
			name: "result.json",
			contentType: "application/json",
			sizeBytes: 16,
			contentSha256: contentSha256 as string,
			encryption: { required: true },
			locations: [{ type: "local-cas", uri: `cas://${contentSha256}` }],
			retention: { class: "ephemeral" },
			safety: { classification: "fixture" },
		});
		expect((await cas.get(artifact.contentSha256))?.byteLength).toBe(16);

		const evidenceBody = {
			schemaVersion: MESH_SCHEMA.evidence,
			evidenceId: "evd_first-slice-result",
			taskId: task.taskId,
			criterionIds: ["fixture-output"],
			createdAt: at(4),
			createdBy: { pubkey: WORKER, role: "worker", nodeId: NODE },
			claim: "The fixture result was stored in local CAS.",
			sourceType: "artifact",
			sourceReference: { artifactId: artifact.artifactId, contentSha256: artifact.contentSha256 },
			confidence: "direct" as const,
		};
		const evidence = parseEvidenceRecord({ ...evidenceBody, digest: contractDigest(evidenceBody as unknown as JsonRecord, "digest") });
		const receiptBody = {
			schemaVersion: MESH_SCHEMA.receipt,
			receiptId: "rcpt_first-slice-001",
			taskId: task.taskId,
			taskDigest: task.digest,
			assignmentId: assignment.assignmentId,
			schedulerEpoch: scheduler.epoch,
			fencingToken: 1,
			worker: { pubkey: WORKER, role: "worker", nodeId: NODE },
			nodeId: NODE,
			startedAt: at(2),
			endedAt: at(5),
			outcome: "succeeded" as const,
			execution: { profileId: "linux-test-v1", command: "fixture.run" },
			artifacts: [artifact.artifactId],
			evidence: [evidence.evidenceId],
			validation: { outcome: "passed" },
			resourceUsage: { cpuMilliseconds: 1 },
			cost: { usd: 0 },
			cleanup: { workspace: "not-created", worker: "released" },
		};
		const receipt = { ...receiptBody, receiptHash: contractDigest(receiptBody as unknown as JsonRecord, "receiptHash") };
		const signedReceipt = await signExecutionReceipt(receipt, {
			algorithm: "fixture-deterministic-v1",
			keyId: "fixture-worker",
			sign: fixtureSignature,
		});
		const signatureVerification = await verifySignedExecutionReceipt(signedReceipt, {
			algorithm: "fixture-deterministic-v1",
			keyId: "fixture-worker",
			verify: (payload, signature) => signatureDecoder.decode(signature) === signatureDecoder.decode(fixtureSignature(payload)),
		});
		expect(signatureVerification.ok).toBe(true);
		await runtime.recordReceipt({ signedReceipt });

		const evidenceChain = await verifyEvidenceChain({
			task,
			evidence: [evidence],
			receipts: [signedReceipt],
			receiptAuthority: {
				resolve(assignmentId) {
					return assignmentId === assignment.assignmentId ? Object.freeze({ assignment, verifier: receiptVerifier }) : undefined;
				},
			},
		});
		expect(evidenceChain.ok).toBe(true);
		expect((await runtime.getTask(task.taskId))?.state).toBe("completed");

		const published = await runtime.drainOutbox(
			{
				async publish(message) {
					const payload = { type: message.type, aggregateId: message.aggregateId, ...message.payload } as JsonRecord;
					await eventLog.append({
						envelope: {
							schemaVersion: MESH_SCHEMA.event,
							eventId: `evt_${message.outboxId.replace(/[^A-Za-z0-9._:-]/g, "_")}`,
							type: message.type,
							occurredAt: at(6),
							actor: { pubkey: SCHEDULER, role: "scheduler" },
							idempotencyKey: message.idempotencyKey,
							payloadEncoding: "json",
							payload,
							payloadSha256: sha256CanonicalJson(payload),
						} as never,
						provenance: { transport: "local", receivedAt: at(6), verification: "not_applicable", sourceNodeId: NODE },
					});
				},
			},
			{ now: T0 + 6 },
		);
		expect(published.published).toHaveLength(3);
		expect((await eventLog.listByType("receipt.recorded")).length).toBe(1);
	});
});
