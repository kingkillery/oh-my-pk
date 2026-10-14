import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, toError } from "@pk-nerdsaver-ai/pi-utils";

const LOCK_SCHEMA = `
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS writer_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  session_id TEXT NOT NULL,
  transcript_path TEXT NOT NULL,
  guard_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS retired (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  nonce TEXT NOT NULL
);
`;

/** Acquire attempts when every lock file found was retired underneath us. */
const MAX_RETIRED_RETRIES = 5;

export interface SessionWriterGuardHandle {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly guardId: string;
	readonly released: boolean;
	release(): Promise<void>;
	releaseSync(): void;
}

export interface AcquireSessionWriterGuardOptions {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly lockRoot?: string;
	readonly busyTimeoutMs?: number;
	/**
	 * Behavior when this process already holds the session's writer guard.
	 *
	 * - "reject" (default): throw {@link SessionAlreadyOwnedError}, treating an
	 *   in-process holder exactly like a foreign process. Recovery gates rely on
	 *   this: acquisition succeeding is proof that no live writer exists.
	 * - "share": adopt the existing in-process ownership instead of contending
	 *   through SQLite. The underlying lock (and its open transaction fencing
	 *   other processes) is released only when every sharing handle releases.
	 */
	readonly sameProcessOwner?: "reject" | "share";
}

export class SessionAlreadyOwnedError extends Error {
	readonly sessionId: string;
	readonly transcriptPath: string;

	constructor(sessionId: string, transcriptPath: string, cause?: unknown) {
		super(`Session ${sessionId} already has a writable owner`, cause === undefined ? undefined : { cause });
		this.name = "SessionAlreadyOwnedError";
		this.sessionId = sessionId;
		this.transcriptPath = transcriptPath;
	}
}

function validateIdentity(value: string, label: string): void {
	if (value.length === 0 || value.length > 4_096 || value.includes("\0")) throw new Error(`${label} is invalid`);
}

function lockName(sessionId: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(sessionId);
	return `${hasher.digest("hex")}.db`;
}

interface GuardLockRecord {
	readonly dbPath: string;
	readonly db: Database;
	holders: number;
}

/**
 * Live in-process lock records keyed by lock-db path. Lets an opted-in acquire
 * share ownership this process already holds instead of dead-locking against
 * its own open transaction (SQLite reports a sibling connection as plain BUSY).
 */
const liveLockRecords = new Map<string, GuardLockRecord>();

class SqliteSessionWriterGuard implements SessionWriterGuardHandle {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly guardId: string;
	#record: GuardLockRecord | undefined;

	constructor(record: GuardLockRecord, sessionId: string, transcriptPath: string, guardId: string) {
		this.#record = record;
		this.sessionId = sessionId;
		this.transcriptPath = transcriptPath;
		this.guardId = guardId;
	}

	get released(): boolean {
		return this.#record === undefined;
	}

	async release(): Promise<void> {
		this.releaseSync();
	}

	releaseSync(): void {
		const record = this.#record;
		if (!record) return;
		this.#record = undefined;
		record.holders -= 1;
		if (record.holders > 0) return;
		liveLockRecords.delete(record.dbPath);
		retireLockFile(record);
	}
}

/**
 * Release the lock and delete its file so lock files don't pile up, one per
 * session ever opened. A process may already have this file open and be waiting
 * on it, so the file is first marked retired inside the held transaction: a
 * waiter that then wins the lock on the unlinked file (POSIX) sees the marker
 * and retries on a fresh file. Windows refuses to delete a file that is still
 * open; the marked file then stays and the next acquirer reuses it.
 */
function retireLockFile(record: GuardLockRecord): void {
	let retired = false;
	try {
		record.db.run("DELETE FROM writer_guard");
		record.db.query("INSERT OR REPLACE INTO retired(singleton, nonce) VALUES (1, ?)").run(Bun.randomUUIDv7());
		record.db.run("COMMIT");
		retired = true;
	} catch {
		try {
			record.db.run("ROLLBACK");
		} catch {
			// The transaction is already gone; closing releases the lock.
		}
	} finally {
		record.db.close();
	}
	if (!retired) return;
	try {
		fs.rmSync(record.dbPath, { force: true });
	} catch {
		// Still open elsewhere (Windows); the retired marker lets it be reused.
	}
}

