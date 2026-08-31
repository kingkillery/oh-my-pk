import {
	parseAssignmentLease,
	parseEvidenceRecord,
	parseExecutionReceipt,
	parseTaskContract,
	type AssignmentLeaseV1,
	type EvidenceRecordV1,
	type ExecutionReceiptV1,
	type JsonRecord,
	type TaskContractV1,
} from "@pk-nerdsaver-ai/mesh-contracts";
import { verifySignedExecutionReceipt, type ReceiptSignatureVerifier } from "@pk-nerdsaver-ai/mesh-receipts";

export type EvidenceChainIssueCode =
	| "invalid_contract"
	| "invalid_signed_receipt"
	| "task_mismatch"
	| "criterion_mismatch"
	| "missing_evidence"
	| "missing_predecessor"
	| "duplicate_receipt_hash"
	| "forked_receipt_chain"
	| "disconnected_receipt_chain"
	| "receipt_time_order"
	| "receipt_authority_unavailable"
	| "receipt_signature_unverified"
	| "receipt_assignment_mismatch"
	| "receipt_worker_mismatch"
	| "receipt_node_mismatch"
	| "receipt_worker_node_mismatch";

export interface EvidenceChainIssue {
	readonly code: EvidenceChainIssueCode;
	readonly subject: string;
	readonly message: string;
}

/** A trusted assignment and its expected worker receipt verifier. */
export interface EvidenceReceiptAuthorityResult {
	readonly assignment: AssignmentLeaseV1 | unknown;
	readonly verifier: ReceiptSignatureVerifier;
}

/**
 * The application supplies this adapter from its authoritative assignment store.
 * Untrusted receipt metadata can select only an assignment lookup key, never a verifier.
 */
export interface EvidenceReceiptAuthority {
	resolve(assignmentId: string): EvidenceReceiptAuthorityResult | undefined | Promise<EvidenceReceiptAuthorityResult | undefined>;
}

export interface EvidenceChainInput {
	readonly task: TaskContractV1 | unknown;
	readonly evidence: readonly (EvidenceRecordV1 | unknown)[];
	/** Signed receipt envelopes only. Bare receipts are never evidence. */
	readonly receipts: readonly unknown[];
	readonly receiptAuthority: EvidenceReceiptAuthority;
}

export interface EvidenceChainVerification {
	readonly ok: boolean;
	readonly taskId?: string;
	readonly verifiedEvidenceIds: readonly string[];
	readonly verifiedReceiptIds: readonly string[];
	readonly issues: readonly EvidenceChainIssue[];
}

type ReceiptAuthorityResolution =
	| Readonly<{ readonly kind: "resolved"; readonly assignment: AssignmentLeaseV1; readonly verifier: ReceiptSignatureVerifier }>
	| Readonly<{ readonly kind: "unavailable" }>
	| Readonly<{ readonly kind: "assignment_mismatch" }>;

function issue(issues: EvidenceChainIssue[], code: EvidenceChainIssueCode, subject: string, message: string): void {
	issues.push(Object.freeze({ code, subject, message }));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "contract validation failed";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
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

/** Parses only the untrusted receipt body needed to select the trusted authority. */
function signedReceiptCandidate(input: unknown): ExecutionReceiptV1 | undefined {
	if (!isRecord(input) || !hasOwn(input, "receipt") || !hasOwn(input, "signature")) return undefined;
	try {
		return parseExecutionReceipt(input.receipt);
	} catch {
		return undefined;
	}
}

async function resolveReceiptAuthority(authority: EvidenceReceiptAuthority, assignmentId: string): Promise<ReceiptAuthorityResolution> {
	try {
		const resolved = await authority.resolve(assignmentId);
		if (resolved === undefined) return Object.freeze({ kind: "unavailable" });
		const assignment = parseAssignmentLease(resolved.assignment);
		if (assignment.assignmentId !== assignmentId) return Object.freeze({ kind: "assignment_mismatch" });
		return Object.freeze({ kind: "resolved", assignment, verifier: resolved.verifier });
	} catch {
		return Object.freeze({ kind: "unavailable" });
	}
}

function matchesAssignment(receipt: ExecutionReceiptV1, assignment: AssignmentLeaseV1, issues: EvidenceChainIssue[]): boolean {
	let matches = true;
	if (
		receipt.assignmentId !== assignment.assignmentId ||
		receipt.taskId !== assignment.taskId ||
		receipt.taskDigest !== assignment.taskDigest ||
		receipt.schedulerEpoch !== assignment.schedulerEpoch ||
		receipt.fencingToken !== assignment.fencingToken
	) {
		issue(issues, "receipt_assignment_mismatch", receipt.receiptId, "Receipt does not match the authoritative assignment");
		matches = false;
	}
	if (receipt.worker.role !== "worker" || receipt.worker.pubkey !== assignment.executorPubkey) {
		issue(issues, "receipt_worker_mismatch", receipt.receiptId, "Receipt worker does not match the assigned executor");
		matches = false;
	}
	if (receipt.nodeId !== assignment.workerNodeId) {
		issue(issues, "receipt_node_mismatch", receipt.receiptId, "Receipt node does not match the assigned worker node");
		matches = false;
	}
	if (receipt.worker.nodeId !== assignment.workerNodeId) {
		issue(issues, "receipt_worker_node_mismatch", receipt.receiptId, "Receipt worker node does not match the assigned worker node");
		matches = false;
	}
	return matches;
}

async function parseReceipts(
	input: EvidenceChainInput["receipts"],
	authority: EvidenceReceiptAuthority,
	issues: EvidenceChainIssue[],
): Promise<ExecutionReceiptV1[]> {
	const parsed: ExecutionReceiptV1[] = [];
	for (const item of input) {
		const candidate = signedReceiptCandidate(item);
		if (candidate === undefined) {
			issue(issues, "invalid_signed_receipt", "receipt", "Evidence requires a signed execution receipt envelope");
			continue;
		}

		const authorityResult = await resolveReceiptAuthority(authority, candidate.assignmentId);
		if (authorityResult.kind === "unavailable") {
			issue(issues, "receipt_authority_unavailable", candidate.receiptId, "No authoritative assignment or receipt verifier is available");
			continue;
		}
		if (authorityResult.kind === "assignment_mismatch") {
			issue(issues, "receipt_assignment_mismatch", candidate.receiptId, "Authoritative assignment identity does not match the receipt lookup key");
			continue;
		}

		const verified = await verifySignedExecutionReceipt(item, authorityResult.verifier);
		if (!verified.ok) {
			issue(issues, "receipt_signature_unverified", candidate.receiptId, "Receipt signature could not be verified by the authoritative assignment key");
			continue;
		}
		if (!matchesAssignment(verified.receipt, authorityResult.assignment, issues)) continue;
		parsed.push(verified.receipt);
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
 * Validates contract bodies, assignment-bound signed receipts, then cross-checks
 * task identity, acceptance criteria, causal receipt topology, and evidence references.
 */
export async function verifyEvidenceChain(input: EvidenceChainInput): Promise<EvidenceChainVerification> {
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
	const receipts = await parseReceipts(input.receipts, input.receiptAuthority, issues);
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
