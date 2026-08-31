import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { MeshRuntimeCorruptionError, MeshRuntimeError } from "./errors";
import { createEmptyRuntimeSnapshot, type MeshRuntimeRepository, type MeshRuntimeSnapshot, type MeshRuntimeTransaction } from "./types";

const CURRENT_SCHEMA_VERSION = 2;
const STATE_ROW_ID = 1;
const DATABASE_LOCKS = new Map<string, Promise<void>>();

interface StateRow {
	readonly revision: number;
	readonly snapshotJson: string;
}

interface MigrationRow {
	readonly version: number;
}

function cloneSnapshot(snapshot: MeshRuntimeSnapshot): MeshRuntimeSnapshot {
	return structuredClone(snapshot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

async function acquireDatabaseLock(key: string): Promise<() => void> {
	const preceding = DATABASE_LOCKS.get(key) ?? Promise.resolve();
	const released = Promise.withResolvers<void>();
	const tail = preceding.then(
		() => released.promise,
		() => released.promise,
	);
	DATABASE_LOCKS.set(key, tail);
	await preceding;
	return () => {
		released.resolve();
		if (DATABASE_LOCKS.get(key) === tail) DATABASE_LOCKS.delete(key);
	};
}

function assertObjectMap(value: unknown, name: string): asserts value is Record<string, Record<string, unknown>> {
	if (!isRecord(value)) throw new MeshRuntimeCorruptionError(`${name} is not an object map`);
	for (const entry of Object.values(value)) {
		if (!isRecord(entry)) throw new MeshRuntimeCorruptionError(`${name} contains a non-object record`);
	}
}

/**
 * The SQLite authority adapter stores a versioned state snapshot. It is a
 * compact initial production adapter: authoritative changes and outbox data
 * commit together, while relays and worker transports remain downstream only.
 */
export class SqliteMeshRuntimeRepository implements MeshRuntimeRepository {
	readonly #db: Database;
	readonly #lockKey: string;
	#tail: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(path: string) {
		if (path.length === 0) throw new TypeError("SQLite path must not be empty");
		this.#lockKey = path === ":memory:" ? `memory:${crypto.randomUUID()}` : resolve(path);
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new Database(path, { create: true, readwrite: true, strict: true });
		try {
			this.#db.exec("PRAGMA foreign_keys = ON");
			this.#db.exec("PRAGMA busy_timeout = 5000");
			if (path !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL");
			this.#migrate();
			this.#loadSnapshot();
		} catch (error) {
			this.#db.close();
			throw error;
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}

	async read<T>(select: (snapshot: MeshRuntimeSnapshot) => T | Promise<T>): Promise<T> {
		return this.#exclusive(async () => select(cloneSnapshot(this.#loadSnapshot())));
	}

	async transaction<T>(operation: (transaction: MeshRuntimeTransaction) => T | Promise<T>): Promise<T> {
		return this.#exclusive(async () => {
			this.#beginImmediate();
			try {
				const stored = this.#loadSnapshot();
				const working = cloneSnapshot(stored);
				const result = await operation({ snapshot: working });
				working.revision = stored.revision + 1;
				assertSnapshot(working);
				this.#commitSnapshot(working, stored.revision);
				this.#db.exec("COMMIT");
				return result;
			} catch (error) {
				this.#rollbackQuietly();
				throw error;
			}
		});
	}

	async #exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
		const preceding = this.#tail;
		const released = Promise.withResolvers<void>();
		this.#tail = preceding.then(
			() => released.promise,
			() => released.promise,
		);
		await preceding;
		const releaseDatabase = await acquireDatabaseLock(this.#lockKey);
		try {
			this.#assertOpen();
			return await operation();
		} finally {
			releaseDatabase();
			released.resolve();
		}
	}

	#migrate(): void {
		this.#beginImmediate();
		try {
			this.#db.exec(`
				CREATE TABLE IF NOT EXISTS mesh_runtime_schema_migrations (
					version INTEGER PRIMARY KEY,
					applied_at TEXT NOT NULL
				);
			`);
			const migrations = this.#db
				.query<MigrationRow, []>("SELECT version FROM mesh_runtime_schema_migrations ORDER BY version")
				.all();
			for (const migration of migrations) {
				if (!isNonNegativeInteger(migration.version) || migration.version > CURRENT_SCHEMA_VERSION) {
					throw new MeshRuntimeCorruptionError("database schema version is unsupported");
				}
			}
			if (!migrations.some(migration => migration.version === 1)) this.#applyVersionOne();
			if (!migrations.some(migration => migration.version === 2)) this.#applyVersionTwo();
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#rollbackQuietly();
			throw error;
		}
	}

	#applyVersionOne(): void {
		this.#db.exec(`
			CREATE TABLE mesh_runtime_state (
				singleton INTEGER PRIMARY KEY CHECK (singleton = ${STATE_ROW_ID}),
				revision INTEGER NOT NULL CHECK (revision >= 0),
				snapshot_json TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
		const initial = createEmptyRuntimeSnapshot();
		this.#db.run(
			"INSERT INTO mesh_runtime_state (singleton, revision, snapshot_json, updated_at) VALUES (?, ?, ?, ?)",
			[STATE_ROW_ID, initial.revision, JSON.stringify(initial), new Date().toISOString()],
		);
		this.#db.run("INSERT INTO mesh_runtime_schema_migrations (version, applied_at) VALUES (?, ?)", [1, new Date().toISOString()]);
	}

	/**
	 * v2 adds a monotonic worker-capacity map to the durable snapshot. It makes
	 * no authority change, so its snapshot revision remains untouched.
	 */
	#applyVersionTwo(): void {
		let row: StateRow | null;
		try {
			row = this.#db
				.query<StateRow, []>("SELECT revision, snapshot_json AS snapshotJson FROM mesh_runtime_state WHERE singleton = 1")
				.get();
		} catch {
			throw new MeshRuntimeCorruptionError("state table is unreadable");
		}
		if (row === null || row === undefined) throw new MeshRuntimeCorruptionError("state row is missing");
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.snapshotJson);
		} catch {
			throw new MeshRuntimeCorruptionError("state snapshot is not valid JSON");
		}
		if (!isRecord(parsed)) throw new MeshRuntimeCorruptionError("state snapshot is not an object");
		if (!Object.prototype.hasOwnProperty.call(parsed, "workerCapacityObservations")) {
			parsed.workerCapacityObservations = {};
		}
		const snapshot = assertSnapshot(parsed);
		if (snapshot.revision !== row.revision) throw new MeshRuntimeCorruptionError("state revision does not match its snapshot");
		this.#db.run(
			"UPDATE mesh_runtime_state SET snapshot_json = ?, updated_at = ? WHERE singleton = ?",
			[JSON.stringify(snapshot), new Date().toISOString(), STATE_ROW_ID],
		);
		this.#db.run("INSERT INTO mesh_runtime_schema_migrations (version, applied_at) VALUES (?, ?)", [2, new Date().toISOString()]);
	}

	#loadSnapshot(): MeshRuntimeSnapshot {
		let row: StateRow | null;
		try {
			row = this.#db
				.query<StateRow, []>("SELECT revision, snapshot_json AS snapshotJson FROM mesh_runtime_state WHERE singleton = 1")
				.get();
		} catch {
			throw new MeshRuntimeCorruptionError("state table is unreadable");
		}
		if (row === null || row === undefined) throw new MeshRuntimeCorruptionError("state row is missing");
		if (!isNonNegativeInteger(row.revision)) throw new MeshRuntimeCorruptionError("state revision is invalid");
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.snapshotJson);
		} catch {
			throw new MeshRuntimeCorruptionError("state snapshot is not valid JSON");
		}
		const snapshot = assertSnapshot(parsed);
		if (snapshot.revision !== row.revision) throw new MeshRuntimeCorruptionError("state revision does not match its snapshot");
		return snapshot;
	}

	#commitSnapshot(snapshot: MeshRuntimeSnapshot, expectedRevision: number): void {
		const result = this.#db.run(
			`UPDATE mesh_runtime_state
			 SET revision = ?, snapshot_json = ?, updated_at = ?
			 WHERE singleton = ? AND revision = ?`,
			[snapshot.revision, JSON.stringify(snapshot), new Date().toISOString(), STATE_ROW_ID, expectedRevision],
		);
		if (result.changes !== 1) throw new MeshRuntimeError("Runtime revision changed during transaction");
	}

	#beginImmediate(): void {
		this.#assertOpen();
		this.#db.exec("BEGIN IMMEDIATE");
	}

	#rollbackQuietly(): void {
		try {
			this.#db.exec("ROLLBACK");
		} catch {
			// Preserve the original failure; a failed rollback cannot authorize a write.
		}
	}

	#assertOpen(): void {
		if (this.#closed) throw new MeshRuntimeError("Mesh runtime repository is closed");
	}
}

