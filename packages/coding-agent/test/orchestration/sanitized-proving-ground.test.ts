/**
 * Track C Sanitized Proving-Ground Contract Check.
 *
 * Self-contained verification (zero external repo imports, zero customer/project PII)
 * proving a sanitized blocked-case operational evidence packet flows cleanly through:
 * 1. Mnemopi VeracityConsolidator (blocked status + verified cause survive 5x wrong-explanation noise)
 * 2. RootCompletionGate + evaluateCompletionGate (read-only turns rejected; real check passes)
 * 3. Eight-dimension audit receipt schema (outcome, correctness, evidence, authority,
 *    process, efficiency, persistence, recovery) + PII-firewall check.
 */
import { describe, expect, it } from "bun:test";
import type { Message, ToolResultMessage } from "@pk-nerdsaver-ai/pi-ai";
import { VeracityConsolidator } from "@pk-nerdsaver-ai/pi-mnemopi/core/veracity-consolidation";
import { evaluateCompletionGate } from "../../src/orchestration/completion-gate";
import { buildCompletionGateInputFromTranscript } from "../../src/orchestration/root-completion-gate";
import { compileTaskContractFromRequest, toActiveTaskContractSnapshot } from "../../src/orchestration/task-contract";

interface SanitizedAuditReceipt {
	readonly caseId: string;
	readonly dimensions: {
		readonly outcome: "pass" | "fail" | "blocked";
		readonly correctness: "verified" | "contradicted" | "unverified";
		readonly evidence: readonly string[];
		readonly authority: "within_scope" | "violation";
		readonly process: "gate_enforced" | "bypassed";
		readonly efficiency: { readonly toolCalls: number; readonly readOnlyRejected: boolean };
		readonly persistence: {
			readonly promotedCause: string;
			readonly quarantinedWrongCauses: readonly string[];
		};
		readonly recovery: { readonly supersededExcludedFromRecall: boolean };
	};
}

const PII_FIREWALL_PATTERNS: readonly RegExp[] = [
	/\bPROJECT-\d+\b/i,
	/\bIXP\d+-\d+\b/i,
	/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
	/\b\d{3}-\d{2}-\d{4}\b/,
];

function toolResult(toolName: string, timestamp: number, text = "ok", isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${toolName}-${timestamp}`,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp,
	};
}

describe("Track C sanitized proving-ground contract", () => {
	it("preserves blocked status, quarantines wrong explanations, enforces completion gates, and emits a PII-free 8-dimension receipt", () => {
		const caseId = "CASE-SYNTH-001";
		const consolidator = new VeracityConsolidator(":memory:");
		try {
			// 1) Authoritative tool observation establishes blocked status + true cause.
			const statusFact = consolidator.consolidateFact(
				caseId,
				"operational_status",
				"blocked",
				"tool",
				"evidence://synthetic-status-check-1",
			);
			const trueCause = consolidator.consolidateFact(
				caseId,
				"blocker_cause",
				"equipment_mismatch",
				"tool",
				"evidence://synthetic-meter-audit-1",
			);

			// 2) Agent repeats wrong causal explanation 5x with inferred/unknown provenance.
			for (let i = 0; i < 5; i++) {
				consolidator.consolidateFact(caseId, "blocker_cause", "missing_form_signature", "inferred", `draft-turn-${i}`);
				consolidator.consolidateFact(caseId, "blocker_cause", "stale_portal_note", "unknown", `transcript-${i}`);
			}

			// Consolidation must never let repeated unverified claims supersede tool evidence.
			consolidator.runConsolidationPass();
			const conflicts = consolidator.getConflicts();
			expect(conflicts.length).toBeGreaterThanOrEqual(2);
			for (const conflict of conflicts) {
				if (trueCause.id && (conflict.fact_a_id === trueCause.id || conflict.fact_b_id === trueCause.id)) {
					consolidator.resolveConflict(conflict.id, trueCause.id);
				}
			}

			// Repeating a retracted wrong cause after conflict resolution must keep it quarantined.
			const repeatedWrong = consolidator.consolidateFact(
				caseId,
				"blocker_cause",
				"missing_form_signature",
				"stated",
				"post-resolution-echo",
			);
			expect(repeatedWrong.superseded).toBe(true);

			const recalled = consolidator.getConsolidatedFacts(caseId, 0);
			const byPredicate = new Map(recalled.map(fact => [fact.predicate, fact]));
			expect(byPredicate.get("operational_status")?.object).toBe("blocked");
			expect(byPredicate.get("operational_status")?.id).toBe(statusFact.id);
			expect(byPredicate.get("blocker_cause")?.object).toBe("equipment_mismatch");
			expect(recalled.some(fact => fact.object === "missing_form_signature")).toBe(false);
			expect(recalled.some(fact => fact.object === "stale_portal_note")).toBe(false);

			// 3) Root completion gate rejects read-only turns and passes real verification commands.
			const compiled = toActiveTaskContractSnapshot(compileTaskContractFromRequest("audit blocked synthetic case"));
			const contract = { ...compiled, deliverables: ["sanitized-audit-receipt"] };

			const readOnlyGate = evaluateCompletionGate(
				buildCompletionGateInputFromTranscript(contract, [toolResult("read", 100), toolResult("grep", 101)], 50),
			);
			expect(readOnlyGate.outcome).toBe("recoverable");

			const verifiedMessages: Message[] = [
				toolResult("edit", 110, "updated sanitized-audit-receipt"),
				toolResult("eval", 111, "all checks passed"),
			];
			const verifiedGate = evaluateCompletionGate(buildCompletionGateInputFromTranscript(contract, verifiedMessages, 50));
			expect(verifiedGate.outcome).toBe("pass");

			// 4) Emit and validate 8-dimension audit receipt + zero-PII boundary.
			const receipt: SanitizedAuditReceipt = {
				caseId,
				dimensions: {
					outcome: verifiedGate.outcome === "pass" ? "pass" : "fail",
					correctness: "verified",
					evidence: ["evidence://synthetic-status-check-1", "evidence://synthetic-meter-audit-1"],
					authority: "within_scope",
					process: "gate_enforced",
					efficiency: { toolCalls: verifiedMessages.length, readOnlyRejected: readOnlyGate.outcome === "recoverable" },
					persistence: {
						promotedCause: byPredicate.get("blocker_cause")?.object ?? "",
						quarantinedWrongCauses: ["missing_form_signature", "stale_portal_note"],
					},
					recovery: {
						supersededExcludedFromRecall: !recalled.some(fact => fact.object === "missing_form_signature"),
					},
				},
			};

			expect(Object.keys(receipt.dimensions).sort()).toEqual([
				"authority",
				"correctness",
				"efficiency",
				"evidence",
				"outcome",
				"persistence",
				"process",
				"recovery",
			]);
			expect(receipt.dimensions.outcome).toBe("pass");
			expect(receipt.dimensions.persistence.promotedCause).toBe("equipment_mismatch");
			expect(receipt.dimensions.recovery.supersededExcludedFromRecall).toBe(true);

			const serialized = JSON.stringify(receipt);
			for (const pattern of PII_FIREWALL_PATTERNS) {
				expect(serialized).not.toMatch(pattern);
			}
		} finally {
			consolidator.close();
		}
	});
});
