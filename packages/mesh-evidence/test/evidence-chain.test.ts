import { expect, test } from "bun:test";
import {
	MESH_SCHEMA,
	contractDigest,
	parseAssignmentLease,
	parseTaskContract,
	sha256CanonicalJson,
	type AssignmentLeaseV1,
	type JsonRecord,
	type TaskContractV1,
} from "@pk-nerdsaver-ai/mesh-contracts";
import { signExecutionReceipt, type ReceiptSignatureVerifier, type ReceiptSigner } from "@pk-nerdsaver-ai/mesh-receipts";

import { verifyEvidenceChain } from "../src";

const T0 = Date.parse("2026-08-31T12:00:00.000Z");
const HUMAN = "human-public-key-000001";
const WORKER = "worker-public-key-000001";
const SCHEDULER = "scheduler-public-key-000001";
const SIGNATURE_ALGORITHM = "test-deterministic-v1";
const SIGNATURE_KEY_ID = "evidence-worker-key";
const signatureEncoder = new TextEncoder();
const signatureDecoder = new TextDecoder();

function iso(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

function digest(value: Record<string, unknown>, field: string): string {
	return contractDigest(value as unknown as JsonRecord, field);
}

function task(): TaskContractV1 {
	const body = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_evidence-chain",
		createdAt: iso(0),
		requester: { pubkey: HUMAN, role: "human" },
		goal: "Verify receipt evidence",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "criterion-one", description: "A receipt references valid evidence", level: "required" }],
		permissions: { tools: ["test"], externalSideEffects: "none" },
		execution: {},
		routing: {},
		artifactPolicy: {},
		idempotencyKey: "evidence-task-001",
		digestAlgorithm: "sha256" as const,
	};
	return parseTaskContract({ ...body, digest: digest(body, "digest") });
}

function evidence(taskContract: TaskContractV1) {
	const body = {
		schemaVersion: MESH_SCHEMA.evidence,
		evidenceId: "evd_chain-proof",
		taskId: taskContract.taskId,
		criterionIds: ["criterion-one"],
		createdAt: iso(10),
		createdBy: { pubkey: WORKER, role: "worker", nodeId: "node_evidence-worker" },
		claim: "The execution completed under the current fence",
		sourceType: "test",
		sourceReference: { artifact: "art_chain-proof" },
		confidence: "direct" as const,
	};
	return { ...body, digest: digest(body, "digest") };
}

function assignment(taskContract: TaskContractV1): AssignmentLeaseV1 {
	return parseAssignmentLease({
		schemaVersion: MESH_SCHEMA.assignment,
		assignmentId: "asg_chain-one",
		taskId: taskContract.taskId,
		taskDigest: taskContract.digest,
		scheduler: { pubkey: SCHEDULER, role: "scheduler" },
		schedulerEpoch: 1,
		fencingToken: 1,
		workerNodeId: "node_evidence-worker",
		executorPubkey: WORKER,
		executionProfileId: "evidence-test",
		issuedAt: iso(0),
		leaseExpiresAt: iso(60_000),
		renewAfterSeconds: 30,
		permissionsDigest: sha256CanonicalJson(taskContract.permissions),
		placementReason: { source: "test" },
		idempotencyKey: "evidence-assignment-001",
	});
}

function signature(payload: Uint8Array, keyId = SIGNATURE_KEY_ID): Uint8Array {
	return signatureEncoder.encode(`${keyId}:${signatureDecoder.decode(payload)}`);
}

function signer(keyId = SIGNATURE_KEY_ID): ReceiptSigner {
	return Object.freeze({ algorithm: SIGNATURE_ALGORITHM, keyId, sign: (payload: Uint8Array) => signature(payload, keyId) });
}

function verifier(keyId = SIGNATURE_KEY_ID): ReceiptSignatureVerifier {
	return Object.freeze({
		algorithm: SIGNATURE_ALGORITHM,
		keyId,
		verify: (payload: Uint8Array, signed: Uint8Array) => signatureDecoder.decode(signed) === signatureDecoder.decode(signature(payload, keyId)),
	});
}

function receiptAuthority(lease: AssignmentLeaseV1, receiptVerifier = verifier()) {
	return Object.freeze({
		resolve: (assignmentId: string) => (assignmentId === lease.assignmentId ? Object.freeze({ assignment: lease, verifier: receiptVerifier }) : undefined),
	});
}