/** The retired nonce in the lock file currently at `dbPath`, if any. */
function retiredNonceAtPath(dbPath: string): string | undefined {
	if (!fs.existsSync(dbPath)) return undefined;
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
		return db.query<{ nonce: string }, []>("SELECT nonce FROM retired WHERE singleton = 1").get()?.nonce;
	} catch {
		return undefined;
	} finally {
		db?.close();
	}
}

/**
 * Cross-process exclusion for one writable transcript lifetime.
 *
 * Each session uses a dedicated rollback-journal SQLite database. The returned
 * handle owns a BEGIN IMMEDIATE transaction until release, so process death is
 * fenced by the operating system rather than by a renewable WAL lease. Within
 * one process, `sameProcessOwner: "share"` lets additional handles adopt an
 * ownership this process already holds (see {@link AcquireSessionWriterGuardOptions}).
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace SessionWriterGuard {
	export function acquire(options: AcquireSessionWriterGuardOptions): SessionWriterGuardHandle {
		validateIdentity(options.sessionId, "sessionId");
		validateIdentity(options.transcriptPath, "transcriptPath");
		const transcriptPath = path.resolve(options.transcriptPath);
		const lockRoot = path.resolve(options.lockRoot ?? path.join(getAgentDir(), "session-locks"));
		const dbPath = path.join(lockRoot, lockName(options.sessionId));
		const guardId = Bun.randomUUIDv7();

		const owned = liveLockRecords.get(dbPath);
		if (owned) {
			if (options.sameProcessOwner !== "share") {
				throw new SessionAlreadyOwnedError(options.sessionId, transcriptPath);
			}
			// Adopt in-process ownership: refresh the guard row inside the
			// already-held transaction, then hand out a sharing handle.
			owned.db
				.query("UPDATE writer_guard SET transcript_path = ?, guard_id = ?, acquired_at = ? WHERE singleton = 1")
				.run(transcriptPath, guardId, Date.now());
			owned.holders += 1;
			return new SqliteSessionWriterGuard(owned, options.sessionId, transcriptPath, guardId);
		}

		fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
		for (let attempt = 1; ; attempt++) {
			const db = new Database(dbPath, { create: true, strict: true });
			try {
				db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.min(options.busyTimeoutMs ?? 0, 60_000))}`);
				db.exec(LOCK_SCHEMA);
				db.run("BEGIN IMMEDIATE");
				const retiredNonce = db
					.query<{ nonce: string }, []>("SELECT nonce FROM retired WHERE singleton = 1")
					.get()?.nonce;
				if (retiredNonce !== undefined) {
					if (retiredNonceAtPath(dbPath) !== retiredNonce) {
						// We won the lock on a file its releaser already deleted; the live
						// lock file is whatever is at the path now. Try again there.
						db.run("ROLLBACK");
						db.close();
						if (attempt >= MAX_RETIRED_RETRIES)
							throw new SessionAlreadyOwnedError(options.sessionId, transcriptPath);
						continue;
					}
					// Deleting it failed (still open elsewhere on Windows): it is still the live lock file.
					db.run("DELETE FROM retired");
				}
				db.run("DELETE FROM writer_guard");
				db.query(
					"INSERT INTO writer_guard(singleton, session_id, transcript_path, guard_id, acquired_at) VALUES (1, ?, ?, ?, ?)",
				).run(options.sessionId, transcriptPath, guardId, Date.now());
				const record: GuardLockRecord = { dbPath, db, holders: 1 };
				liveLockRecords.set(dbPath, record);
				return new SqliteSessionWriterGuard(record, options.sessionId, transcriptPath, guardId);
			} catch (error) {
				if (error instanceof SessionAlreadyOwnedError) throw error;
				try {
					db.close();
				} catch {
					// Preserve the lock acquisition error.
				}
				const cause = toError(error);
				if (cause.message.includes("locked") || cause.message.includes("busy")) {
					throw new SessionAlreadyOwnedError(options.sessionId, transcriptPath, cause);
				}
				throw cause;
			}
		}
	}
}

export function isLiveSessionWriterGuard(
	guard: SessionWriterGuardHandle | undefined,
	sessionId: string,
): guard is SessionWriterGuardHandle {
	return guard !== undefined && !guard.released && guard.sessionId === sessionId;
}
