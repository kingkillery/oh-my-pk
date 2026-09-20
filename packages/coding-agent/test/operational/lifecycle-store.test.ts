import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { OperationalStore } from "../../src/operational/store";
import { createTestCompiledContract } from "../helpers/lifecycle-fixtures";

describe("Lifecycle store schema v3 migration", () => {
	it("migrates a fresh database to v3 with lifecycle tables present", () => {
		const dbPath = path.join(
			os.tmpdir(),
			`lifecycle-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
		);
		const store = OperationalStore.open({ dbPath });
		try {
			// A missing run throws rather than returning an empty snapshot that
			// would read like a real run with no nodes.
			expect(() => store.getLifecycleRunSnapshot("missing-run")).toThrowError(
				expect.objectContaining({ code: "run_not_found" }),
			);
		} finally {
			store.close();
		}
	});

	it("refuses to admit an attempt against a run that does not exist", () => {
		const dbPath = path.join(
			os.tmpdir(),
			`lifecycle-attempt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
		);
		const store = OperationalStore.open({ dbPath });
		try {
			// A fully valid contract, so the rejection can only come from the
			// missing run rather than from an unrelated fixture defect.
			const admit = store.admitLifecycleAttempt({
				runId: "run-missing",
				ownerNodeId: "root",
				nodeId: null,
				idempotencyKey: "key-1",
				compiled: createTestCompiledContract({ objective: "Verify lifecycle admission" }),
				expectedPlanVersion: 1,
				expectedCancellationGeneration: 0,
				reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
				prerequisiteIds: [],
			});
			expect(admit.ok).toBe(false);
			if (admit.ok) return;
			expect(admit.code).toBe("run_not_found");
		} finally {
			store.close();
		}
	});
});
