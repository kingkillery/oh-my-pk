import { expect, test } from "bun:test";
import { MESH_SCHEMA, contractDigest, parseTaskContract, type JsonRecord, type TaskContractV1 } from "@pk-nerdsaver-ai/mesh-contracts";

import { verifyEvidenceChain } from "../src";

const T0 = Date.parse("2026-08-31T12:00:00.000Z");
const HUMAN = "human-public-key-000001";
const WORKER = "worker-public-key-000001";

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

function receipt(taskContract: TaskContractV1, options?: { readonly previousReceiptHash?: string; readonly id?: string; readonly timeOffset?: number }) {
	const timeOffset = options?.timeOffset ?? 20;
	const body = {
		schemaVersion: MESH_SCHEMA.receipt,
		receiptId: options?.id ?? "rcpt_chain-one",
		taskId: taskContract.taskId,
		taskDigest: taskContract.digest,
		assignmentId: "asg_chain-one",
		schedulerEpoch: 1,
		fencingToken: 1,
		worker: { pubkey: WORKER, role: "worker", nodeId: "node_evidence-worker" },
		nodeId: "node_evidence-worker",
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

test("verifies a task-bound evidence record and chained receipt", () => {
	const contract = task();
	const evidenceRecord = evidence(contract);
	const first = receipt(contract);
	const second = receipt(contract, { id: "rcpt_chain-two", previousReceiptHash: first.receiptHash, timeOffset: 40 });
	const result = verifyEvidenceChain({ task: contract, evidence: [evidenceRecord], receipts: [first, second] });

	expect(result.ok).toBe(true);
	expect(result.verifiedEvidenceIds).toEqual([evidenceRecord.evidenceId]);
	expect(result.verifiedReceiptIds).toEqual([first.receiptId, second.receiptId]);
});