function receipt(
	taskContract: TaskContractV1,
	options?: { readonly previousReceiptHash?: string; readonly id?: string; readonly timeOffset?: number; readonly workerPubkey?: string; readonly nodeId?: string },
) {
	const timeOffset = options?.timeOffset ?? 20;
	const nodeId = options?.nodeId ?? "node_evidence-worker";
	const body = {
		schemaVersion: MESH_SCHEMA.receipt,
		receiptId: options?.id ?? "rcpt_chain-one",
		taskId: taskContract.taskId,
		taskDigest: taskContract.digest,
		assignmentId: "asg_chain-one",
		schedulerEpoch: 1,
		fencingToken: 1,
		worker: { pubkey: options?.workerPubkey ?? WORKER, role: "worker", nodeId },
		nodeId,
		startedAt: iso(timeOffset),
		endedAt: iso(timeOffset + 10),
		outcome: "succeeded" as const,
		execution: {},
		artifacts: [],
		evidence: ["evd_chain-proof"],
		validation: {},
		resourceUsage: {},
		cost: {},
		cleanup: {},
		...(options?.previousReceiptHash === undefined ? {} : { previousReceiptHash: options.previousReceiptHash }),
	};
	return { ...body, receiptHash: digest(body, "receiptHash") };
}

test("verifies a task-bound evidence record and assignment-bound signed receipt chain", async () => {
	const contract = task();
	const evidenceRecord = evidence(contract);
	const lease = assignment(contract);
	const first = await signExecutionReceipt(receipt(contract), signer());
	const second = await signExecutionReceipt(receipt(contract, { id: "rcpt_chain-two", previousReceiptHash: first.receipt.receiptHash, timeOffset: 40 }), signer());
	const result = await verifyEvidenceChain({
		task: contract,
		evidence: [evidenceRecord],
		receipts: [first, second],
		receiptAuthority: receiptAuthority(lease),
	});

	expect(result.ok).toBe(true);
	expect(result.verifiedEvidenceIds).toEqual([evidenceRecord.evidenceId]);
	expect(result.verifiedReceiptIds).toEqual([first.receipt.receiptId, second.receipt.receiptId]);
});

test("rejects a bare self-hashed receipt before it can reach the authority", async () => {
	const contract = task();
	const lease = assignment(contract);
	let authorityCalls = 0;
	const result = await verifyEvidenceChain({
		task: contract,
		evidence: [evidence(contract)],
		receipts: [receipt(contract)],
		receiptAuthority: {
			resolve(assignmentId) {
				authorityCalls += 1;
				return receiptAuthority(lease).resolve(assignmentId);
			},
		},
	});

	expect(result.ok).toBe(false);
	expect(result.verifiedReceiptIds).toEqual([]);
	expect(result.issues.map(entry => entry.code)).toContain("invalid_signed_receipt");
	expect(authorityCalls).toBe(0);
});

test("rejects a receipt signed by an untrusted worker key", async () => {
	const contract = task();
	const lease = assignment(contract);
	const forged = await signExecutionReceipt(receipt(contract), signer("forged-worker-key"));
	const result = await verifyEvidenceChain({
		task: contract,
		evidence: [evidence(contract)],
		receipts: [forged],
		receiptAuthority: receiptAuthority(lease),
	});

	expect(result.ok).toBe(false);
	expect(result.verifiedReceiptIds).toEqual([]);
	expect(result.issues.map(entry => entry.code)).toContain("receipt_signature_unverified");
});

test("rejects a valid signature whose worker is not the assigned executor", async () => {
	const contract = task();
	const lease = assignment(contract);
	const signed = await signExecutionReceipt(receipt(contract, { workerPubkey: "other-worker-public-key-000001" }), signer());
	const result = await verifyEvidenceChain({
		task: contract,
		evidence: [evidence(contract)],
		receipts: [signed],
		receiptAuthority: receiptAuthority(lease),
	});

	expect(result.ok).toBe(false);
	expect(result.verifiedReceiptIds).toEqual([]);
	expect(result.issues.map(entry => entry.code)).toContain("receipt_worker_mismatch");
});
