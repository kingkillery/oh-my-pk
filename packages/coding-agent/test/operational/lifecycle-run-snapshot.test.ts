/**
 * Regression coverage for the authoritative run snapshot read (A15).
 *
 * These exercise a real temporary SQLite database against the actual v3 DDL.
 * The read previously selected `fence_json` and `run_id` from
 * `lifecycle_attempts` — neither column exists — so every snapshot read of a
 * run that had attempts threw a SQLite error. It also forged an empty root
 * node id and zeroed reservation vectors when columns were absent.
 */

import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { LifecycleReadError, OperationalStore } from "../../src/operational/store";
import { createTestCompiledContract, createTestRunLimits } from "../helpers/lifecycle-fixtures";

function withStore<T>(label: string, fn: (store: OperationalStore) => T): T {
	const dbPath = path.join(os.tmpdir(), `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const store = OperationalStore.open({ dbPath });
	try {
		return fn(store);
	} finally {
		store.close();
	}
}

describe("getLifecycleRunSnapshot (A15)", () => {
	it("throws run_not_found instead of fabricating an empty snapshot", () => {
		withStore("snapshot-missing", store => {
			expect(() => store.getLifecycleRunSnapshot("no-such-run")).toThrowError(
				expect.objectContaining({ code: "run_not_found" }),
			);
			try {
				store.getLifecycleRunSnapshot("no-such-run");
				throw new Error("expected a LifecycleReadError");
			} catch (error) {
				expect(error).toBeInstanceOf(LifecycleReadError);
			}
		});
	});

	it("reads a freshly created run with its real root node and limits", () => {
		withStore("snapshot-created", store => {
			const compiled = createTestCompiledContract();
			const limits = createTestRunLimits();
			const created = store.createLifecycleRun("run-a", compiled, limits, "idem-a");
			expect(created.ok).toBe(true);

			const snapshot = store.getLifecycleRunSnapshot("run-a");
			expect(snapshot.runId).toBe("run-a");
			// Previously `rootNodeId` fell back to "" when the lookup missed.
			expect(snapshot.rootNodeId).toBe("run-a-root");
			expect(snapshot.outcome).toBe("active");
			expect(snapshot.planVersion).toBe(1);
			expect(snapshot.cancellationGeneration).toBe(0);
			// Limits round-trip from the persisted JSON, not a zeroed default.
			expect(snapshot.limits.maxNodes).toBe(limits.maxNodes);
			expect(snapshot.limits.maxTokens).toBe(limits.maxTokens);
			expect(snapshot.limits.currency).toBe("USD");
			expect(snapshot.consumed.requests).toBe(0);
			expect(snapshot.reserved.requests).toBe(0);

			expect(snapshot.nodes).toHaveLength(1);
			expect(snapshot.nodes[0]?.nodeId).toBe("run-a-root");
			expect(snapshot.nodes[0]?.ownerNodeId).toBeNull();
			expect(snapshot.nodes[0]?.role).toBe("root-planner");
			expect(snapshot.nodes[0]?.depth).toBe(0);
		});
	});

	it("projects admitted attempts, which requires joining attempts through their node", () => {
		withStore("snapshot-attempts", store => {
			const compiled = createTestCompiledContract();
			const created = store.createLifecycleRun("run-b", compiled, createTestRunLimits(), "idem-b");
			expect(created.ok).toBe(true);

			const snapshot = store.getLifecycleRunSnapshot("run-b");
			expect(snapshot.attempts).toHaveLength(1);
			const attempt = snapshot.attempts[0];
			expect(attempt?.nodeId).toBe("run-b-root");
			expect(attempt?.attemptId).toBe("run-b-root-attempt-1");
			expect(attempt?.jobId).toBeTruthy();
			expect(attempt?.execution).toBe("queued");
			expect(attempt?.capture).toBe("pending");
			expect(attempt?.delivery).toBe("pending");
			expect(attempt?.publication).toBe("not-requested");
			expect(attempt?.verification).toBe("not-required");
			expect(attempt?.manifestRef).toBeNull();
		});
	});

	it("reports no fence for an admitted but unclaimed attempt", () => {
		withStore("snapshot-fence", store => {
			const compiled = createTestCompiledContract();
			store.createLifecycleRun("run-c", compiled, createTestRunLimits(), "idem-c");

			const snapshot = store.getLifecycleRunSnapshot("run-c");
			// No lease owner has claimed this attempt, so there is no valid
			// write-authentication token. Emitting a fence with an empty owner
			// would hand out a token that authenticates nothing.
			expect(snapshot.attempts[0]?.fence).toBeNull();
		});
	});

	it("returns the admitted job so callers cannot create a second execution unit", () => {
		withStore("snapshot-job", store => {
			const compiled = createTestCompiledContract();
			const created = store.createLifecycleRun("run-d", compiled, createTestRunLimits(), "idem-d");
			expect(created.ok).toBe(true);
			if (!created.ok) return;

			expect(created.job.id).toBeTruthy();
			expect(created.job.status).toBe("queued");

			// Idempotent replay must hand back the SAME job.
			const replay = store.createLifecycleRun("run-d", compiled, createTestRunLimits(), "idem-d");
			expect(replay.ok).toBe(true);
			if (!replay.ok) return;
			expect(replay.job.id).toBe(created.job.id);

			const snapshot = store.getLifecycleRunSnapshot("run-d");
			expect(snapshot.attempts).toHaveLength(1);
			expect(snapshot.attempts[0]?.jobId).toBe(created.job.id);
		});
	});

	it("reflects cancellation in the snapshot returned by cancelLifecycleRun", () => {
		withStore("snapshot-cancel", store => {
			const compiled = createTestCompiledContract();
			store.createLifecycleRun("run-e", compiled, createTestRunLimits(), "idem-e");

			const cancelled = store.cancelLifecycleRun({
				runId: "run-e",
				expectedCancellationGeneration: 0,
				reason: "operator cancelled",
				idempotencyKey: "cancel-e",
			});
			expect(cancelled.ok).toBe(true);
			if (!cancelled.ok) return;
			expect(cancelled.snapshot.outcome).toBe("cancelled");
			expect(cancelled.snapshot.cancellationGeneration).toBe(1);

			const reread = store.getLifecycleRunSnapshot("run-e");
			expect(reread.outcome).toBe("cancelled");
			expect(reread.cancellationGeneration).toBe(1);
		});
	});

	it("reports empty collections only for records the v3 schema genuinely has none of", () => {
		withStore("snapshot-empty", store => {
			const compiled = createTestCompiledContract();
			store.createLifecycleRun("run-f", compiled, createTestRunLimits(), "idem-f");

			const snapshot = store.getLifecycleRunSnapshot("run-f");
			expect(snapshot.dependencies).toEqual([]);
			expect(snapshot.obligations).toEqual([]);
			expect(snapshot.pendingInboxEventIds).toEqual([]);
			expect(snapshot.publicationReceipts).toEqual([]);
			expect(snapshot.verificationReceipts).toEqual([]);
			expect(snapshot.projectionManifestRefs).toEqual([]);
		});
	});

	it("survives close and reopen with the same persisted snapshot", () => {
		const dbPath = path.join(os.tmpdir(), `snapshot-reopen-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
		const compiled = createTestCompiledContract();

		const first = OperationalStore.open({ dbPath });
		let firstJobId: string;
		try {
			const created = first.createLifecycleRun("run-g", compiled, createTestRunLimits(), "idem-g");
			expect(created.ok).toBe(true);
			if (!created.ok) throw new Error("run creation failed");
			firstJobId = created.job.id;
		} finally {
			first.close();
		}

		const second = OperationalStore.open({ dbPath });
		try {
			const snapshot = second.getLifecycleRunSnapshot("run-g");
			expect(snapshot.rootNodeId).toBe("run-g-root");
			expect(snapshot.attempts).toHaveLength(1);
			expect(snapshot.attempts[0]?.jobId).toBe(firstJobId);
		} finally {
			second.close();
		}
	});
});
