/**
 * Durable ledger for the gateway: jobs, the append-only event feed, request-id
 * keys, and every OAuth record the server issues (clients, grants, codes,
 * tokens, approval codes).
 *
 * `bun:sqlite`, WAL mode, migrations append-only in code. The store is the one
 * place state is written; the job engine and the HTTP layer read and write
 * through it so a restart loses nothing the protocol promised.
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { Job, JobEvent, JobState } from "../types";

const MIGRATIONS: string[] = [
	`CREATE TABLE jobs (
		id TEXT PRIMARY KEY,
		client_id TEXT NOT NULL,
		state TEXT NOT NULL,
		host TEXT NOT NULL,
		workspace TEXT NOT NULL,
		workspace_alias TEXT,
		title TEXT NOT NULL,
		task TEXT NOT NULL,
		model TEXT,
		timeout_seconds INTEGER,
		task_id TEXT,
		progress_text TEXT,
		progress_at INTEGER,
		last_error TEXT,
		created_at INTEGER NOT NULL,
		dispatched_at INTEGER,
		finished_at INTEGER
	);
	CREATE INDEX jobs_state ON jobs (state);
	CREATE INDEX jobs_host ON jobs (host, state);
	CREATE INDEX jobs_client ON jobs (client_id, created_at DESC);

	CREATE TABLE job_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id TEXT NOT NULL REFERENCES jobs (id),
		at INTEGER NOT NULL,
		type TEXT NOT NULL,
		detail TEXT
	);
	CREATE INDEX job_events_cursor ON job_events (id);

	CREATE TABLE idempotency_keys (
		client_id TEXT NOT NULL,
		tool TEXT NOT NULL,
		request_id TEXT NOT NULL,
		input_hash TEXT NOT NULL,
		job_id TEXT,
		outcome TEXT,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (client_id, tool, request_id)
	);

	CREATE TABLE oauth_clients (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		redirect_uris TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'oauth',
		created_at INTEGER NOT NULL,
		revoked_at INTEGER,
		counts_toward_limit INTEGER NOT NULL DEFAULT 1
	);

	CREATE TABLE oauth_grants (
		id TEXT PRIMARY KEY,
		client_id TEXT NOT NULL REFERENCES oauth_clients (id),
		scopes TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		revoked_at INTEGER
	);

	CREATE TABLE auth_codes (
		hash TEXT PRIMARY KEY,
		client_id TEXT NOT NULL,
		grant_id TEXT NOT NULL REFERENCES oauth_grants (id),
		redirect_uri TEXT NOT NULL,
		code_challenge TEXT NOT NULL,
		resource TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		used_at INTEGER
	);

	CREATE TABLE refresh_tokens (
		hash TEXT PRIMARY KEY,
		grant_id TEXT NOT NULL REFERENCES oauth_grants (id),
		parent_hash TEXT,
		access_hash TEXT NOT NULL,
		scopes TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER,
		rotated_at INTEGER,
		revoked_at INTEGER
	);

	CREATE TABLE access_tokens (
		hash TEXT PRIMARY KEY,
		grant_id TEXT NOT NULL REFERENCES oauth_grants (id),
		client_id TEXT NOT NULL,
		scopes TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		revoked_at INTEGER
	);
	CREATE INDEX access_tokens_expiry ON access_tokens (expires_at);

	CREATE TABLE approval_codes (
		hash TEXT PRIMARY KEY,
		label TEXT,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		used_at INTEGER
	);

	CREATE TABLE approval_failures (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		request_id TEXT,
		at INTEGER NOT NULL,
		counts_globally INTEGER NOT NULL DEFAULT 1
	);`,
];

function jobFromRow(row: Record<string, unknown>): Job {
	return {
		id: String(row.id),
		clientId: String(row.client_id),
		state: String(row.state) as JobState,
		host: String(row.host),
		workspace: String(row.workspace),
		workspaceAlias: (row.workspace_alias as string | null) ?? undefined,
		title: String(row.title),
		task: String(row.task),
		model: (row.model as string | null) ?? undefined,
		timeoutSeconds: (row.timeout_seconds as number | null) ?? undefined,
		taskId: (row.task_id as string | null) ?? undefined,
		progressText: (row.progress_text as string | null) ?? undefined,
		progressAt: (row.progress_at as number | null) ?? undefined,
		lastError: row.last_error ? (JSON.parse(String(row.last_error)) as Job["lastError"]) : undefined,
		createdAt: Number(row.created_at),
		dispatchedAt: (row.dispatched_at as number | null) ?? undefined,
		finishedAt: (row.finished_at as number | null) ?? undefined,
	};
}

export class Store {
	readonly db: Database;

	constructor(file: string) {
		this.db = new Database(file, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.#migrate();
	}

	#migrate() {
		const row = this.db.query("PRAGMA user_version").get() as { user_version: number };
		for (let i = row.user_version; i < MIGRATIONS.length; i += 1) {
			this.db.exec("BEGIN");
			try {
				this.db.exec(MIGRATIONS[i]);
				this.db.exec(`PRAGMA user_version = ${i + 1}`);
				this.db.exec("COMMIT");
			} catch (error) {
				this.db.exec("ROLLBACK");
				throw error;
			}
		}
	}

	close(): void {
		this.db.close();
	}

	/* ------------------------------- jobs -------------------------------- */

	insertJob(job: Job, firstEventDetail: Record<string, unknown>): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.query(
					`INSERT INTO jobs (id, client_id, state, host, workspace, workspace_alias, title, task, model, timeout_seconds, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					job.id,
					job.clientId,
					job.state,
					job.host,
					job.workspace,
					job.workspaceAlias ?? null,
					job.title,
					job.task,
					job.model ?? null,
					job.timeoutSeconds ?? null,
					job.createdAt,
				);
			this.#event(job.id, "created", firstEventDetail);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	#event(jobId: string, type: string, detail?: Record<string, unknown>): void {
		this.db
			.query("INSERT INTO job_events (job_id, at, type, detail) VALUES (?, ?, ?, ?)")
			.run(jobId, Date.now(), type, detail ? JSON.stringify(detail) : null);
	}

	getJob(id: string): Job | undefined {
		const row = this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | null;
		return row ? jobFromRow(row) : undefined;
	}

	listJobs(filter: { host?: string; workspace?: string; states?: JobState[]; limit?: number }): Job[] {
		const where: string[] = [];
		const args: SQLQueryBindings[] = [];
		if (filter.host) {
			where.push("host = ?");
			args.push(filter.host);
		}
		if (filter.workspace) {
			where.push("workspace_alias = ?");
			args.push(filter.workspace);
		}
		if (filter.states?.length) {
			where.push(`state IN (${filter.states.map(() => "?").join(",")})`);
			args.push(...filter.states);
		}
		const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000));
		const rows = this.db
			.query(
				`SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
			)
			.all(...args, limit) as Record<string, unknown>[];
		return rows.map(jobFromRow);
	}

	openJobs(): Job[] {
		const rows = this.db
			.query("SELECT * FROM jobs WHERE state IN ('queued','dispatching','running','cancel_requested','unknown')")
			.all() as Record<string, unknown>[];
		return rows.map(jobFromRow);
	}

	countJobsByState(host: string, states: readonly string[]): number {
		const marks = states.map(() => "?").join(",");
		const row = this.db
			.query(`SELECT COUNT(*) AS n FROM jobs WHERE host = ? AND state IN (${marks})`)
			.get(host, ...states) as { n: number };
		return Number(row.n);
	}

	/** Transition a job, append the event, and stamp fields — one transaction. */
	updateJob(
		id: string,
		patch: Partial<Job>,
		event: { type: string; detail?: Record<string, unknown> } | undefined,
	): void {
		const fields: string[] = [];
		const args: SQLQueryBindings[] = [];
		const set = (col: string, value: unknown) => {
			fields.push(`${col} = ?`);
			args.push((value ?? null) as SQLQueryBindings);
		};
		if (patch.state !== undefined) set("state", patch.state);
		if (patch.taskId !== undefined) set("task_id", patch.taskId);
		if (patch.progressText !== undefined) set("progress_text", patch.progressText);
		if (patch.progressAt !== undefined) set("progress_at", patch.progressAt);
		if (patch.lastError !== undefined) set("last_error", patch.lastError ? JSON.stringify(patch.lastError) : null);
		if (patch.dispatchedAt !== undefined) set("dispatched_at", patch.dispatchedAt);
		if (patch.finishedAt !== undefined) set("finished_at", patch.finishedAt);
		if (fields.length === 0 && !event) return;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (fields.length) {
				this.db.query(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`).run(...args, id);
			}
			if (event) this.#event(id, event.type, event.detail);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	appendEvent(jobId: string, type: string, detail?: Record<string, unknown>): void {
		this.#event(jobId, type, detail);
	}

	eventsSince(cursor: number, limit: number, jobId?: string): { events: JobEvent[]; next: number } {
		const rows =
			jobId === undefined
				? (this.db
						.query("SELECT * FROM job_events WHERE id > ? ORDER BY id ASC LIMIT ?")
						.all(cursor, limit) as Record<string, unknown>[])
				: (this.db
						.query("SELECT * FROM job_events WHERE id > ? AND job_id = ? ORDER BY id ASC LIMIT ?")
						.all(cursor, jobId, limit) as Record<string, unknown>[]);
		const events = rows.map(r => ({
			id: Number(r.id),
			jobId: String(r.job_id),
			at: Number(r.at),
			type: String(r.type),
			detail: r.detail ? (JSON.parse(String(r.detail)) as Record<string, unknown>) : undefined,
		}));
		return { events, next: events.length ? events[events.length - 1].id : cursor };
	}

	/* --------------------------- idempotency ----------------------------- */

	lookupRequest(
		clientId: string,
		tool: string,
		requestId: string,
	): { inputHash: string; jobId?: string; outcome?: string } | undefined {
		const row = this.db
			.query(
				"SELECT input_hash, job_id, outcome FROM idempotency_keys WHERE client_id = ? AND tool = ? AND request_id = ?",
			)
			.get(clientId, tool, requestId) as Record<string, unknown> | null;
		return row
			? {
					inputHash: String(row.input_hash),
					jobId: (row.job_id as string | null) ?? undefined,
					outcome: (row.outcome as string | null) ?? undefined,
				}
			: undefined;
	}

	recordRequest(clientId: string, tool: string, requestId: string, inputHash: string, jobId: string | null): void {
		this.db
			.query(
				`INSERT INTO idempotency_keys (client_id, tool, request_id, input_hash, job_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (client_id, tool, request_id) DO NOTHING`,
			)
			.run(clientId, tool, requestId, inputHash, jobId, Date.now());
	}

	/* ------------------------------ OAuth -------------------------------- */

	insertClient(client: { id: string; name: string; redirectUris: string[]; kind: "oauth" | "bearer" }): void {
		this.db
			.query(
				"INSERT INTO oauth_clients (id, name, redirect_uris, kind, created_at, counts_toward_limit) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				client.id,
				client.name,
				JSON.stringify(client.redirectUris),
				client.kind,
				Date.now(),
				client.kind === "oauth" ? 1 : 0,
			);
	}

	getClient(id: string):
		| {
				id: string;
				name: string;
				redirectUris: string[];
				kind: string;
				revokedAt?: number;
				countsTowardLimit: boolean;
		  }
		| undefined {
		const row = this.db.query("SELECT * FROM oauth_clients WHERE id = ?").get(id) as Record<string, unknown> | null;
		if (!row) return undefined;
		return {
			id: String(row.id),
			name: String(row.name),
			redirectUris: JSON.parse(String(row.redirect_uris)) as string[],
			kind: String(row.kind),
			revokedAt: (row.revoked_at as number | null) ?? undefined,
			countsTowardLimit: row.counts_toward_limit === 1,
		};
	}

	listClients(): Array<{ id: string; name: string; kind: string; createdAt: number; revokedAt?: number }> {
		const rows = this.db
			.query("SELECT id, name, kind, created_at, revoked_at FROM oauth_clients ORDER BY created_at DESC")
			.all() as Record<string, unknown>[];
		return rows.map(r => ({
			id: String(r.id),
			name: String(r.name),
			kind: String(r.kind),
			createdAt: Number(r.created_at),
			revokedAt: (r.revoked_at as number | null) ?? undefined,
		}));
	}

	revokeClient(id: string): void {
		const now = Date.now();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.query("UPDATE oauth_clients SET revoked_at = ? WHERE id = ?").run(now, id);
			this.db.query("UPDATE access_tokens SET revoked_at = ? WHERE client_id = ?").run(now, id);
			this.db
				.query(
					"UPDATE refresh_tokens SET revoked_at = ? WHERE grant_id IN (SELECT id FROM oauth_grants WHERE client_id = ?)",
				)
				.run(now, id);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	countRegistrations(sinceMs: number): number {
		const row = this.db
			.query(
				"SELECT COUNT(*) AS n FROM oauth_clients WHERE kind = 'oauth' AND counts_toward_limit = 1 AND created_at >= ?",
			)
			.get(sinceMs) as { n: number };
		return Number(row.n);
	}

	insertGrant(grant: { id: string; clientId: string; scopes: string }): void {
		this.db
			.query("INSERT INTO oauth_grants (id, client_id, scopes, created_at) VALUES (?, ?, ?, ?)")
			.run(grant.id, grant.clientId, grant.scopes, Date.now());
	}

	getGrant(id: string): { id: string; clientId: string; scopes: string; revokedAt?: number } | undefined {
		const row = this.db.query("SELECT * FROM oauth_grants WHERE id = ?").get(id) as Record<string, unknown> | null;
		return row
			? {
					id: String(row.id),
					clientId: String(row.client_id),
					scopes: String(row.scopes),
					revokedAt: (row.revoked_at as number | null) ?? undefined,
				}
			: undefined;
	}

	insertAuthCode(code: {
		hash: string;
		clientId: string;
		grantId: string;
		redirectUri: string;
		codeChallenge: string;
		resource: string;
		expiresAt: number;
	}): void {
		this.db
			.query(
				"INSERT INTO auth_codes (hash, client_id, grant_id, redirect_uri, code_challenge, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				code.hash,
				code.clientId,
				code.grantId,
				code.redirectUri,
				code.codeChallenge,
				code.resource,
				Date.now(),
				code.expiresAt,
			);
	}

	redeemApprovalCode(hash: string): "ok" | "expired" | "used" | "unknown" {
		const row = this.db.query("SELECT expires_at, used_at FROM approval_codes WHERE hash = ?").get(hash) as Record<
			string,
			unknown
		> | null;
		if (!row) return "unknown";
		if (row.used_at) return "used";
		if (Number(row.expires_at) < Date.now()) return "expired";
		// Single-use is enforced atomically: two calls racing the same code get
		// exactly one changed row.
		const changed = this.db
			.query("UPDATE approval_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL")
			.run(Date.now(), hash).changes;
		return changed === 1 ? "ok" : "used";
	}

	useAuthCode(hash: string): void {
		this.db.query("UPDATE auth_codes SET used_at = ? WHERE hash = ?").run(Date.now(), hash);
	}

	insertAccessToken(token: {
		hash: string;
		grantId: string;
		clientId: string;
		scopes: string;
		expiresAt: number;
	}): void {
		this.db
			.query(
				"INSERT INTO access_tokens (hash, grant_id, client_id, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(token.hash, token.grantId, token.clientId, token.scopes, Date.now(), token.expiresAt);
	}

	getAccessToken(
		hash: string,
	): { grantId: string; clientId: string; scopes: string; expiresAt: number; revokedAt?: number } | undefined {
		const row = this.db.query("SELECT * FROM access_tokens WHERE hash = ?").get(hash) as Record<
			string,
			unknown
		> | null;
		return row
			? {
					grantId: String(row.grant_id),
					clientId: String(row.client_id),
					scopes: String(row.scopes),
					expiresAt: Number(row.expires_at),
					revokedAt: (row.revoked_at as number | null) ?? undefined,
				}
			: undefined;
	}

	revokeAccessTokensForGrant(grantId: string): void {
		this.db.query("UPDATE access_tokens SET revoked_at = ? WHERE grant_id = ?").run(Date.now(), grantId);
	}

	insertRefreshToken(token: {
		hash: string;
		grantId: string;
		parentHash?: string;
		accessHash: string;
		scopes: string;
	}): void {
		this.db
			.query(
				"INSERT INTO refresh_tokens (hash, grant_id, parent_hash, access_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(token.hash, token.grantId, token.parentHash ?? null, token.accessHash, token.scopes, Date.now());
	}

	getRefreshToken(hash: string):
		| {
				grantId: string;
				parentHash?: string;
				accessHash: string;
				scopes: string;
				createdAt: number;
				lastUsedAt?: number;
				rotatedAt?: number;
				revokedAt?: number;
		  }
		| undefined {
		const row = this.db.query("SELECT * FROM refresh_tokens WHERE hash = ?").get(hash) as Record<
			string,
			unknown
		> | null;
		return row
			? {
					grantId: String(row.grant_id),
					parentHash: (row.parent_hash as string | null) ?? undefined,
					accessHash: String(row.access_hash),
					scopes: String(row.scopes),
					createdAt: Number(row.created_at),
					lastUsedAt: (row.last_used_at as number | null) ?? undefined,
					rotatedAt: (row.rotated_at as number | null) ?? undefined,
					revokedAt: (row.revoked_at as number | null) ?? undefined,
				}
			: undefined;
	}

	rotateRefreshToken(oldHash: string, replacement: { hash: string; accessHash: string }): void {
		const now = Date.now();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.query("UPDATE refresh_tokens SET rotated_at = ?, last_used_at = ? WHERE hash = ?")
				.run(now, now, oldHash);
			this.db.query("UPDATE refresh_tokens SET last_used_at = ? WHERE hash = ?").run(now, replacement.hash);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	revokeTokenFamily(grantId: string): void {
		const now = Date.now();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.query("UPDATE refresh_tokens SET revoked_at = ? WHERE grant_id = ?").run(now, grantId);
			this.db.query("UPDATE access_tokens SET revoked_at = ? WHERE grant_id = ?").run(now, grantId);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/* --------------------------- approval codes -------------------------- */

	insertApprovalCode(code: { hash: string; label?: string; expiresAt: number }): void {
		this.db
			.query("INSERT INTO approval_codes (hash, label, created_at, expires_at) VALUES (?, ?, ?, ?)")
			.run(code.hash, code.label ?? null, Date.now(), code.expiresAt);
	}

	getAuthCode(hash: string):
		| {
				clientId: string;
				grantId: string;
				redirectUri: string;
				codeChallenge: string;
				resource: string;
				expiresAt: number;
				usedAt?: number;
		  }
		| undefined {
		const row = this.db.query("SELECT * FROM auth_codes WHERE hash = ?").get(hash) as Record<string, unknown> | null;
		return row
			? {
					clientId: String(row.client_id),
					grantId: String(row.grant_id),
					redirectUri: String(row.redirect_uri),
					codeChallenge: String(row.code_challenge),
					resource: String(row.resource),
					expiresAt: Number(row.expires_at),
					usedAt: (row.used_at as number | null) ?? undefined,
				}
			: undefined;
	}
	recordApprovalFailure(requestId: string | null): void {
		this.db.query("INSERT INTO approval_failures (request_id, at) VALUES (?, ?)").run(requestId, Date.now());
	}

	approvalFailures(requestId: string | null, sinceMs: number): number {
		const row = this.db
			.query("SELECT COUNT(*) AS n FROM approval_failures WHERE request_id IS ? AND at >= ?")
			.get(requestId, sinceMs) as { n: number };
		return Number(row.n);
	}

	globalApprovalFailures(sinceMs: number): number {
		const row = this.db
			.query("SELECT COUNT(*) AS n FROM approval_failures WHERE counts_globally = 1 AND at >= ?")
			.get(sinceMs) as { n: number };
		return Number(row.n);
	}

	/** Minting a new code ends the global lockout: past failures stop counting. */
	resetGlobalApprovalFailures(): void {
		this.db.query("UPDATE approval_failures SET counts_globally = 0").run();
	}
}
