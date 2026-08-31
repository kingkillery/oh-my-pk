import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { TaskContractV1 } from "@pk-nerdsaver-ai/mesh-contracts";
import type { SignedMeshEnvelopeV1 } from "@pk-nerdsaver-ai/mesh-auth";

import type { MeshNodeLifecycleRecord, MeshNodeLifecycleState } from "./lifecycle";

const CURRENT_SCHEMA_VERSION = 2;
const STATE_ROW_ID = 1;

interface StateRow {
	readonly revision: number;
	readonly snapshotJson: string;
}

interface MigrationRow {
	readonly version: number;
}

export interface MeshNodeStateIdentity {
	readonly nodeId: string;
	readonly pubkey: string;
}

/** The node publishes terminal facts later; persistence never sends them. */
export type MeshNodeOutboxState = "pending" | "delivered";

/**
 * This is a node-local terminal lifecycle fact, not a replacement for the
 * signed ExecutionReceiptV1 emitted by the worker receipt authority.
 */
export interface MeshNodeTerminalOutboxPublication {
	readonly outboxId: string;
	readonly assignmentId: string;
	readonly taskId: string;
	readonly type: "node.lifecycle.terminal";
	readonly idempotencyKey: string;
	readonly record: MeshNodeLifecycleRecord;
}

/** Auditable local delivery state. It is never a controller completion signal. */
export interface MeshNodeTerminalOutboxMessage extends MeshNodeTerminalOutboxPublication {
	readonly state: MeshNodeOutboxState;
	readonly deliveredAt?: string;
}

export interface MeshNodeDurableAssignment {
	readonly task: TaskContractV1;
	/** Persisted intact and re-verified against the local allow-list on hydration. */
	readonly signedAssignment: SignedMeshEnvelopeV1;
	state: MeshNodeLifecycleState;
	admissionRecord?: MeshNodeLifecycleRecord;
	cancelRecord?: MeshNodeLifecycleRecord;
	cleanupRecord?: MeshNodeLifecycleRecord;
	terminalRecord?: MeshNodeLifecycleRecord;
	cleanupOriginState?: MeshNodeLifecycleState;
}

/**
 * The intentionally small local durability boundary. It is independent from
 * controller task state: it records exactly what this node admitted and did.
 */
export interface MeshNodeStateSnapshot {
	revision: number;
	identity?: MeshNodeStateIdentity;
	assignments: Record<string, MeshNodeDurableAssignment>;
	events: MeshNodeLifecycleRecord[];
	outbox: Record<string, MeshNodeTerminalOutboxMessage>;
}

export interface MeshNodeStateTransaction {
	readonly snapshot: MeshNodeStateSnapshot;
}

/**
 * Node-local durable writes are deliberately synchronous: no execution-port
 * call may occur while a SQLite transaction is open or before it commits.
 */
export interface MeshNodeStateRepository {
	read<T>(select: (snapshot: MeshNodeStateSnapshot) => T): T;
	transaction<T>(operation: (transaction: MeshNodeStateTransaction) => T): T;
}

export class MeshNodeStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MeshNodeStateError";
	}
}

export class MeshNodeStateCorruptionError extends MeshNodeStateError {
	constructor(message: string) {
		super(message);
		this.name = "MeshNodeStateCorruptionError";
	}
}

export function createEmptyMeshNodeStateSnapshot(): MeshNodeStateSnapshot {
	return {
		revision: 0,
		assignments: {},
		events: [],
		outbox: {},
	};
}