function assertSnapshot(value: unknown): MeshRuntimeSnapshot {
	if (!isRecord(value)) throw new MeshRuntimeCorruptionError("state snapshot is not an object");
	if (!isNonNegativeInteger(value.revision)) throw new MeshRuntimeCorruptionError("state snapshot revision is invalid");
	assertObjectMap(value.tasks, "tasks");
	assertObjectMap(value.assignments, "assignments");
	assertObjectMap(value.outbox, "outbox");
	assertObjectMap(value.deliveries, "deliveries");
	assertWorkerCapacityObservations(value.workerCapacityObservations);
	if (!isRecord(value.scheduler)) throw new MeshRuntimeCorruptionError("scheduler is not an object");
	if (!isNonNegativeInteger(value.scheduler.epoch)) throw new MeshRuntimeCorruptionError("scheduler epoch is invalid");
	if (typeof value.scheduler.leaseExpiresAt !== "number" || !Number.isFinite(value.scheduler.leaseExpiresAt)) {
		throw new MeshRuntimeCorruptionError("scheduler lease expiry is invalid");
	}
	if (value.scheduler.ownerId !== undefined && typeof value.scheduler.ownerId !== "string") {
		throw new MeshRuntimeCorruptionError("scheduler owner is invalid");
	}
	return value as MeshRuntimeSnapshot;
}

function assertWorkerCapacityObservations(value: unknown): void {
	if (!isRecord(value)) throw new MeshRuntimeCorruptionError("worker capacity observations are not an object map");
	for (const [workerNodeId, observation] of Object.entries(value)) {
		if (!isNonEmptyString(workerNodeId) || !isRecord(observation)) {
			throw new MeshRuntimeCorruptionError("worker capacity observations contain an invalid record");
		}
		if (!isNonEmptyString(observation.actorPubkey) || !isNonNegativeInteger(observation.availableSlots)) {
			throw new MeshRuntimeCorruptionError("worker capacity observation identity or slots are invalid");
		}
		if (
			!isNonNegativeInteger(observation.observedAt) ||
			!isNonNegativeInteger(observation.expiresAt) ||
			observation.expiresAt <= observation.observedAt
		) {
			throw new MeshRuntimeCorruptionError("worker capacity observation window is invalid");
		}
	}
}
