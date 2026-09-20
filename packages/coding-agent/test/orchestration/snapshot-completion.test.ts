import { describe, expect, it } from "bun:test";
import { evaluateLifecycleCompletion, parseVerificationReceiptV1 } from "../../src/orchestration/snapshot-completion";
import {
	createTestCompletionSnapshot,
	createTestVerificationReceipt,
	DUMMY_HASH_1,
} from "../helpers/lifecycle-fixtures";

describe("Snapshot completion evaluator (A11)", () => {
	it("completes when receipts cover every mandatory criterion", () => {
		const snapshot = createTestCompletionSnapshot();
		const decision = evaluateLifecycleCompletion(snapshot);
		expect(decision.outcome).toBe("completed");
		expect(decision.satisfiedCriterionIds).toContain("crit-1");
		expect(decision.unmetCriterionIds).toHaveLength(0);

		// Round-trip parser revalidates
		const parsed = parseVerificationReceiptV1(snapshot.receipts[0]);
		expect(parsed.receiptId).toBe(snapshot.receipts[0]?.receiptId);
	});

	it("treats a receipt for a different candidate as stale", () => {
		const snapshot = createTestCompletionSnapshot({ candidateHash: DUMMY_HASH_1 });
		// Receipt has candidateHash DUMMY_HASH_2, snapshot has DUMMY_HASH_1
		const decision = evaluateLifecycleCompletion(snapshot);
		expect(decision.outcome).toBe("blocked");
		expect(decision.unmetCriterionIds).toContain("crit-1");
	});

	it("never counts a nonzero exit as verification", () => {
		const badReceipt = createTestVerificationReceipt({ exitCode: 1, outcome: "passed" });
		const decision = evaluateLifecycleCompletion(createTestCompletionSnapshot({ receipts: [badReceipt] }));
		expect(decision.outcome).toBe("blocked");
		expect(decision.unmetCriterionIds).toContain("crit-1");
	});

	it("stays blocked on acknowledged but open obligations; waivers are listed, never passing", () => {
		const blocked = evaluateLifecycleCompletion(createTestCompletionSnapshot({ openObligationIds: ["ob-1"] }));
		expect(blocked.outcome).toBe("blocked");
		expect(blocked.obligationIds).toContain("ob-1");

		const waived = evaluateLifecycleCompletion(
			createTestCompletionSnapshot({ receipts: [], openObligationIds: [], waivedObligationIds: ["ob-1"] }),
		);
		expect(waived.obligationIds).toContain("ob-1");
		expect(waived.outcome).not.toBe("completed");
	});

	it("blocks on partial publication and surfaces cancellation over narrative", () => {
		const partial = evaluateLifecycleCompletion(createTestCompletionSnapshot({ publicationState: "partial" }));
		expect(partial.outcome).toBe("blocked");

		const cancelled = evaluateLifecycleCompletion(createTestCompletionSnapshot({ executionOutcome: "cancelled" }));
		expect(cancelled.outcome).toBe("cancelled");
	});
});
