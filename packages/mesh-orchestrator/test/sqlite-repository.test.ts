import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MeshOrchestrator, MeshRuntimeCorruptionError, SqliteMeshRuntimeRepository, WorkerCapacityObservationError } from "../src";

function createDatabasePath(): { readonly directory: string; readonly path: string } {
	const directory = mkdtempSync(join(tmpdir(), "mesh-orchestrator-"));
	return { directory, path: join(directory, "runtime.sqlite") };
}

describe("SqliteMeshRuntimeRepository", () => {
	test("commits a revisioned snapshot that survives a fresh reopen with WAL migrations", async () => {
		const database = createDatabasePath();
		try {
			const first = new SqliteMeshRuntimeRepository(database.path);
			await first.transaction(({ snapshot }) => {
				snapshot.scheduler.epoch = 7;
				snapshot.scheduler.ownerId = "scheduler-durable-001";
				snapshot.scheduler.leaseExpiresAt = 42;
				snapshot.workerCapacityObservations["node_durable-worker"] = {
					actorPubkey: "worker-durable-001",
					availableSlots: 0,
					observedAt: 21,
					expiresAt: 42,
				};
			});
			first.close();

			const probe = new Database(database.path, { readonly: true, strict: true });
			const migration = probe.query<{ version: number }, []>("SELECT MAX(version) AS version FROM mesh_runtime_schema_migrations").get();
			const journalMode = probe.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
			probe.close();
			expect(migration?.version).toBe(3);
			expect(journalMode?.journal_mode.toLowerCase()).toBe("wal");

			const reopened = new SqliteMeshRuntimeRepository(database.path);
			const snapshot = await reopened.read(value => value);
			reopened.close();
			expect(snapshot.revision).toBe(1);
			expect(snapshot.scheduler).toEqual({ epoch: 7, ownerId: "scheduler-durable-001", leaseExpiresAt: 42 });
			expect(snapshot.workerCapacityObservations).toEqual({
				"node_durable-worker": { actorPubkey: "worker-durable-001", availableSlots: 0, observedAt: 21, expiresAt: 42 },
			});
		} finally {
			rmSync(database.directory, { recursive: true, force: true });
		}
	});

	test("rolls back callback failures without publishing a partial snapshot or revision", async () => {
		const repository = new SqliteMeshRuntimeRepository(":memory:");
		try {
			await expect(
				repository.transaction(({ snapshot }) => {
					snapshot.scheduler.epoch = 99;
					throw new Error("intentional transaction failure");
				}),
			).rejects.toThrow("intentional transaction failure");

			const afterFailure = await repository.read(snapshot => snapshot);
			expect(afterFailure.revision).toBe(0);
			expect(afterFailure.scheduler).toEqual({ epoch: 0, leaseExpiresAt: 0 });
		} finally {
			repository.close();
		}
	});

	test("serializes concurrent async transactions into strictly increasing revisions", async () => {
		const database = createDatabasePath();
		const first = new SqliteMeshRuntimeRepository(database.path);
		const second = new SqliteMeshRuntimeRepository(database.path);
		try {
			const commits = await Promise.all(
				Array.from({ length: 12 }, (_, index) =>
					(index % 2 === 0 ? first : second).transaction(async ({ snapshot }) => {
						const observedRevision = snapshot.revision;
						await Promise.resolve();
						snapshot.scheduler.epoch += 1;
						return { index, observedRevision, epoch: snapshot.scheduler.epoch };
					}),
				),
			);

			expect(commits.map(commit => commit.observedRevision)).toEqual(Array.from({ length: 12 }, (_, index) => index));
			expect(commits.map(commit => commit.epoch)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
			const afterCommits = await first.read(snapshot => snapshot);
			expect(afterCommits.revision).toBe(12);
			expect(afterCommits.scheduler.epoch).toBe(12);
		} finally {
			first.close();
			second.close();
			rmSync(database.directory, { recursive: true, force: true });
		}
	});

	test("refuses to replace an unreadable durable snapshot during reopen", () => {
		const database = createDatabasePath();
		try {
			const repository = new SqliteMeshRuntimeRepository(database.path);
			repository.close();
			const raw = new Database(database.path, { create: false, readwrite: true, strict: true });
			raw.run("UPDATE mesh_runtime_state SET snapshot_json = ? WHERE singleton = 1", ["not-json"]);
			raw.close();

			expect(() => new SqliteMeshRuntimeRepository(database.path)).toThrow(MeshRuntimeCorruptionError);
		} finally {
			rmSync(database.directory, { recursive: true, force: true });
		}
	});

	test("upgrades a v1 snapshot with no worker capacity map or delivery artifact without changing authority revision", async () => {
		const database = createDatabasePath();
		try {
			const first = new SqliteMeshRuntimeRepository(database.path);
			await first.transaction(({ snapshot }) => {
				snapshot.scheduler.epoch = 3;
				snapshot.scheduler.ownerId = "scheduler-legacy-001";
				snapshot.scheduler.leaseExpiresAt = 123;
			});
			first.close();

			const raw = new Database(database.path, { create: false, readwrite: true, strict: true });
			const row = raw.query<{ snapshotJson: string }, []>("SELECT snapshot_json AS snapshotJson FROM mesh_runtime_state WHERE singleton = 1").get();
			if (row === null || row === undefined) throw new Error("expected durable snapshot");
			const legacy = JSON.parse(row.snapshotJson) as Record<string, unknown>;
			delete legacy.workerCapacityObservations;
			raw.run("UPDATE mesh_runtime_state SET snapshot_json = ? WHERE singleton = 1", [JSON.stringify(legacy)]);
			raw.run("DELETE FROM mesh_runtime_schema_migrations WHERE version IN (2, 3)");
			raw.close();

			const upgraded = new SqliteMeshRuntimeRepository(database.path);
			const snapshot = await upgraded.read(value => value);
			upgraded.close();
			expect(snapshot.revision).toBe(1);
			expect(snapshot.scheduler).toEqual({ epoch: 3, ownerId: "scheduler-legacy-001", leaseExpiresAt: 123 });
			expect(snapshot.workerCapacityObservations).toEqual({});

			const probe = new Database(database.path, { readonly: true, strict: true });
			const migration = probe.query<{ version: number }, []>("SELECT MAX(version) AS version FROM mesh_runtime_schema_migrations").get();
			probe.close();
			expect(migration?.version).toBe(3);
		} finally {
			rmSync(database.directory, { recursive: true, force: true });
		}
	});

	test("persists an equal-time capacity conflict as a zero-slot quarantine across reopen", async () => {
		const database = createDatabasePath();
		try {
			const first = new SqliteMeshRuntimeRepository(database.path);
			const runtime = new MeshOrchestrator(first, {
				receiptVerifierResolver: { resolve: () => undefined },
				clock: { nowEpochMs: () => 100 },
			});
			await runtime.observeWorkerCapacity({
				workerNodeId: "node_conflicted-worker",
				actorPubkey: "worker-conflicted-001",
				availableSlots: 2,
				observedAt: 100,
				expiresAt: 1_000,
			});
			await expect(
				runtime.observeWorkerCapacity({
					workerNodeId: "node_conflicted-worker",
					actorPubkey: "worker-conflicted-001",
					availableSlots: 0,
					observedAt: 100,
					expiresAt: 1_000,
				}),
			).rejects.toEqual(new WorkerCapacityObservationError("capacity_observation_conflict"));
			first.close();

			const reopened = new SqliteMeshRuntimeRepository(database.path);
			const snapshot = await reopened.read(value => value);
			reopened.close();
			expect(snapshot.workerCapacityObservations["node_conflicted-worker"]).toEqual({
				actorPubkey: "worker-conflicted-001",
				availableSlots: 0,
				observedAt: 100,
				expiresAt: 1_000,
			});
		} finally {
			rmSync(database.directory, { recursive: true, force: true });
		}
	});
});
