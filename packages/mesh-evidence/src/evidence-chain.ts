import {
	parseEvidenceRecord,
	parseExecutionReceipt,
	parseTaskContract,
	type EvidenceRecordV1,
	type ExecutionReceiptV1,
	type JsonRecord,
	type TaskContractV1,
} from "@pk-nerdsaver-ai/mesh-contracts";

export type EvidenceChainIssueCode =
	| "invalid_contract"
	| "task_mismatch"
	| "criterion_mismatch"
	| "missing_evidence"
	| "missing_predecessor"
	| "duplicate_receipt_hash"
	| "forked_receipt_chain"
	| "disconnected_receipt_chain"
	| "receipt_time_order";

export interface EvidenceChainIssue {
	readonly code: EvidenceChainIssueCode;
	readonly subject: string;
	readonly message: string;
}

export interface EvidenceChainInput {
	readonly task: TaskContractV1 | unknown;
	readonly evidence: readonly (EvidenceRecordV1 | unknown)[];
	readonly receipts: readonly (ExecutionReceiptV1 | unknown)[];
}

export interface EvidenceChainVerification {
	readonly ok: boolean;
	readonly taskId?: string;
	readonly verifiedEvidenceIds: readonly string[];
	readonly verifiedReceiptIds: readonly string[];
	readonly issues: readonly EvidenceChainIssue[];
}

function issue(issues: EvidenceChainIssue[], code: EvidenceChainIssueCode, subject: string, message: string): void {
	issues.push(Object.freeze({ code, subject, message }));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "contract validation failed";
}

/** The v1 wire validator permits this optional field before the public type adds it. */
function previousReceiptHash(receipt: ExecutionReceiptV1): string | undefined {
	const value = (receipt as JsonRecord).previousReceiptHash;
	return typeof value === "string" ? value : undefined;
}

function parseTask(input: EvidenceChainInput["task"], issues: EvidenceChainIssue[]): TaskContractV1 | undefined {
	try {
		return parseTaskContract(input);
	} catch (error) {
		issue(issues, "invalid_contract", "task", errorMessage(error));
		return undefined;
	}
}

function parseEvidence(input: EvidenceChainInput["evidence"], issues: EvidenceChainIssue[]): EvidenceRecordV1[] {
	const parsed: EvidenceRecordV1[] = [];
	for (const item of input) {
		try {
			parsed.push(parseEvidenceRecord(item));
		} catch (error) {
			issue(issues, "invalid_contract", "evidence", errorMessage(error));
		}
	}
	return parsed;
}

function parseReceipts(input: EvidenceChainInput["receipts"], issues: EvidenceChainIssue[]): ExecutionReceiptV1[] {
	const parsed: ExecutionReceiptV1[] = [];
	for (const item of input) {
		try {
			parsed.push(parseExecutionReceipt(item));
		} catch (error) {
			issue(issues, "invalid_contract", "receipt", errorMessage(error));
		}
	}
	return parsed;
}

function verifyReceiptTopology(receipts: readonly ExecutionReceiptV1[], issues: EvidenceChainIssue[]): readonly ExecutionReceiptV1[] {
	if (receipts.length === 0) return [];
	const byHash = new Map<string, ExecutionReceiptV1>();
	const successors = new Map<string, ExecutionReceiptV1>();
	for (const receipt of receipts) {
		if (byHash.has(receipt.receiptHash)) {
			issue(issues, "duplicate_receipt_hash", receipt.receiptId, "Receipt hash appears more than once");
			continue;
		}
		byHash.set(receipt.receiptHash, receipt);
	}
	for (const receipt of byHash.values()) {
		const predecessor = previousReceiptHash(receipt);
		if (predecessor === undefined) continue;
		if (!byHash.has(predecessor)) {
			issue(issues, "missing_predecessor", receipt.receiptId, "previousReceiptHash does not identify a supplied receipt");
			continue;
		}
		if (successors.has(predecessor)) {
			issue(issues, "forked_receipt_chain", receipt.receiptId, "More than one receipt points to the same predecessor");
			continue;
		}
		successors.set(predecessor, receipt);
	}
	const roots = [...byHash.values()].filter(receipt => previousReceiptHash(receipt) === undefined);
	if (roots.length !== 1) {
		issue(issues, "disconnected_receipt_chain", "receipts", "A receipt chain must have exactly one root receipt");
		return [];
	}
	const ordered: ExecutionReceiptV1[] = [];
	const visited = new Set<string>();
	let current: ExecutionReceiptV1 | undefined = roots[0];
	while (current !== undefined) {
		if (visited.has(current.receiptHash)) {
			issue(issues, "disconnected_receipt_chain", current.receiptId, "Receipt chain contains a cycle");
			break;
		}
		visited.add(current.receiptHash);
		const previous = ordered.at(-1);
		if (previous !== undefined && Date.parse(current.startedAt) < Date.parse(previous.endedAt)) {
			issue(issues, "receipt_time_order", current.receiptId, "Receipt starts before its predecessor ended");
		}
		ordered.push(current);
		current = successors.get(current.receiptHash);
	}
	if (visited.size !== byHash.size) issue(issues, "disconnected_receipt_chain", "receipts", "Receipt chain has unreachable receipts");
	return ordered;
}

/**
 * Validates signed/digested contract bodies and then cross-checks their task,
 * acceptance criteria, receipt hashes, causal topology, and evidence references.
 */
export function verifyEvidenceChain(input: EvidenceChainInput): EvidenceChainVerification {
	const issues: EvidenceChainIssue[] = [];
	const task = parseTask(input.task, issues);
	if (task === undefined) {
		return Object.freeze({ ok: false, verifiedEvidenceIds: Object.freeze([]), verifiedReceiptIds: Object.freeze([]), issues: Object.freeze(issues) });
	}
	const allowedCriteria = new Set(task.acceptanceCriteria.map(criterion => criterion.id));
	const evidence = parseEvidence(input.evidence, issues);
	const evidenceById = new Map<string, EvidenceRecordV1>();
	for (const record of evidence) {
		if (record.taskId !== task.taskId) issue(issues, "task_mismatch", record.evidenceId, "Evidence belongs to a different task");
		for (const criterionId of record.criterionIds) {
			if (!allowedCriteria.has(criterionId)) issue(issues, "criterion_mismatch", record.evidenceId, `Unknown criterion ${criterionId}`);
		}
		evidenceById.set(record.evidenceId, record);
	}
	const receipts = parseReceipts(input.receipts, issues);
	for (const receipt of receipts) {
		if (receipt.taskId !== task.taskId || receipt.taskDigest !== task.digest) issue(issues, "task_mismatch", receipt.receiptId, "Receipt task identity or digest does not match");
		for (const evidenceId of receipt.evidence) {
			if (!evidenceById.has(evidenceId)) issue(issues, "missing_evidence", receipt.receiptId, `Missing evidence ${evidenceId}`);
		}
	}
	const orderedReceipts = verifyReceiptTopology(receipts, issues);
	return Object.freeze({
		ok: issues.length === 0,
		taskId: task.taskId,
		verifiedEvidenceIds: Object.freeze(evidence.map(record => record.evidenceId)),
		verifiedReceiptIds: Object.freeze(orderedReceipts.map(receipt => receipt.receiptId)),
		issues: Object.freeze(issues),
	});
}