function cloneSnapshot(snapshot: MeshNodeStateSnapshot): MeshNodeStateSnapshot {
	return structuredClone(snapshot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertObjectMap(value: unknown, name: string): asserts value is Record<string, Record<string, unknown>> {
	if (!isRecord(value)) throw new MeshNodeStateCorruptionError(`${name} is not an object map`);
	for (const entry of Object.values(value)) if (!isRecord(entry)) throw new MeshNodeStateCorruptionError(`${name} contains a non-object record`);
}

function assertIdentity(value: unknown): asserts value is MeshNodeStateIdentity {
	if (!isRecord(value) || typeof value.nodeId !== "string" || typeof value.pubkey !== "string") {
		throw new MeshNodeStateCorruptionError("node state identity is invalid");
	}
}

function assertSnapshot(value: unknown): MeshNodeStateSnapshot {
	if (!isRecord(value)) throw new MeshNodeStateCorruptionError("node state snapshot is not an object");
	if (!isNonNegativeInteger(value.revision)) throw new MeshNodeStateCorruptionError("node state revision is invalid");
	if (value.identity !== undefined) assertIdentity(value.identity);
	assertObjectMap(value.assignments, "node assignments");
	if (!Array.isArray(value.events)) throw new MeshNodeStateCorruptionError("node events are not an array");
	assertObjectMap(value.outbox, "node outbox");
	return value as MeshNodeStateSnapshot;
}

function rejectPromiseResult(value: unknown): void {
	if (typeof value === "object" && value !== null && "then" in value) {
		throw new MeshNodeStateError("node state transactions must not return a promise");
	}
}

/** A test-safe repository with the same commit-before-execution contract. */
export class InMemoryMeshNodeStateRepository implements MeshNodeStateRepository {
	#snapshot = createEmptyMeshNodeStateSnapshot();

	read<T>(select: (snapshot: MeshNodeStateSnapshot) => T): T {
		return select(cloneSnapshot(this.#snapshot));
	}

	transaction<T>(operation: (transaction: MeshNodeStateTransaction) => T): T {
		const stored = this.#snapshot;
		const working = cloneSnapshot(stored);
		const result = operation({ snapshot: working });
		rejectPromiseResult(result);
		working.revision = stored.revision + 1;
		assertSnapshot(working);
		this.#snapshot = working;
		return result;
	}
}

/**
 * A WAL-backed node-local inbox/outbox snapshot. It intentionally contains no
 * network, credential, daemon, or execution-runtime behavior.
 */
export class SqliteMeshNodeStateRepository implements MeshNodeStateRepository {
	readonly #db: Database;
	#closed = false;

	constructor(path: string) {
		if (path.length === 0) throw new TypeError("SQLite path must not be empty");
		if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
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

	read<T>(select: (snapshot: MeshNodeStateSnapshot) => T): T {
		this.#assertOpen();
		return select(cloneSnapshot(this.#loadSnapshot()));
	}

	transaction<T>(operation: (transaction: MeshNodeStateTransaction) => T): T {
		this.#beginImmediate();
		try {
			const stored = this.#loadSnapshot();
			const working = cloneSnapshot(stored);
			const result = operation({ snapshot: working });
			rejectPromiseResult(result);
			working.revision = stored.revision + 1;
			assertSnapshot(working);
			this.#commitSnapshot(working, stored.revision);
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#rollbackQuietly();
			throw error;
		}
	}

	#migrate(): void {
		this.#beginImmediate();
		try {
			this.#db.exec(`
				CREATE TABLE IF NOT EXISTS mesh_node_state_schema_migrations (
					version INTEGER PRIMARY KEY,
					applied_at TEXT NOT NULL
				);
			`);
			const migrations = this.#db
				.query<MigrationRow, []>("SELECT version FROM mesh_node_state_schema_migrations ORDER BY version")
				.all();
			for (const migration of migrations) {
				if (!isNonNegativeInteger(migration.version) || migration.version > CURRENT_SCHEMA_VERSION) {
					throw new MeshNodeStateCorruptionError("node state database schema version is unsupported");
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
			CREATE TABLE mesh_node_state (
				singleton INTEGER PRIMARY KEY CHECK (singleton = ${STATE_ROW_ID}),
				revision INTEGER NOT NULL CHECK (revision >= 0),
				snapshot_json TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
		const initial = createEmptyMeshNodeStateSnapshot();
		this.#db.run(
			"INSERT INTO mesh_node_state (singleton, revision, snapshot_json, updated_at) VALUES (?, ?, ?, ?)",
			[STATE_ROW_ID, initial.revision, JSON.stringify(initial), new Date().toISOString()],
		);
		this.#db.run("INSERT INTO mesh_node_state_schema_migrations (version, applied_at) VALUES (?, ?)", [1, new Date().toISOString()]);
	}

	/**
	 * V2 permits terminal facts to be durably marked delivered. Bumping the
	 * snapshot revision fences a pre-upgrade process that still holds an old
	 * copy, even when every existing fact remains pending.
	 */
	#applyVersionTwo(): void {
		let row: StateRow | null;
		try {
			row = this.#db
				.query<StateRow, []>("SELECT revision, snapshot_json AS snapshotJson FROM mesh_node_state WHERE singleton = 1")
				.get();
		} catch {
			throw new MeshNodeStateCorruptionError("node state table is unreadable");
		}
		if (row === null || row === undefined || !isNonNegativeInteger(row.revision)) {
			throw new MeshNodeStateCorruptionError("node state row is invalid");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.snapshotJson);
		} catch {
			throw new MeshNodeStateCorruptionError("node state snapshot is not valid JSON");
		}
		const snapshot = assertSnapshot(parsed);
		if (snapshot.revision !== row.revision) throw new MeshNodeStateCorruptionError("node state revision does not match its snapshot");
		snapshot.revision = row.revision + 1;
		const result = this.#db.run(
			`UPDATE mesh_node_state
			 SET revision = ?, snapshot_json = ?, updated_at = ?
			 WHERE singleton = ? AND revision = ?`,
			[snapshot.revision, JSON.stringify(snapshot), new Date().toISOString(), STATE_ROW_ID, row.revision],
		);
		if (result.changes !== 1) throw new MeshNodeStateError("node state revision changed during migration");
		this.#db.run("INSERT INTO mesh_node_state_schema_migrations (version, applied_at) VALUES (?, ?)", [2, new Date().toISOString()]);
	}

	#loadSnapshot(): MeshNodeStateSnapshot {
		let row: StateRow | null;
		try {
			row = this.#db
				.query<StateRow, []>("SELECT revision, snapshot_json AS snapshotJson FROM mesh_node_state WHERE singleton = 1")
				.get();
		} catch {
			throw new MeshNodeStateCorruptionError("node state table is unreadable");
		}
		if (row === null || row === undefined) throw new MeshNodeStateCorruptionError("node state row is missing");
		if (!isNonNegativeInteger(row.revision)) throw new MeshNodeStateCorruptionError("node state row revision is invalid");
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.snapshotJson);
		} catch {
			throw new MeshNodeStateCorruptionError("node state snapshot is not valid JSON");
		}
		const snapshot = assertSnapshot(parsed);
		if (snapshot.revision !== row.revision) throw new MeshNodeStateCorruptionError("node state revision does not match its snapshot");
		return snapshot;
	}

	#commitSnapshot(snapshot: MeshNodeStateSnapshot, expectedRevision: number): void {
		const result = this.#db.run(
			`UPDATE mesh_node_state
			 SET revision = ?, snapshot_json = ?, updated_at = ?
			 WHERE singleton = ? AND revision = ?`,
			[snapshot.revision, JSON.stringify(snapshot), new Date().toISOString(), STATE_ROW_ID, expectedRevision],
		);
		if (result.changes !== 1) throw new MeshNodeStateError("node state revision changed during transaction");
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
		if (this.#closed) throw new MeshNodeStateError("node state repository is closed");
	}
}
