import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	VERACITY_CONFIDENCE_CAPS,
	VERACITY_WEIGHTS,
	VeracityConsolidator,
} from "@pk-nerdsaver-ai/pi-mnemopi/core/veracity-consolidation";

describe("VeracityConsolidator", () => {
	it("does not close a caller-owned Database handle", () => {
		const db = new Database(":memory:", { create: true, readwrite: true, strict: true });
		try {
			const consolidator = new VeracityConsolidator(":memory:", db);
			consolidator.consolidateFact("Alice", "likes", "tea", "stated", "test");

			consolidator.close();

			const row = db.query("SELECT COUNT(*) AS count FROM consolidated_facts").get() as { count: number };
			expect(row.count).toBe(1);
		} finally {
			db.close();
		}
	});

	it("orders VERACITY_WEIGHTS so verified tool evidence outranks stated, inferred, and unknown", () => {
		expect(VERACITY_WEIGHTS.tool).toBeGreaterThan(VERACITY_WEIGHTS.stated);
		expect(VERACITY_WEIGHTS.stated).toBeGreaterThan(VERACITY_WEIGHTS.imported);
		expect(VERACITY_WEIGHTS.imported).toBeGreaterThan(VERACITY_WEIGHTS.inferred);
		expect(VERACITY_WEIGHTS.inferred).toBeGreaterThan(VERACITY_WEIGHTS.unknown);
		expect(VERACITY_CONFIDENCE_CAPS.inferred).toBeLessThan(VERACITY_WEIGHTS.tool * 0.5);
		expect(VERACITY_CONFIDENCE_CAPS.unknown).toBeLessThan(VERACITY_CONFIDENCE_CAPS.inferred);
	});

	it("prevents 5x repeated unknown or inferred wrong claims from superseding 1x tool-verified fact", () => {
		const consolidator = new VeracityConsolidator(":memory:");
		try {
			const verified = consolidator.consolidateFact(
				"case-001",
				"blocker_cause",
				"hardware_mismatch",
				"tool",
				"evidence://tool-check-001",
			);
			for (let i = 0; i < 5; i++) {
				consolidator.consolidateFact("case-001", "blocker_cause", "missing_form", "inferred", `turn-${i}`);
				consolidator.consolidateFact("case-001", "blocker_cause", "stale_cache", "unknown", `transcript-${i}`);
			}

			consolidator.runConsolidationPass();

			const active = consolidator.getConsolidatedFacts("case-001", 0);
			const activeByObject = Object.fromEntries(active.map(fact => [fact.object, fact]));
			expect(activeByObject.hardware_mismatch).toBeDefined();
			expect(activeByObject.hardware_mismatch?.superseded).toBe(false);
			expect(activeByObject.hardware_mismatch?.veracity).toBe("tool");
			expect(activeByObject.hardware_mismatch?.id).toBe(verified.id);
			// Repeated unverified claims must remain strictly lower confidence than the single tool fact.
			expect(activeByObject.missing_form?.confidence ?? 0).toBeLessThan(
				activeByObject.hardware_mismatch?.confidence ?? 0,
			);
			expect(activeByObject.stale_cache?.confidence ?? 0).toBeLessThan(
				activeByObject.hardware_mismatch?.confidence ?? 0,
			);
		} finally {
			consolidator.close();
		}
	});

	it("never downgrades higher-provenance veracity when lower-provenance updates arrive", () => {
		const consolidator = new VeracityConsolidator(":memory:");
		try {
			const initial = consolidator.consolidateFact("svc-api", "status", "blocked", "tool", "evidence://probe-1");
			const afterInferred = consolidator.consolidateFact("svc-api", "status", "blocked", "inferred", "llm-note");
			const afterUnknown = consolidator.consolidateFact("svc-api", "status", "blocked", "unknown", "transcript");

			expect(afterInferred.veracity).toBe("tool");
			expect(afterUnknown.veracity).toBe("tool");
			expect(afterUnknown.confidence).toBe(initial.confidence);
		} finally {
			consolidator.close();
		}
	});

	it("keeps contradicted or retracted superseded facts quarantined when repeated", () => {
		const consolidator = new VeracityConsolidator(":memory:");
		try {
			const wrong = consolidator.consolidateFact("case-002", "blocker_cause", "wrong_reason", "inferred", "draft-1");
			const truth = consolidator.consolidateFact(
				"case-002",
				"blocker_cause",
				"verified_reason",
				"tool",
				"evidence://check-2",
			);
			const conflict = consolidator.getConflicts()[0];
			expect(conflict).toBeDefined();
			if (!conflict || !truth.id || !wrong.id) throw new Error("expected conflict and fact ids");
			consolidator.resolveConflict(conflict.id, truth.id);

			// Repeating the retracted claim must not clear superseded_by or boost its confidence.
			const repeated = consolidator.consolidateFact("case-002", "blocker_cause", "wrong_reason", "stated", "turn-9");
			expect(repeated.superseded).toBe(true);
			expect(repeated.confidence).toBe(wrong.confidence);
			expect(repeated.veracity).toBe("inferred");

			const active = consolidator.getConsolidatedFacts("case-002", 0);
			expect(active).toHaveLength(1);
			expect(active[0]?.object).toBe("verified_reason");
		} finally {
			consolidator.close();
		}
	});
});
