import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils";
import {
	type AgentRole,
	type ArtifactRefV1,
	bindLaunchContract,
	type CompiledLaunchContract,
	canonicalJson,
	compareRuntimeGuarantees,
	type GrantRecordV1,
	LAUNCH_CONTRACT_VERSION,
	type LaunchBinding,
	type LaunchBindingInput,
	type LifecycleHandoffV1,
	type ObligationV1,
	parseGrantRecordV1,
	parseObligationV1,
	parseReservationVector,
	parseRunLimitsV1,
	type RunLimitsV1,
	type RuntimeGuaranteesV1,
	sha256Hex,
} from "../task/launch-contract";
import type {
	CaptureDimension,
	ContextDeliveryRequest,
	ContextDeliveryResult,
	DeliveryDimension,
	DeliveryRecordV1,
	ExecutionDimension,
	GrantIssueRequest,
	GrantIssueResult,
	LaunchAuthorityAdmissionInput,
	LaunchAuthorityAdmissionResult,
	LaunchAuthorityFailure,
	LaunchBindingActivationInput,
	LaunchBindingActivationResult,
	LaunchMutationGuard,
	LifecycleAdmissionInput,
	LifecycleAdmissionResult,
	LifecycleCancellationInput,
	LifecycleCancellationResult,
	LifecycleRunOutcome,
	LifecycleRunSnapshot,
	LifecycleSettlementInput,
	LifecycleSettlementResult,
	LifecycleUsageInput,
	ObligationTransitionInput,
	PlannerActivity,
	PlannerTurnCommitInput,
	PlannerTurnCommitResult,
	PlannerTurnInput,
	PlannerTurnRecord,
	PublicationDimension,
	VerificationDimension,
} from "./lifecycle-types";
import {
	type AppendEventInput,
	type CreateEpisodeInput,
	type CreateJobInput,
	type CreateNotificationInput,
	DEFAULT_MAX_EVENT_PAYLOAD_BYTES,
	type DurableJob,
	type EpisodeRecord,
	type EpisodeSearchOptions,
	type EventListFilter,
	JOB_STATUSES,
	type JobCheckpoint,
	type JobListFilter,
	type JobStatus,
	type JobTransitionInput,
	type JsonObject,
	type JsonValue,
	type MaterializeDueScheduleInput,
	type NotificationRecord,
	type RecurringSchedule,
	type ScopedStateEntry,
	type StateScope,
	TRAJECTORY_EVENT_KINDS,
	type TrajectoryEvent,
	type TrajectoryEventKind,
	type UpsertScheduleInput,
} from "./types";

/**
 * Raised when a persisted lifecycle record is absent, incomplete, or cannot be
 * projected into its frozen wire shape. Adapters translate these into local
 * failure outcomes; they are never swallowed into a fabricated success value.
 */
export class LifecycleReadError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "LifecycleReadError";
		this.code = code;
	}
}

interface LifecycleRunRow {
	readonly run_id: string;
	readonly outcome: LifecycleRunOutcome;
	readonly plan_version: number;
	readonly cancellation_generation: number;
	readonly limits_json: string;
	readonly consumed_json: string;
	readonly reserved_json: string;
}

interface LifecycleNodeRow {
	readonly node_id: string;
	readonly owner_node_id: string | null;
	readonly depth: number;
	readonly role: AgentRole;
	readonly current_attempt_id: string | null;
	readonly session_id: string | null;
	readonly session_generation: number;
	readonly planner_activity: PlannerActivity;
}

interface LifecycleAttemptRow {
	readonly attempt_id: string;
	readonly node_id: string;
	readonly job_id: string | null;
	readonly contract_ref: string;
	readonly lease_owner: string | null;
	readonly lease_epoch: number;
	readonly cancellation_generation: number;
	readonly execution_state: ExecutionDimension;
	readonly capture_state: CaptureDimension;
	readonly delivery_state: DeliveryDimension;
	readonly publication_state: PublicationDimension;
	readonly verification_state: VerificationDimension;
	readonly manifest_ref: string | null;
}

interface LifecycleObligationRow {
	readonly obligation_id: string;
	readonly run_id: string;
	readonly node_id: string;
	readonly criterion_id: string;
	readonly kind: string;
	readonly state: string;
	readonly evidence_receipt_ids_json: string;
	readonly waiver_authorization_ref: string | null;
	readonly version: number;
}

const SCHEMA_VERSION = 4;
const DEFAULT_LEASE_MS = 60_000;
/**
 * Episode search prefers FTS5 (`episodes_fts`) when available.
 * If FTS5 cannot be created, search falls back to indexed LIKE over
 * `search_text` (title + summary + tags), which remains useful across sessions.
 */

const ALLOWED_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
	queued: ["running", "paused", "cancelled"],
	running: ["paused", "completed", "failed", "cancelled", "queued"],
	paused: ["running", "cancelled", "queued"],
	completed: [],
	failed: ["queued"],
	cancelled: [],
};

type ScopeKind = "user" | "project";

type StateRow = {
	scope_kind: ScopeKind;
	project_path: string;
	key: string;
	value_json: string;
	updated_at: number;
};

type EpisodeRow = {
	id: string;
	session_id: string;
	title: string;
	summary: string;
	tags_json: string;
	metadata_json: string;
	search_text: string;
	created_at: number;
	updated_at: number;
};

type JobRow = {
	id: string;
	type: string;
	status: string;
	payload_json: string;
	result_json: string | null;
	error: string | null;
	lease_owner: string | null;
	lease_expires_at: number | null;
	checkpoint_json: string | null;
	schedule_id: string | null;
	created_at: number;
	updated_at: number;
	started_at: number | null;
	completed_at: number | null;
};

type ScheduleRow = {
	id: string;
	name: string;
	cron: string;
	next_run_at: number | null;
	enabled: number;
	payload_json: string;
	created_at: number;
	updated_at: number;
};

type NotificationRow = {
	id: string;
	kind: string;
	title: string;
	body: string;
	read: number;
	metadata_json: string;
	created_at: number;
};

type EventRow = {
	id: string;
	kind: string;
	job_id: string | null;
	session_id: string | null;
	payload_json: string;
	created_at: number;
};

export interface OperationalStoreOptions {
	/** Explicit SQLite path. Defaults to `~/.ompk/agent/operational.db`. */
	readonly dbPath?: string;
	/** Injected clock (epoch ms) for deterministic tests. */
	readonly now?: () => number;
	/** Injected id factory for deterministic tests. */
	readonly createId?: () => string;
	/** Max UTF-8 bytes for serialized trajectory event payloads. */
	readonly maxEventPayloadBytes?: number;
	/** SQLite synchronous mode. Production defaults to `full`; tests may opt into `normal`. */
	readonly durability?: "full" | "normal";
}

function defaultDbPath(): string {
	return path.join(getAgentDir(), "operational.db");
}

function defaultCreateId(): string {
	return Bun.randomUUIDv7();
}

function isJobStatus(value: string): value is JobStatus {
	return (JOB_STATUSES as readonly string[]).includes(value);
}

function isEventKind(value: string): value is TrajectoryEventKind {
	return (TRAJECTORY_EVENT_KINDS as readonly string[]).includes(value);
}

function escapeLikePattern(text: string): string {
	return text.replace(/[\\%_]/g, "\\$&");
}

function tokenize(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9]+/i)
		.map(token => token.trim())
		.filter(token => token.length > 0);
}

/**
 * Safe JSON serialization for operational payloads.
 * Drops `undefined`, converts `bigint` to string, and replaces cycles / non-JSON
 * values with `null` rather than throwing.
 */
export function serializeJsonValue(value: unknown): string {
	const seen = new WeakSet<object>();
	return (
		JSON.stringify(value, (_key, current: unknown) => {
			if (current === undefined) return undefined;
			if (typeof current === "bigint") return current.toString();
			if (typeof current === "function" || typeof current === "symbol") return null;
			if (current !== null && typeof current === "object") {
				if (seen.has(current)) return null;
				seen.add(current);
			}
			return current;
		}) ?? "null"
	);
}

export function parseJsonValue(raw: string | null | undefined): JsonValue {
	if (raw === null || raw === undefined || raw === "") return null;
	try {
		return JSON.parse(raw) as JsonValue;
	} catch {
		return null;
	}
}

export function capJsonPayload(value: JsonValue, maxBytes: number): JsonValue {
	const serialized = serializeJsonValue(value);
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes <= maxBytes) return value;

	const previewBudget = Math.max(64, Math.min(maxBytes - 128, 2048));
	let preview = serialized;
	while (Buffer.byteLength(preview, "utf8") > previewBudget && preview.length > 0) {
		preview = preview.slice(0, Math.floor(preview.length * 0.85));
	}

	const capped: JsonObject = {
		truncated: true,
		originalBytes: bytes,
		maxBytes,
		preview,
	};
	return capped;
}

function normalizeScope(scope: StateScope): { scopeKind: ScopeKind; projectPath: string } {
	if (scope.kind === "user") {
		return { scopeKind: "user", projectPath: "" };
	}
	const projectPath = scope.projectPath.trim();
	if (!projectPath) {
		throw new Error("project scope requires a non-empty projectPath");
	}
	return { scopeKind: "project", projectPath };
}

function scopeFromRow(row: Pick<StateRow, "scope_kind" | "project_path">): StateScope {
	if (row.scope_kind === "project") {
		return { kind: "project", projectPath: row.project_path };
	}
	return { kind: "user" };
}

function episodeSearchText(title: string, summary: string, tags: readonly string[]): string {
	return `${title}\n${summary}\n${tags.join(" ")}`.trim();
}

export class OperationalStore {
	readonly #db: Database;
	readonly #dbPath: string;
	readonly #now: () => number;
	readonly #createId: () => string;
	readonly #maxEventPayloadBytes: number;
	readonly #ftsEnabled: boolean;
	#closed = false;

	readonly #setStateStmt: Statement;
	readonly #getStateStmt: Statement;
	readonly #deleteStateStmt: Statement;
	readonly #listStateStmt: Statement;
	readonly #listStatePrefixStmt: Statement;

	readonly #insertEpisodeStmt: Statement;
	readonly #getEpisodeStmt: Statement;
	readonly #listEpisodesStmt: Statement;
	readonly #searchEpisodesLikeStmt: Statement;
	#searchEpisodesFtsStmt: Statement | null = null;
	#insertEpisodeFtsStmt: Statement | null = null;

	readonly #insertJobStmt: Statement;
	readonly #getJobStmt: Statement;
	readonly #updateJobStmt: Statement;
	readonly #selectClaimCandidateStmt: Statement;
	readonly #selectExpiredRunningStmt: Statement;

	readonly #upsertScheduleStmt: Statement;
	readonly #getScheduleStmt: Statement;
	readonly #listSchedulesStmt: Statement;
	readonly #listDueSchedulesStmt: Statement;
	readonly #casScheduleNextRunStmt: Statement;

	readonly #insertNotificationStmt: Statement;
	readonly #listNotificationsStmt: Statement;
	readonly #markNotificationReadStmt: Statement;

	readonly #insertEventStmt: Statement;
	readonly #listEventsStmt: Statement;

	constructor(options: OperationalStoreOptions = {}) {
		this.#dbPath = options.dbPath ?? defaultDbPath();
		this.#now = options.now ?? (() => Date.now());
		this.#createId = options.createId ?? defaultCreateId;
		this.#maxEventPayloadBytes = options.maxEventPayloadBytes ?? DEFAULT_MAX_EVENT_PAYLOAD_BYTES;

		fs.mkdirSync(path.dirname(this.#dbPath), { recursive: true });
		this.#db = new Database(this.#dbPath);
		// 30s rather than 5s: all mutations use BEGIN IMMEDIATE, so writers
		// queue on the write lock rather than deadlocking. Under concurrent
		// load (independent processes plus long integration tests), a 5s wait
		// was exceeded and admissions failed with SQLITE_BUSY despite the
		// protocol being correct.
		this.#db.run("PRAGMA busy_timeout = 30000");
		this.#db.run("PRAGMA journal_mode = WAL");
		this.#db.run(`PRAGMA synchronous = ${options.durability === "normal" ? "NORMAL" : "FULL"}`);
		this.#db.run("PRAGMA foreign_keys = ON");
		this.#initializeSchema();
		this.#ftsEnabled = this.#ensureEpisodeFts();

		this.#setStateStmt = this.#db.prepare(
			`INSERT INTO scoped_state (scope_kind, project_path, key, value_json, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(scope_kind, project_path, key) DO UPDATE SET
			   value_json = excluded.value_json,
			   updated_at = excluded.updated_at`,
		);
		this.#getStateStmt = this.#db.prepare(
			"SELECT scope_kind, project_path, key, value_json, updated_at FROM scoped_state WHERE scope_kind = ? AND project_path = ? AND key = ?",
		);
		this.#deleteStateStmt = this.#db.prepare(
			"DELETE FROM scoped_state WHERE scope_kind = ? AND project_path = ? AND key = ?",
		);
		this.#listStateStmt = this.#db.prepare(
			"SELECT scope_kind, project_path, key, value_json, updated_at FROM scoped_state WHERE scope_kind = ? AND project_path = ? ORDER BY key ASC",
		);
		this.#listStatePrefixStmt = this.#db.prepare(
			`SELECT scope_kind, project_path, key, value_json, updated_at FROM scoped_state
			 WHERE scope_kind = ? AND project_path = ? AND key LIKE ? ESCAPE '\\'
			 ORDER BY key ASC`,
		);

		this.#insertEpisodeStmt = this.#db.prepare(
			`INSERT INTO episodes (id, session_id, title, summary, tags_json, metadata_json, search_text, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.#getEpisodeStmt = this.#db.prepare("SELECT * FROM episodes WHERE id = ?");
		this.#listEpisodesStmt = this.#db.prepare("SELECT * FROM episodes ORDER BY created_at DESC, id DESC LIMIT ?");
		this.#searchEpisodesLikeStmt = this.#db.prepare(
			`SELECT * FROM episodes
			 WHERE search_text LIKE ? ESCAPE '\\'
			   AND (? IS NULL OR session_id = ?)
			 ORDER BY created_at DESC, id DESC
			 LIMIT ?`,
		);
		if (this.#ftsEnabled) {
			this.#searchEpisodesFtsStmt = this.#db.prepare(
				`SELECT e.* FROM episodes_fts f
				 JOIN episodes e ON e.id = f.episode_id
				 WHERE episodes_fts MATCH ?
				   AND (? IS NULL OR e.session_id = ?)
				 ORDER BY e.created_at DESC, e.id DESC
				 LIMIT ?`,
			);
			this.#insertEpisodeFtsStmt = this.#db.prepare(
				"INSERT INTO episodes_fts(episode_id, title, summary, tags, search_text) VALUES (?, ?, ?, ?, ?)",
			);
		}

		this.#insertJobStmt = this.#db.prepare(
			`INSERT INTO jobs (
				id, type, status, payload_json, result_json, error, lease_owner, lease_expires_at,
				checkpoint_json, schedule_id, created_at, updated_at, started_at, completed_at
			) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL)`,
		);
		this.#getJobStmt = this.#db.prepare("SELECT * FROM jobs WHERE id = ?");
		this.#updateJobStmt = this.#db.prepare(
			`UPDATE jobs SET
				status = ?, result_json = ?, error = ?, lease_owner = ?, lease_expires_at = ?,
				checkpoint_json = ?, updated_at = ?, started_at = ?, completed_at = ?
			 WHERE id = ?`,
		);
		this.#selectClaimCandidateStmt = this.#db.prepare(
			`SELECT * FROM jobs WHERE status = 'queued' AND (? IS NULL OR type = ?)
			 ORDER BY created_at ASC, id ASC LIMIT 1`,
		);
		this.#selectExpiredRunningStmt = this.#db.prepare(
			`SELECT * FROM jobs
			 WHERE status = 'running'
			   AND lease_expires_at IS NOT NULL
			   AND lease_expires_at < ?
			 ORDER BY lease_expires_at ASC, id ASC`,
		);

		this.#upsertScheduleStmt = this.#db.prepare(
			`INSERT INTO schedules (id, name, cron, next_run_at, enabled, payload_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   name = excluded.name,
			   cron = excluded.cron,
			   next_run_at = excluded.next_run_at,
			   enabled = excluded.enabled,
			   payload_json = excluded.payload_json,
			   updated_at = excluded.updated_at`,
		);
		this.#getScheduleStmt = this.#db.prepare("SELECT * FROM schedules WHERE id = ?");
		this.#listSchedulesStmt = this.#db.prepare("SELECT * FROM schedules ORDER BY name ASC, id ASC");
		this.#listDueSchedulesStmt = this.#db.prepare(
			`SELECT * FROM schedules
			 WHERE enabled = 1
			   AND next_run_at IS NOT NULL
			   AND next_run_at <= ?
			 ORDER BY next_run_at ASC, id ASC`,
		);
		this.#casScheduleNextRunStmt = this.#db.prepare(
			`UPDATE schedules
			 SET next_run_at = ?, updated_at = ?
			 WHERE id = ?
			   AND enabled = 1
			   AND next_run_at = ?`,
		);

		this.#insertNotificationStmt = this.#db.prepare(
			`INSERT INTO notifications (id, kind, title, body, read, metadata_json, created_at)
			 VALUES (?, ?, ?, ?, 0, ?, ?)`,
		);
		this.#listNotificationsStmt = this.#db.prepare(
			"SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ?",
		);
		this.#markNotificationReadStmt = this.#db.prepare("UPDATE notifications SET read = 1 WHERE id = ?");

		this.#insertEventStmt = this.#db.prepare(
			`INSERT INTO trajectory_events (id, kind, job_id, session_id, payload_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		this.#listEventsStmt = this.#db.prepare(
			`SELECT * FROM trajectory_events
			 WHERE (? IS NULL OR kind = ?)
			   AND (? IS NULL OR job_id = ?)
			   AND (? IS NULL OR session_id = ?)
			   AND (? IS NULL OR created_at > ?)
			 ORDER BY created_at ASC, id ASC
			 LIMIT ?`,
		);
	}

	/** Open (or create) the operational SQLite database. */
	static open(options: OperationalStoreOptions = {}): OperationalStore {
		return new OperationalStore(options);
	}

	get dbPath(): string {
		return this.#dbPath;
	}

	get ftsEnabled(): boolean {
		return this.#ftsEnabled;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#setStateStmt.finalize();
		this.#getStateStmt.finalize();
		this.#deleteStateStmt.finalize();
		this.#listStateStmt.finalize();
		this.#listStatePrefixStmt.finalize();
		this.#insertEpisodeStmt.finalize();
		this.#getEpisodeStmt.finalize();
		this.#listEpisodesStmt.finalize();
		this.#searchEpisodesLikeStmt.finalize();
		this.#searchEpisodesFtsStmt?.finalize();
		this.#insertEpisodeFtsStmt?.finalize();
		this.#insertJobStmt.finalize();
		this.#getJobStmt.finalize();
		this.#updateJobStmt.finalize();
		this.#selectClaimCandidateStmt.finalize();
		this.#selectExpiredRunningStmt.finalize();
		this.#upsertScheduleStmt.finalize();
		this.#getScheduleStmt.finalize();
		this.#listSchedulesStmt.finalize();
		this.#listDueSchedulesStmt.finalize();
		this.#casScheduleNextRunStmt.finalize();
		this.#insertNotificationStmt.finalize();
		this.#listNotificationsStmt.finalize();
		this.#markNotificationReadStmt.finalize();
		this.#insertEventStmt.finalize();
		this.#listEventsStmt.finalize();
		this.#db.close();
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("OperationalStore is closed");
	}

	#initializeSchema(): void {
		this.#db.run(`
CREATE TABLE IF NOT EXISTS schema_version (
	version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS scoped_state (
	scope_kind TEXT NOT NULL CHECK(scope_kind IN ('user', 'project')),
	project_path TEXT NOT NULL DEFAULT '',
	key TEXT NOT NULL,
	value_json TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (scope_kind, project_path, key)
);
CREATE INDEX IF NOT EXISTS idx_scoped_state_scope ON scoped_state(scope_kind, project_path);

CREATE TABLE IF NOT EXISTS episodes (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	title TEXT NOT NULL,
	summary TEXT NOT NULL,
	tags_json TEXT NOT NULL,
	metadata_json TEXT NOT NULL,
	search_text TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_session_created ON episodes(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_search_text ON episodes(search_text);

CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('queued','running','paused','completed','failed','cancelled')),
	payload_json TEXT NOT NULL,
	result_json TEXT,
	error TEXT,
	lease_owner TEXT,
	lease_expires_at INTEGER,
	checkpoint_json TEXT,
	schedule_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	started_at INTEGER,
	completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_jobs_type_status ON jobs(type, status);
CREATE INDEX IF NOT EXISTS idx_jobs_lease_expires ON jobs(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS schedules (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	cron TEXT NOT NULL,
	next_run_at INTEGER,
	enabled INTEGER NOT NULL DEFAULT 1,
	payload_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS notifications (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	read INTEGER NOT NULL DEFAULT 0,
	metadata_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

CREATE TABLE IF NOT EXISTS trajectory_events (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	job_id TEXT,
	session_id TEXT,
	payload_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON trajectory_events(created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_events_kind_created ON trajectory_events(kind, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_events_job ON trajectory_events(job_id, created_at ASC);
`);

		const versionRow = this.#db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
			| { version?: number }
			| undefined;
		const current = typeof versionRow?.version === "number" ? versionRow.version : 0;
		if (current > SCHEMA_VERSION) {
			throw new Error(`Operational database schema ${current} is newer than supported version ${SCHEMA_VERSION}`);
		}
		if (current < SCHEMA_VERSION) {
			this.#migrateSchema(current);
			this.#db.prepare("INSERT OR REPLACE INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
		}
	}

	#migrateSchema(fromVersion: number): void {
		if (fromVersion < 2) {
			this.#db.run(`
CREATE TABLE IF NOT EXISTS lifecycle_runs (
	run_id TEXT PRIMARY KEY,
	contract_ref TEXT NOT NULL,
	policy_ref TEXT NOT NULL,
	harness_ref TEXT NOT NULL,
	outcome TEXT NOT NULL CHECK(outcome IN ('active','completed','partial','blocked','failed','cancelled')),
	plan_version INTEGER NOT NULL DEFAULT 1,
	cancellation_generation INTEGER NOT NULL DEFAULT 0,
	root_snapshot_ref TEXT,
	limits_json TEXT NOT NULL,
	consumed_json TEXT NOT NULL,
	reserved_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lifecycle_nodes (
	node_id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES lifecycle_runs(run_id) ON DELETE CASCADE,
	owner_node_id TEXT REFERENCES lifecycle_nodes(node_id),
	depth INTEGER NOT NULL DEFAULT 0,
	role TEXT NOT NULL CHECK(role IN ('root-planner','subplanner','worker','verifier')),
	compiled_contract_ref TEXT NOT NULL,
	planner_activity TEXT NOT NULL DEFAULT 'ready' CHECK(planner_activity IN ('ready','planning','waiting','blocked','quiescent')),
	current_attempt_id TEXT,
	session_id TEXT,
	session_generation INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_nodes_run ON lifecycle_nodes(run_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_nodes_owner ON lifecycle_nodes(owner_node_id);

CREATE TABLE IF NOT EXISTS lifecycle_dependencies (
	node_id TEXT NOT NULL REFERENCES lifecycle_nodes(node_id) ON DELETE CASCADE,
	prerequisite_id TEXT NOT NULL REFERENCES lifecycle_nodes(node_id) ON DELETE CASCADE,
	PRIMARY KEY (node_id, prerequisite_id)
);

CREATE TABLE IF NOT EXISTS lifecycle_attempts (
	attempt_id TEXT PRIMARY KEY,
	node_id TEXT NOT NULL REFERENCES lifecycle_nodes(node_id) ON DELETE CASCADE,
	ordinal INTEGER NOT NULL,
	job_id TEXT UNIQUE REFERENCES jobs(id),
	contract_ref TEXT NOT NULL,
	harness_ref TEXT NOT NULL,
	lease_owner TEXT,
	lease_epoch INTEGER NOT NULL DEFAULT 1,
	cancellation_generation INTEGER NOT NULL DEFAULT 0,
	execution_state TEXT NOT NULL DEFAULT 'queued',
	capture_state TEXT NOT NULL DEFAULT 'pending',
	delivery_state TEXT NOT NULL DEFAULT 'pending',
	publication_state TEXT NOT NULL DEFAULT 'not-requested',
	verification_state TEXT NOT NULL DEFAULT 'not-required',
	manifest_ref TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (node_id, ordinal)
);

CREATE TABLE IF NOT EXISTS lifecycle_reservations (
	reservation_id TEXT PRIMARY KEY,
	attempt_id TEXT UNIQUE REFERENCES lifecycle_attempts(attempt_id) ON DELETE CASCADE,
	parent_reservation_id TEXT,
	reserved_json TEXT NOT NULL,
	consumed_json TEXT NOT NULL,
	active_compute INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lifecycle_usage (
	event_id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL REFERENCES lifecycle_attempts(attempt_id) ON DELETE CASCADE,
	request_id TEXT NOT NULL,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	pricing_ref TEXT,
	counts_json TEXT NOT NULL,
	cost_microunits INTEGER,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_usage_attempt ON lifecycle_usage(attempt_id);

CREATE TABLE IF NOT EXISTS lifecycle_handoffs (
	event_id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL REFERENCES lifecycle_attempts(attempt_id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK(kind IN ('settled','clarification','reply')),
	owner_node_id TEXT REFERENCES lifecycle_nodes(node_id),
	target_node_id TEXT REFERENCES lifecycle_nodes(node_id),
	correlation_id TEXT,
	packet_json TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','consumed','superseded')),
	created_at INTEGER NOT NULL,
	UNIQUE (attempt_id, kind)
);

CREATE TABLE IF NOT EXISTS lifecycle_inbox (
	owner_node_id TEXT NOT NULL REFERENCES lifecycle_nodes(node_id) ON DELETE CASCADE,
	event_id TEXT NOT NULL REFERENCES lifecycle_handoffs(event_id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','consumed','superseded')),
	planner_turn_id TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (owner_node_id, event_id)
);

CREATE TABLE IF NOT EXISTS lifecycle_planner_turns (
	turn_id TEXT PRIMARY KEY,
	owner_node_id TEXT NOT NULL REFERENCES lifecycle_nodes(node_id) ON DELETE CASCADE,
	expected_plan_version INTEGER NOT NULL,
	input_event_hash TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'committed',
	result_ref TEXT,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lifecycle_publications (
	publication_id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL REFERENCES lifecycle_attempts(attempt_id) ON DELETE CASCADE,
	target_kind TEXT NOT NULL CHECK(target_kind IN ('run-candidate','user-workspace')),
	target_id TEXT NOT NULL,
	manifest_hash TEXT NOT NULL,
	expected_snapshot_hash TEXT NOT NULL,
	resulting_snapshot_hash TEXT,
	publisher_owner TEXT,
	publisher_epoch INTEGER NOT NULL DEFAULT 1,
	publisher_expires_at INTEGER,
	stage_journal_json TEXT,
	mutation_policy_json TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','integrated','conflicted','rejected','partial')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (attempt_id, target_kind, target_id, manifest_hash, expected_snapshot_hash)
);

CREATE TABLE IF NOT EXISTS lifecycle_obligations (
	obligation_id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES lifecycle_runs(run_id) ON DELETE CASCADE,
	node_id TEXT NOT NULL REFERENCES lifecycle_nodes(node_id) ON DELETE CASCADE,
	criterion_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK(kind IN ('mandatory_criterion','unresolved_dependency','scope_verification','publication_partial')),
	state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved','waived')),
	evidence_receipt_ids_json TEXT NOT NULL DEFAULT '[]',
	waiver_authorization_ref TEXT,
	version INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (run_id, node_id, criterion_id)
);

CREATE TABLE IF NOT EXISTS lifecycle_receipts (
	receipt_id TEXT PRIMARY KEY,
	candidate_hash TEXT NOT NULL,
	contract_hash TEXT NOT NULL,
	verifier_id TEXT NOT NULL,
	env_hash TEXT NOT NULL,
	artifact_refs_json TEXT NOT NULL,
	outcome TEXT NOT NULL CHECK(outcome IN ('passed','failed','unverified')),
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lifecycle_versions (
	kind TEXT NOT NULL,
	digest TEXT NOT NULL,
	content_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (kind, digest)
);

CREATE TABLE IF NOT EXISTS lifecycle_grants (
	grant_id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES lifecycle_runs(run_id) ON DELETE CASCADE,
	owner_node_id TEXT REFERENCES lifecycle_nodes(node_id),
	resource_identity TEXT NOT NULL,
	resource_hash TEXT NOT NULL,
	rights_json TEXT NOT NULL,
	max_read_bytes INTEGER,
	expiry INTEGER,
	revoked INTEGER NOT NULL DEFAULT 0,
	provenance_json TEXT,
	created_at INTEGER NOT NULL
);
`);
		}
		if (fromVersion < 3) {
			this.#db.run(`
CREATE TABLE IF NOT EXISTS lifecycle_idempotency (
	idempotency_key TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES lifecycle_runs(run_id) ON DELETE CASCADE,
	node_id TEXT NOT NULL REFERENCES lifecycle_nodes(node_id) ON DELETE CASCADE,
	attempt_id TEXT NOT NULL REFERENCES lifecycle_attempts(attempt_id) ON DELETE CASCADE,
	digest TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
`);
		}
		if (fromVersion < 4) {
			// v4 adds the universal launch-authority tables (§14.5) to the SAME
			// database. v1-v3 rows are preserved untouched: this migration only
			// adds tables, so existing lifecycle evidence cannot be lost by it.
			//
			// Authority records are append-only by construction. Contract and
			// grant CONTENT is never UPDATEd; revocation and supersession are
			// separate event rows, so history stays reconstructable after the
			// fact rather than being overwritten in place.
			this.#db.run(`
CREATE TABLE IF NOT EXISTS launch_principals (
	principal_id TEXT PRIMARY KEY,
	root_principal_id TEXT REFERENCES launch_principals(principal_id),
	parent_principal_id TEXT REFERENCES launch_principals(principal_id),
	launch_class TEXT CHECK(launch_class IN ('strict-worker','privileged-helper','legacy-compatible-worker')),
	authority_envelope_ref TEXT,
	policy_epoch INTEGER NOT NULL DEFAULT 1,
	status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','terminal')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS launch_contracts (
	contract_id TEXT NOT NULL,
	revision INTEGER NOT NULL,
	digest TEXT NOT NULL UNIQUE,
	prior_digest TEXT,
	policy_version INTEGER NOT NULL,
	root_principal_id TEXT NOT NULL,
	parent_principal_id TEXT NOT NULL,
	child_principal_id TEXT NOT NULL,
	canonical_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (contract_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_launch_contracts_child ON launch_contracts(child_principal_id);

CREATE TABLE IF NOT EXISTS launch_bindings (
	binding_id TEXT PRIMARY KEY,
	contract_id TEXT NOT NULL,
	contract_revision INTEGER NOT NULL,
	contract_digest TEXT NOT NULL REFERENCES launch_contracts(digest),
	root_principal_id TEXT NOT NULL,
	parent_principal_id TEXT NOT NULL,
	child_principal_id TEXT NOT NULL,
	attempt_id TEXT NOT NULL UNIQUE,
	session_id TEXT,
	process_ref TEXT,
	policy_epoch INTEGER NOT NULL,
	context_generation INTEGER NOT NULL DEFAULT 0,
	state TEXT NOT NULL CHECK(state IN ('authorized','bound','active','suspended','revoked','superseded','failed','terminal')),
	grant_bindings_json TEXT NOT NULL DEFAULT '[]',
	service_bindings_json TEXT NOT NULL DEFAULT '[]',
	actual_guarantees_json TEXT,
	guarantee_evidence_json TEXT NOT NULL DEFAULT '[]',
	reservation_id TEXT,
	lifecycle_json TEXT,
	expires_at INTEGER,
	restores_binding_id TEXT REFERENCES launch_bindings(binding_id),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	FOREIGN KEY (contract_id, contract_revision) REFERENCES launch_contracts(contract_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_launch_bindings_child ON launch_bindings(child_principal_id, state);

CREATE TABLE IF NOT EXISTS launch_grants (
	grant_id TEXT PRIMARY KEY,
	record_digest TEXT NOT NULL,
	recipient_binding_id TEXT NOT NULL REFERENCES launch_bindings(binding_id),
	issuer_principal_id TEXT NOT NULL,
	recipient_principal_id TEXT NOT NULL,
	attempt_id TEXT NOT NULL,
	contract_revision INTEGER NOT NULL,
	policy_epoch INTEGER NOT NULL,
	canonical_json TEXT NOT NULL,
	expires_at INTEGER,
	revoked_at INTEGER,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launch_grants_binding ON launch_grants(recipient_binding_id, revoked_at);

CREATE TABLE IF NOT EXISTS launch_grant_events (
	event_id TEXT PRIMARY KEY,
	grant_id TEXT NOT NULL REFERENCES launch_grants(grant_id),
	kind TEXT NOT NULL CHECK(kind IN ('issued','revoked','superseded')),
	actor_principal_id TEXT NOT NULL,
	policy_epoch INTEGER NOT NULL,
	reason TEXT NOT NULL,
	record_digest TEXT NOT NULL,
	occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launch_grant_events_grant ON launch_grant_events(grant_id, occurred_at);

-- Validated lineage. Revoking a source must be able to find every record
-- derived from it, so derivation is stored as an explicit edge rather than
-- being recomputed from grant content.
CREATE TABLE IF NOT EXISTS launch_grant_edges (
	source_grant_id TEXT NOT NULL REFERENCES launch_grants(grant_id),
	derived_grant_id TEXT NOT NULL REFERENCES launch_grants(grant_id),
	PRIMARY KEY (source_grant_id, derived_grant_id)
);

CREATE TABLE IF NOT EXISTS launch_channels (
	binding_id TEXT NOT NULL REFERENCES launch_bindings(binding_id),
	channel_id TEXT NOT NULL,
	canonical_json TEXT NOT NULL,
	reveal_state TEXT NOT NULL DEFAULT 'open' CHECK(reveal_state IN ('open','authorized-synthesis','revealed')),
	policy_epoch INTEGER NOT NULL,
	consumed_bytes INTEGER NOT NULL DEFAULT 0 CHECK(consumed_bytes >= 0),
	consumed_messages INTEGER NOT NULL DEFAULT 0 CHECK(consumed_messages >= 0),
	revoked_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (binding_id, channel_id)
);

CREATE TABLE IF NOT EXISTS launch_channel_events (
	event_id TEXT PRIMARY KEY,
	binding_id TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	request_digest TEXT,
	idempotency_key TEXT,
	reason TEXT,
	occurred_at INTEGER NOT NULL,
	UNIQUE (binding_id, channel_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS launch_deliveries (
	binding_id TEXT NOT NULL REFERENCES launch_bindings(binding_id),
	delivery_id TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	sender_principal_id TEXT NOT NULL,
	recipient_principal_id TEXT NOT NULL,
	attempt_id TEXT NOT NULL,
	contract_revision INTEGER NOT NULL,
	policy_epoch INTEGER NOT NULL,
	context_generation INTEGER NOT NULL,
	payload_json TEXT NOT NULL,
	bytes INTEGER NOT NULL CHECK(bytes >= 0),
	request_digest TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (binding_id, delivery_id)
);

CREATE TABLE IF NOT EXISTS launch_delivery_events (
	event_id TEXT PRIMARY KEY,
	binding_id TEXT NOT NULL,
	delivery_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK(kind IN ('requested','authorized','admitted','rejected','included','provider-known','provider-unknown')),
	request_id TEXT,
	code TEXT,
	occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launch_delivery_events ON launch_delivery_events(binding_id, delivery_id, occurred_at);

-- Admission into the recipient's durable context. One row per admitted
-- delivery; marking it rendered does not erase the disclosure.
CREATE TABLE IF NOT EXISTS launch_context_inbox (
	binding_id TEXT NOT NULL REFERENCES launch_bindings(binding_id),
	context_generation INTEGER NOT NULL,
	delivery_id TEXT NOT NULL,
	admission_order INTEGER NOT NULL,
	content_ref TEXT NOT NULL,
	domains_json TEXT NOT NULL,
	admitted_epoch INTEGER NOT NULL,
	consumed_for_rendering INTEGER NOT NULL DEFAULT 0,
	admitted_at INTEGER NOT NULL,
	PRIMARY KEY (binding_id, context_generation, delivery_id)
);

CREATE TABLE IF NOT EXISTS launch_revisions (
	revision_event_id TEXT PRIMARY KEY,
	binding_id TEXT NOT NULL,
	prior_contract_digest TEXT NOT NULL,
	new_contract_digest TEXT NOT NULL,
	actor_principal_id TEXT NOT NULL,
	delta_json TEXT NOT NULL,
	reason TEXT NOT NULL,
	policy_epoch INTEGER NOT NULL,
	old_binding_id TEXT,
	new_binding_id TEXT,
	idempotency_key TEXT NOT NULL,
	input_digest TEXT NOT NULL,
	occurred_at INTEGER NOT NULL,
	UNIQUE (idempotency_key, input_digest)
);

CREATE TABLE IF NOT EXISTS launch_releases (
	release_id TEXT PRIMARY KEY,
	source_binding_id TEXT NOT NULL,
	domains_json TEXT NOT NULL,
	recipient_principal_ids_json TEXT NOT NULL,
	resource_refs_json TEXT NOT NULL,
	actor_principal_id TEXT NOT NULL,
	reason TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	input_digest TEXT NOT NULL,
	occurred_at INTEGER NOT NULL,
	UNIQUE (idempotency_key, input_digest)
);
`);
		}
	}

	#ensureEpisodeFts(): boolean {
		try {
			this.#db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
	episode_id UNINDEXED,
	title,
	summary,
	tags,
	search_text
)`);
			return true;
		} catch {
			return false;
		}
	}

	// ---------------------------------------------------------------------------
	// Scoped state
	// ---------------------------------------------------------------------------

	setState(scope: StateScope, key: string, value: JsonValue): ScopedStateEntry {
		this.#assertOpen();
		const trimmed = key.trim();
		if (!trimmed) throw new Error("state key must be non-empty");
		const { scopeKind, projectPath } = normalizeScope(scope);
		const updatedAt = this.#now();
		const valueJson = serializeJsonValue(value);
		this.#setStateStmt.run(scopeKind, projectPath, trimmed, valueJson, updatedAt);
		return {
			scope: scopeFromRow({ scope_kind: scopeKind, project_path: projectPath }),
			key: trimmed,
			value: parseJsonValue(valueJson),
			updatedAt,
		};
	}

	getState(scope: StateScope, key: string): JsonValue | null {
		this.#assertOpen();
		const { scopeKind, projectPath } = normalizeScope(scope);
		const row = this.#getStateStmt.get(scopeKind, projectPath, key.trim()) as StateRow | null;
		if (!row) return null;
		return parseJsonValue(row.value_json);
	}

	deleteState(scope: StateScope, key: string): boolean {
		this.#assertOpen();
		const { scopeKind, projectPath } = normalizeScope(scope);
		const result = this.#deleteStateStmt.run(scopeKind, projectPath, key.trim());
		return result.changes > 0;
	}

	listState(scope: StateScope, prefix?: string): ScopedStateEntry[] {
		this.#assertOpen();
		const { scopeKind, projectPath } = normalizeScope(scope);
		const rows =
			prefix && prefix.length > 0
				? (this.#listStatePrefixStmt.all(scopeKind, projectPath, `${escapeLikePattern(prefix)}%`) as StateRow[])
				: (this.#listStateStmt.all(scopeKind, projectPath) as StateRow[]);
		return rows.map(row => ({
			scope: scopeFromRow(row),
			key: row.key,
			value: parseJsonValue(row.value_json),
			updatedAt: row.updated_at,
		}));
	}

	// ---------------------------------------------------------------------------
	// Episodes
	// ---------------------------------------------------------------------------

	createEpisode(input: CreateEpisodeInput): EpisodeRecord {
		this.#assertOpen();
		const now = this.#now();
		const id = input.id ?? this.#createId();
		const tags = input.tags ? [...input.tags] : [];
		const metadata = input.metadata ?? null;
		const searchText = episodeSearchText(input.title, input.summary, tags);
		this.#insertEpisodeStmt.run(
			id,
			input.sessionId ?? "",
			input.title,
			input.summary,
			serializeJsonValue(tags),
			serializeJsonValue(metadata),
			searchText,
			now,
			now,
		);
		this.#insertEpisodeFtsStmt?.run(id, input.title, input.summary, serializeJsonValue(tags), searchText);
		const created = this.getEpisode(id);
		if (!created) throw new Error(`failed to read episode ${id}`);
		return created;
	}

	getEpisode(id: string): EpisodeRecord | null {
		this.#assertOpen();
		const row = this.#getEpisodeStmt.get(id) as EpisodeRow | null;
		return row ? this.#toEpisode(row) : null;
	}

	listEpisodes(limit = 100): EpisodeRecord[] {
		this.#assertOpen();
		const rows = this.#listEpisodesStmt.all(this.#normalizeLimit(limit)) as EpisodeRow[];
		return rows.map(row => this.#toEpisode(row));
	}

	/**
	 * Cross-session episode search.
	 * Uses FTS5 when available; otherwise indexed LIKE over `search_text`.
	 */
	searchEpisodes(query: string, options: EpisodeSearchOptions = {}): EpisodeRecord[] {
		this.#assertOpen();
		const limit = this.#normalizeLimit(options.limit ?? 50);
		if (limit === 0) return [];
		const tokens = tokenize(query);
		if (tokens.length === 0) return [];
		const sessionId = options.sessionId ?? null;

		if (this.#ftsEnabled && this.#searchEpisodesFtsStmt) {
			const ftsQuery = tokens.map(token => `"${token.replace(/"/g, '""')}"*`).join(" ");
			try {
				const rows = this.#searchEpisodesFtsStmt.all(ftsQuery, sessionId, sessionId, limit) as EpisodeRow[];
				if (rows.length > 0) return rows.map(row => this.#toEpisode(row));
			} catch {
				// Fall through to LIKE fallback.
			}
		}

		// Indexed fallback: AND tokens via successive filters in JS over a LIKE seed.
		const seed = `%${escapeLikePattern(tokens[0]!)}%`;
		const seedRows = this.#searchEpisodesLikeStmt.all(
			seed,
			sessionId,
			sessionId,
			Math.max(limit * 4, 50),
		) as EpisodeRow[];
		return seedRows
			.filter(row => {
				const hay = row.search_text.toLowerCase();
				return tokens.every(token => hay.includes(token));
			})
			.slice(0, limit)
			.map(row => this.#toEpisode(row));
	}

	#toEpisode(row: EpisodeRow): EpisodeRecord {
		const tagsRaw = parseJsonValue(row.tags_json);
		const tags = Array.isArray(tagsRaw) ? tagsRaw.map(tag => String(tag)) : [];
		return {
			id: row.id,
			sessionId: row.session_id || null,
			title: row.title,
			summary: row.summary,
			tags,
			metadata: parseJsonValue(row.metadata_json),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	// ---------------------------------------------------------------------------
	// Durable jobs
	// ---------------------------------------------------------------------------

	createJob(input: CreateJobInput): DurableJob {
		this.#assertOpen();
		const now = this.#now();
		const id = input.id ?? this.#createId();
		const status = input.status ?? "queued";
		this.#insertJobStmt.run(
			id,
			input.type,
			status,
			serializeJsonValue(input.payload ?? null),
			input.scheduleId ?? null,
			now,
			now,
		);
		const job = this.getJob(id);
		if (!job) throw new Error(`failed to read job ${id}`);
		return job;
	}

	getJob(id: string): DurableJob | null {
		this.#assertOpen();
		const row = this.#getJobStmt.get(id) as JobRow | null;
		return row ? this.#toJob(row) : null;
	}

	/** Exact counts without the list API's pagination limit. */
	countJobsByStatus(type: string): Record<JobStatus, number> {
		this.#assertOpen();
		const counts = Object.fromEntries(JOB_STATUSES.map(status => [status, 0])) as Record<JobStatus, number>;
		const rows = this.#db
			.prepare("SELECT status, COUNT(*) AS count FROM jobs WHERE type = ? GROUP BY status")
			.all(type) as Array<{ status: JobStatus; count: number }>;
		for (const row of rows) counts[row.status] = row.count;
		return counts;
	}

	listJobs(filter: JobListFilter = {}): DurableJob[] {
		this.#assertOpen();
		const limit = this.#normalizeLimit(filter.limit ?? 100);
		const statuses =
			filter.status === undefined ? null : Array.isArray(filter.status) ? [...filter.status] : [filter.status];
		const type = filter.type ?? null;

		let sql = "SELECT * FROM jobs WHERE 1=1";
		const params: SQLQueryBindings[] = [];
		if (statuses && statuses.length > 0) {
			sql += ` AND status IN (${statuses.map(() => "?").join(", ")})`;
			params.push(...statuses);
		}
		if (type !== null) {
			sql += " AND type = ?";
			params.push(type);
		}
		sql += " ORDER BY created_at ASC, id ASC LIMIT ?";
		params.push(limit);
		const rows = this.#db.prepare(sql).all(...params) as JobRow[];
		return rows.map(row => this.#toJob(row));
	}

	/**
	 * Atomically claim the oldest queued job (optionally filtered by type).
	 * Sets status=running and assigns lease ownership/expiry.
	 */
	claimJob(leaseOwner: string, leaseMs = DEFAULT_LEASE_MS, type?: string): DurableJob | null {
		this.#assertOpen();
		if (!leaseOwner.trim()) throw new Error("leaseOwner is required");
		const owner = leaseOwner.trim();
		const leaseDuration = Math.max(1, leaseMs);

		const claim = this.#db.transaction(() => {
			const candidate = this.#selectClaimCandidateStmt.get(type ?? null, type ?? null) as JobRow | null;
			if (!candidate) return null;
			const now = this.#now();
			const updated: JobRow = {
				...candidate,
				status: "running",
				lease_owner: owner,
				lease_expires_at: now + leaseDuration,
				updated_at: now,
				started_at: candidate.started_at ?? now,
			};
			this.#writeJobRow(updated);
			return this.#toJob(updated);
		});

		return claim.immediate();
	}

	/**
	 * Atomically claim a specific queued job by ID.
	 * Returns null if the job does not exist or is not in 'queued' status.
	 */
	claimJobById(id: string, leaseOwner: string, leaseMs = DEFAULT_LEASE_MS): DurableJob | null {
		this.#assertOpen();
		if (!id.trim()) throw new Error("id is required");
		if (!leaseOwner.trim()) throw new Error("leaseOwner is required");
		const owner = leaseOwner.trim();
		const leaseDuration = Math.max(1, leaseMs);

		const claim = this.#db.transaction(() => {
			const candidate = this.#getJobStmt.get(id) as JobRow | null;
			if (candidate?.status !== "queued") return null;
			const now = this.#now();
			const updated: JobRow = {
				...candidate,
				status: "running",
				lease_owner: owner,
				lease_expires_at: now + leaseDuration,
				updated_at: now,
				started_at: candidate.started_at ?? now,
			};
			this.#writeJobRow(updated);
			return this.#toJob(updated);
		});

		return claim.immediate();
	}

	transitionJob(id: string, input: JobTransitionInput): DurableJob {
		this.#assertOpen();
		const transition = this.#db.transaction(() => {
			const row = this.#getJobStmt.get(id) as JobRow | null;
			if (!row) throw new Error(`job not found: ${id}`);
			if (!isJobStatus(row.status)) throw new Error(`corrupt job status: ${row.status}`);

			const from = row.status;
			const to = input.to;
			if (!ALLOWED_TRANSITIONS[from].includes(to)) {
				throw new Error(`invalid job transition ${from} -> ${to}`);
			}

			if (from === "running" || from === "paused") {
				if (row.lease_owner !== null) {
					if (
						input.leaseOwner === undefined ||
						input.leaseOwner === null ||
						input.leaseOwner !== row.lease_owner
					) {
						throw new Error(`stale lease owner for job ${id}`);
					}
				}
			}

			const now = this.#now();
			let leaseOwner = row.lease_owner;
			let leaseExpiresAt = row.lease_expires_at;
			let startedAt = row.started_at;
			let completedAt = row.completed_at;
			let resultJson = row.result_json;
			let error = row.error;

			if (to === "running") {
				const owner = (input.leaseOwner ?? row.lease_owner ?? "").trim();
				if (!owner) throw new Error("leaseOwner is required when transitioning to running");
				leaseOwner = owner;
				leaseExpiresAt = now + Math.max(1, input.leaseMs ?? DEFAULT_LEASE_MS);
				startedAt = startedAt ?? now;
				completedAt = null;
			} else if (to === "queued") {
				leaseOwner = null;
				leaseExpiresAt = null;
				completedAt = null;
				error = null;
			} else if (to === "paused") {
				leaseOwner = input.leaseOwner ?? row.lease_owner;
			} else if (to === "completed" || to === "failed" || to === "cancelled") {
				leaseOwner = null;
				leaseExpiresAt = null;
				completedAt = now;
			}

			if (input.result !== undefined) {
				resultJson = serializeJsonValue(input.result);
			}
			if (input.error !== undefined) {
				error = input.error;
			}

			const updated: JobRow = {
				...row,
				status: to,
				result_json: resultJson,
				error,
				lease_owner: leaseOwner,
				lease_expires_at: leaseExpiresAt,
				updated_at: now,
				started_at: startedAt,
				completed_at: completedAt,
			};
			this.#writeJobRow(updated);
			return this.#toJob(updated);
		});

		return transition.immediate();
	}

	setCheckpoint(jobId: string, data: JsonValue): JobCheckpoint {
		this.#assertOpen();
		const set = this.#db.transaction(() => {
			const row = this.#getJobStmt.get(jobId) as JobRow | null;
			if (!row) throw new Error(`job not found: ${jobId}`);
			const now = this.#now();
			const updated: JobRow = {
				...row,
				checkpoint_json: serializeJsonValue(data),
				updated_at: now,
			};
			this.#writeJobRow(updated);
			return { jobId, data: parseJsonValue(updated.checkpoint_json), updatedAt: now };
		});
		return set.immediate();
	}

	setCheckpointForLease(jobId: string, leaseOwner: string, data: JsonValue): JobCheckpoint {
		this.#assertOpen();
		const owner = leaseOwner.trim();
		if (!owner) throw new Error("leaseOwner is required");
		const set = this.#db.transaction(() => {
			const row = this.#getJobStmt.get(jobId) as JobRow | null;
			if (!row) throw new Error(`job not found: ${jobId}`);
			if (row.status !== "running" || row.lease_owner !== owner || (row.lease_expires_at ?? 0) <= this.#now()) {
				throw new Error(`stale lease owner for job ${jobId}`);
			}
			const now = this.#now();
			const updated: JobRow = {
				...row,
				checkpoint_json: serializeJsonValue(data),
				updated_at: now,
			};
			this.#writeJobRow(updated);
			return { jobId, data: parseJsonValue(updated.checkpoint_json), updatedAt: now };
		});
		return set.immediate();
	}

	releasePausedLease(jobId: string, leaseOwner: string): DurableJob {
		this.#assertOpen();
		const release = this.#db.transaction(() => {
			const row = this.#getJobStmt.get(jobId) as JobRow | null;
			if (!row) throw new Error(`job not found: ${jobId}`);
			if (row.status !== "paused" || row.lease_owner !== leaseOwner) {
				throw new Error(`stale paused lease owner for job ${jobId}`);
			}
			const updated: JobRow = {
				...row,
				lease_owner: null,
				lease_expires_at: null,
				updated_at: this.#now(),
			};
			this.#writeJobRow(updated);
			return this.#toJob(updated);
		});
		return release.immediate();
	}

	getCheckpoint(jobId: string): JobCheckpoint | null {
		this.#assertOpen();
		const row = this.#getJobStmt.get(jobId) as JobRow | null;
		if (!row || row.checkpoint_json === null) return null;
		return {
			jobId,
			data: parseJsonValue(row.checkpoint_json),
			updatedAt: row.updated_at,
		};
	}

	/**
	 * Extend the lease on a running job. Requires the current lease owner.
	 */
	renewLease(jobId: string, leaseOwner: string, leaseMs = DEFAULT_LEASE_MS): DurableJob {
		this.#assertOpen();
		const owner = leaseOwner.trim();
		if (!owner) throw new Error("leaseOwner is required");
		const renew = this.#db.transaction(() => {
			const row = this.#getJobStmt.get(jobId) as JobRow | null;
			if (!row) throw new Error(`job not found: ${jobId}`);
			if (row.status !== "running") {
				throw new Error(`cannot renew lease for job ${jobId} in status ${row.status}`);
			}
			if (row.lease_owner !== owner || (row.lease_expires_at ?? 0) <= this.#now()) {
				throw new Error(`stale lease owner for job ${jobId}`);
			}
			const now = this.#now();
			const updated: JobRow = {
				...row,
				lease_expires_at: now + Math.max(1, leaseMs),
				updated_at: now,
			};
			this.#writeJobRow(updated);
			return this.#toJob(updated);
		});
		return renew.immediate();
	}

	/** Re-queue running jobs whose leases have expired. */
	recoverExpiredLeases(): DurableJob[] {
		this.#assertOpen();
		const recover = this.#db.transaction(() => {
			const now = this.#now();
			const expired = this.#selectExpiredRunningStmt.all(now) as JobRow[];
			const recovered: DurableJob[] = [];
			for (const row of expired) {
				const updated: JobRow = {
					...row,
					status: "queued",
					lease_owner: null,
					lease_expires_at: null,
					updated_at: now,
				};
				this.#writeJobRow(updated);
				recovered.push(this.#toJob(updated));
			}
			return recovered;
		});
		return recover.immediate();
	}

	#writeJobRow(row: JobRow): void {
		this.#updateJobStmt.run(
			row.status,
			row.result_json,
			row.error,
			row.lease_owner,
			row.lease_expires_at,
			row.checkpoint_json,
			row.updated_at,
			row.started_at,
			row.completed_at,
			row.id,
		);
	}

	#toJob(row: JobRow): DurableJob {
		if (!isJobStatus(row.status)) {
			throw new Error(`corrupt job status: ${row.status}`);
		}
		return {
			id: row.id,
			type: row.type,
			status: row.status,
			payload: parseJsonValue(row.payload_json),
			result: row.result_json === null ? null : parseJsonValue(row.result_json),
			error: row.error,
			leaseOwner: row.lease_owner,
			leaseExpiresAt: row.lease_expires_at,
			checkpoint: row.checkpoint_json === null ? null : parseJsonValue(row.checkpoint_json),
			scheduleId: row.schedule_id,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			startedAt: row.started_at,
			completedAt: row.completed_at,
		};
	}

	// ---------------------------------------------------------------------------
	// Schedules
	// ---------------------------------------------------------------------------

	upsertSchedule(input: UpsertScheduleInput): RecurringSchedule {
		this.#assertOpen();
		const now = this.#now();
		const id = input.id ?? this.#createId();
		const existing = this.#getScheduleStmt.get(id) as ScheduleRow | null;
		const createdAt = existing?.created_at ?? now;
		this.#upsertScheduleStmt.run(
			id,
			input.name,
			input.cron,
			input.nextRunAt ?? null,
			input.enabled === false ? 0 : 1,
			serializeJsonValue(input.payload ?? null),
			createdAt,
			now,
		);
		const schedule = this.getSchedule(id);
		if (!schedule) throw new Error(`failed to read schedule ${id}`);
		return schedule;
	}

	getSchedule(id: string): RecurringSchedule | null {
		this.#assertOpen();
		const row = this.#getScheduleStmt.get(id) as ScheduleRow | null;
		return row ? this.#toSchedule(row) : null;
	}

	listSchedules(): RecurringSchedule[] {
		this.#assertOpen();
		const rows = this.#listSchedulesStmt.all() as ScheduleRow[];
		return rows.map(row => this.#toSchedule(row));
	}

	/** Enabled schedules whose nextRunAt is due at or before `now`. */
	listDueSchedules(now = this.#now()): RecurringSchedule[] {
		this.#assertOpen();
		const rows = this.#listDueSchedulesStmt.all(now) as ScheduleRow[];
		return rows.map(row => this.#toSchedule(row));
	}

	/**
	 * Atomically CAS `next_run_at` and create exactly one queued job for the
	 * claimed occurrence. Returns null when another runner already won the CAS.
	 */
	materializeDueSchedule(input: MaterializeDueScheduleInput): DurableJob | null {
		this.#assertOpen();
		const materialize = this.#db.transaction(() => {
			const scheduleRow = this.#getScheduleStmt.get(input.scheduleId) as ScheduleRow | null;
			if (!scheduleRow) throw new Error(`schedule not found: ${input.scheduleId}`);
			if (scheduleRow.enabled !== 1) return null;
			if (scheduleRow.next_run_at !== input.expectedNextRunAt) return null;

			const now = this.#now();
			const cas = this.#casScheduleNextRunStmt.run(input.nextRunAt, now, input.scheduleId, input.expectedNextRunAt);
			if (cas.changes !== 1) return null;

			const jobId = input.jobId ?? this.#createId();
			this.#insertJobStmt.run(
				jobId,
				input.jobType,
				"queued",
				serializeJsonValue(input.jobPayload ?? null),
				input.scheduleId,
				now,
				now,
			);
			const job = this.getJob(jobId);
			if (!job) throw new Error(`failed to read job ${jobId}`);
			return job;
		});
		return materialize.immediate();
	}

	#toSchedule(row: ScheduleRow): RecurringSchedule {
		return {
			id: row.id,
			name: row.name,
			cron: row.cron,
			nextRunAt: row.next_run_at,
			enabled: row.enabled === 1,
			payload: parseJsonValue(row.payload_json),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	// ---------------------------------------------------------------------------
	// Notifications
	// ---------------------------------------------------------------------------

	createNotification(input: CreateNotificationInput): NotificationRecord {
		this.#assertOpen();
		const id = input.id ?? this.#createId();
		const createdAt = this.#now();
		this.#insertNotificationStmt.run(
			id,
			input.kind,
			input.title,
			input.body,
			serializeJsonValue(input.metadata ?? null),
			createdAt,
		);
		return {
			id,
			kind: input.kind,
			title: input.title,
			body: input.body,
			read: false,
			metadata: input.metadata ?? null,
			createdAt,
		};
	}

	listNotifications(limit = 100): NotificationRecord[] {
		this.#assertOpen();
		const rows = this.#listNotificationsStmt.all(this.#normalizeLimit(limit)) as NotificationRow[];
		return rows.map(row => ({
			id: row.id,
			kind: row.kind,
			title: row.title,
			body: row.body,
			read: row.read === 1,
			metadata: parseJsonValue(row.metadata_json),
			createdAt: row.created_at,
		}));
	}

	markNotificationRead(id: string): boolean {
		this.#assertOpen();
		const result = this.#markNotificationReadStmt.run(id);
		return result.changes > 0;
	}

	// ---------------------------------------------------------------------------
	// Trajectory events
	// ---------------------------------------------------------------------------

	appendEvent(input: AppendEventInput): TrajectoryEvent {
		this.#assertOpen();
		if (!isEventKind(input.kind)) {
			throw new Error(`invalid trajectory event kind: ${String(input.kind)}`);
		}
		const id = input.id ?? this.#createId();
		const createdAt = this.#now();
		const capped = capJsonPayload(input.payload ?? null, this.#maxEventPayloadBytes);
		const payloadJson = serializeJsonValue(capped);
		this.#insertEventStmt.run(id, input.kind, input.jobId ?? null, input.sessionId ?? null, payloadJson, createdAt);
		return {
			id,
			kind: input.kind,
			jobId: input.jobId ?? null,
			sessionId: input.sessionId ?? null,
			payload: capped,
			createdAt,
		};
	}

	listEvents(filter: EventListFilter = {}): TrajectoryEvent[] {
		this.#assertOpen();
		const limit = this.#normalizeLimit(filter.limit ?? 1000);
		if (filter.kind !== undefined && Array.isArray(filter.kind)) {
			const kinds = filter.kind;
			if (kinds.length === 0) return [];
			const sql = `SELECT * FROM trajectory_events
				WHERE kind IN (${kinds.map(() => "?").join(", ")})
				  AND (? IS NULL OR job_id = ?)
				  AND (? IS NULL OR session_id = ?)
				  AND (? IS NULL OR created_at > ?)
				ORDER BY created_at ASC, id ASC
				LIMIT ?`;
			const params: SQLQueryBindings[] = [
				...kinds,
				filter.jobId ?? null,
				filter.jobId ?? null,
				filter.sessionId ?? null,
				filter.sessionId ?? null,
				filter.afterCreatedAt ?? null,
				filter.afterCreatedAt ?? null,
				limit,
			];
			const rows = this.#db.prepare(sql).all(...params) as EventRow[];
			return rows.map(row => this.#toEvent(row));
		}

		const kind = typeof filter.kind === "string" ? filter.kind : null;
		const rows = this.#listEventsStmt.all(
			kind,
			kind,
			filter.jobId ?? null,
			filter.jobId ?? null,
			filter.sessionId ?? null,
			filter.sessionId ?? null,
			filter.afterCreatedAt ?? null,
			filter.afterCreatedAt ?? null,
			limit,
		) as EventRow[];
		return rows.map(row => this.#toEvent(row));
	}

	/** Chronological JSONL export of trajectory events. */
	exportEventsJsonl(filter: EventListFilter = {}): string {
		const events = this.listEvents(filter);
		if (events.length === 0) return "";
		return `${events.map(event => serializeJsonValue(event)).join("\n")}\n`;
	}

	#toEvent(row: EventRow): TrajectoryEvent {
		if (!isEventKind(row.kind)) {
			throw new Error(`corrupt trajectory event kind: ${row.kind}`);
		}
		return {
			id: row.id,
			kind: row.kind,
			jobId: row.job_id,
			sessionId: row.session_id,
			payload: parseJsonValue(row.payload_json),
			createdAt: row.created_at,
		};
	}
	// ---------------------------------------------------------------------------
	// Lifecycle Store Methods (A06/A07/A08)

	createLifecycleRun(
		runId: string,
		compiled: CompiledLaunchContract,
		limits: RunLimitsV1,
		idempotencyKey: string,
	): LifecycleAdmissionResult {
		this.#assertOpen();
		const tx = this.#db.transaction(() => {
			const now = this.#now();
			const existing = this.#db.prepare("SELECT run_id FROM lifecycle_runs WHERE run_id = ?").get(runId) as
				| { run_id: string }
				| undefined;
			if (!existing) {
				this.#db
					.prepare(`
					INSERT INTO lifecycle_runs (run_id, contract_ref, policy_ref, harness_ref, outcome, plan_version, cancellation_generation, root_snapshot_ref, limits_json, consumed_json, reserved_json, created_at, updated_at)
					VALUES (?, ?, ?, ?, 'active', 1, 0, ?, ?, ?, ?, ?, ?)
				`)
					.run(
						runId,
						compiled.missionHash,
						compiled.policyHash,
						compiled.policy.harnessRef,
						compiled.policy.baseline.manifestHash,
						serializeJsonValue(limits),
						serializeJsonValue({ requests: 0, runtimeMs: 0, tokens: 0, costMicrounits: 0 }),
						serializeJsonValue({ requests: 0, runtimeMs: 0, tokens: 0, costMicrounits: 0 }),
						now,
						now,
					);
				const rootNodeId = `${runId}-root`;
				this.#db
					.prepare(`
					INSERT OR IGNORE INTO lifecycle_nodes (node_id, run_id, owner_node_id, depth, role, compiled_contract_ref, created_at, updated_at)
					VALUES (?, ?, NULL, 0, 'root-planner', ?, ?, ?)
				`)
					.run(rootNodeId, runId, compiled.missionHash, now, now);
			}
			const rootNodeId = `${runId}-root`;
			return this.admitLifecycleAttempt({
				runId,
				ownerNodeId: rootNodeId,
				nodeId: rootNodeId,
				idempotencyKey: `${idempotencyKey}:root-attempt`,
				compiled,
				expectedPlanVersion: 1,
				expectedCancellationGeneration: 0,
				reservation: {
					requests: limits.maxRequests,
					runtimeMs: limits.maxRuntimeMs,
					tokens: limits.maxTokens,
					costMicrounits: limits.maxCostMicrounits,
				},
				prerequisiteIds: [],
			});
		});
		return tx.immediate();
	}

	admitLifecycleAttempt(input: LifecycleAdmissionInput): LifecycleAdmissionResult {
		this.#assertOpen();
		const tx = this.#db.transaction(() => {
			const now = this.#now();
			const run = this.#db.prepare("SELECT * FROM lifecycle_runs WHERE run_id = ?").get(input.runId) as
				| { plan_version: number; cancellation_generation: number }
				| undefined;
			if (!run) {
				return { ok: false, code: "run_not_found", message: `Run '${input.runId}' does not exist.` } as const;
			}
			if (run.plan_version !== input.expectedPlanVersion) {
				return {
					ok: false,
					code: "version_conflict",
					message: `Expected plan version ${input.expectedPlanVersion} does not match current ${run.plan_version}.`,
				} as const;
			}
			if (run.cancellation_generation !== input.expectedCancellationGeneration) {
				return { ok: false, code: "cancellation_conflict", message: `Run has been cancelled.` } as const;
			}

			const digest = createHash("sha256")
				.update(
					JSON.stringify({
						mission: input.compiled.missionHash,
						policy: input.compiled.policyHash,
						owner: input.ownerNodeId,
						node: input.nodeId,
						reservation: input.reservation,
						prerequisites: [...input.prerequisiteIds].sort(),
					}),
				)
				.digest("hex");
			const prior = this.#db
				.prepare("SELECT node_id, attempt_id, digest FROM lifecycle_idempotency WHERE idempotency_key = ?")
				.get(input.idempotencyKey) as { node_id: string; attempt_id: string; digest: string } | undefined;
			if (prior) {
				if (prior.digest !== digest) {
					return {
						ok: false,
						code: "admission_conflict",
						message: `Idempotency key '${input.idempotencyKey}' was already used with different inputs.`,
					} as const;
				}
				const priorAttempt = this.#db
					.prepare("SELECT job_id, contract_ref, harness_ref FROM lifecycle_attempts WHERE attempt_id = ?")
					.get(prior.attempt_id) as { job_id: string; contract_ref: string; harness_ref: string } | undefined;
				if (priorAttempt) {
					const priorReservation = this.#db
						.prepare("SELECT reservation_id FROM lifecycle_reservations WHERE attempt_id = ?")
						.get(prior.attempt_id) as { reservation_id: string } | undefined;
					const boundPrior = bindLaunchContract(input.compiled, {
						runId: input.runId,
						nodeId: prior.node_id,
						ownerNodeId: input.ownerNodeId,
						attemptId: prior.attempt_id,
						budgetReservationId: priorReservation?.reservation_id ?? `res-${prior.attempt_id}`,
						leaseEpoch: 1,
						cancellationGeneration: run.cancellation_generation,
					});
					// Idempotent replay returns the SAME job that was admitted
					// originally, so a retrying caller can never create a second
					// execution unit for one authorized attempt.
					const priorJob = this.getJob(priorAttempt.job_id);
					if (!priorJob) {
						throw new LifecycleReadError(
							"lifecycle_attempt_missing_job",
							`Attempt '${prior.attempt_id}' references job '${priorAttempt.job_id}', which no longer exists`,
						);
					}
					return {
						ok: true,
						launch: boundPrior,
						job: priorJob,
					} as const;
				}
			}

			if (!input.nodeId) {
				const limitsRow = this.#db
					.prepare("SELECT limits_json FROM lifecycle_runs WHERE run_id = ?")
					.get(input.runId) as { limits_json: string } | undefined;
				const maxNodes = (parseJsonValue(limitsRow?.limits_json ?? null) as unknown as { maxNodes?: number } | null)
					?.maxNodes;
				if (typeof maxNodes === "number") {
					const nodeCount = this.#db
						.prepare("SELECT COUNT(*) as count FROM lifecycle_nodes WHERE run_id = ?")
						.get(input.runId) as {
						count: number;
					};
					if (nodeCount.count >= maxNodes) {
						return {
							ok: false,
							code: "budget_exhausted",
							message: `Run node limit (${maxNodes}) reached.`,
						} as const;
					}
				}
			}

			const nodeId = input.nodeId ?? this.#createId();
			const nodeExists = this.#db
				.prepare("SELECT node_id, depth FROM lifecycle_nodes WHERE node_id = ?")
				.get(nodeId) as { depth: number } | undefined;
			if (!nodeExists) {
				this.#db
					.prepare(`
					INSERT INTO lifecycle_nodes (node_id, run_id, owner_node_id, depth, role, compiled_contract_ref, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				`)
					.run(
						nodeId,
						input.runId,
						input.ownerNodeId,
						input.compiled.policy.limits.maxDepth,
						input.compiled.policy.role,
						input.compiled.missionHash,
						now,
						now,
					);
			}

			for (const prereq of input.prerequisiteIds) {
				this.#db
					.prepare(`
					INSERT OR IGNORE INTO lifecycle_dependencies (node_id, prerequisite_id)
					VALUES (?, ?)
				`)
					.run(nodeId, prereq);
			}

			const attemptCount = this.#db
				.prepare("SELECT COUNT(*) as count FROM lifecycle_attempts WHERE node_id = ?")
				.get(nodeId) as { count: number };
			const ordinal = attemptCount.count + 1;
			const attemptId = `${nodeId}-attempt-${ordinal}`;

			const jobId = this.#createId();
			this.#db
				.prepare(`
				INSERT INTO jobs (id, type, status, payload_json, created_at, updated_at)
				VALUES (?, 'native_task', 'queued', ?, ?, ?)
			`)
				.run(jobId, serializeJsonValue({ runId: input.runId, nodeId, attemptId }), now, now);

			this.#db
				.prepare(`
				INSERT INTO lifecycle_attempts (attempt_id, node_id, ordinal, job_id, contract_ref, harness_ref, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`)
				.run(
					attemptId,
					nodeId,
					ordinal,
					jobId,
					input.compiled.missionHash,
					input.compiled.policy.harnessRef,
					now,
					now,
				);

			const reservationId = `res-${attemptId}`;
			this.#db
				.prepare(`
				INSERT INTO lifecycle_reservations (reservation_id, attempt_id, reserved_json, consumed_json, active_compute, created_at, updated_at)
				VALUES (?, ?, ?, ?, 1, ?, ?)
			`)
				.run(
					reservationId,
					attemptId,
					serializeJsonValue(input.reservation),
					serializeJsonValue({ requests: 0, runtimeMs: 0, tokens: 0, costMicrounits: 0 }),
					now,
					now,
				);
			this.#db
				.prepare(`
				INSERT OR IGNORE INTO lifecycle_idempotency (idempotency_key, run_id, node_id, attempt_id, digest, created_at)
				VALUES (?, ?, ?, ?, ?, ?)
			`)
				.run(input.idempotencyKey, input.runId, nodeId, attemptId, digest, now);

			const boundLaunch = bindLaunchContract(input.compiled, {
				runId: input.runId,
				nodeId,
				ownerNodeId: input.ownerNodeId,
				attemptId,
				budgetReservationId: reservationId,
				leaseEpoch: 1,
				cancellationGeneration: run.cancellation_generation,
			});

			const job = this.getJob(jobId);
			if (!job) {
				throw new LifecycleReadError(
					"lifecycle_attempt_missing_job",
					`Job '${jobId}' was inserted for attempt '${attemptId}' but could not be read back`,
				);
			}

			return { ok: true, launch: boundLaunch, job } as const;
		});

		return tx.immediate();
	}

	recordLifecycleUsage(input: LifecycleUsageInput): void {
		this.#assertOpen();
		const tx = this.#db.transaction(() => {
			const now = this.#now();
			this.#db
				.prepare(`
				INSERT OR IGNORE INTO lifecycle_usage (event_id, attempt_id, request_id, provider, model, pricing_ref, counts_json, cost_microunits, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
				.run(
					input.eventId,
					input.fence.attemptId,
					input.requestId,
					input.provider,
					input.model,
					input.pricingVersion,
					serializeJsonValue(input.observed),
					input.observed.costMicrounits ?? null,
					now,
				);
		});
		tx.immediate();
	}

	settleLifecycleAttempt(input: LifecycleSettlementInput): LifecycleSettlementResult {
		this.#assertOpen();
		const tx = this.#db.transaction(() => {
			const attempt = this.#db
				.prepare("SELECT * FROM lifecycle_attempts WHERE attempt_id = ?")
				.get(input.fence.attemptId) as
				| { lease_epoch: number; cancellation_generation: number; execution_state: string }
				| undefined;
			if (!attempt) {
				return { ok: false, code: "invalid_transition", message: "Attempt not found" } as const;
			}
			if (attempt.lease_epoch !== input.fence.leaseEpoch) {
				return { ok: false, code: "fence_stale", message: "Lease epoch is stale" } as const;
			}
			if (attempt.cancellation_generation !== input.fence.cancellationGeneration) {
				return { ok: false, code: "cancellation_conflict", message: "Cancellation generation mismatch" } as const;
			}

			const now = this.#now();
			this.#db
				.prepare(`
				UPDATE lifecycle_attempts
				SET execution_state = 'succeeded', capture_state = ?, manifest_ref = ?, updated_at = ?
				WHERE attempt_id = ?
			`)
				.run(input.captureState, input.manifest ? input.manifest.uri : null, now, input.fence.attemptId);

			this.#db
				.prepare(`
				INSERT OR IGNORE INTO lifecycle_handoffs (event_id, attempt_id, kind, owner_node_id, target_node_id, correlation_id, packet_json, status, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
			`)
				.run(
					input.handoff.eventId,
					input.fence.attemptId,
					input.handoff.kind,
					input.handoff.ownerNodeId,
					input.handoff.targetNodeId,
					input.handoff.correlationId,
					serializeJsonValue(input.handoff),
					now,
				);

			if (input.handoff.ownerNodeId) {
				this.#db
					.prepare(`
					INSERT OR IGNORE INTO lifecycle_inbox (owner_node_id, event_id, status, created_at)
					VALUES (?, ?, 'pending', ?)
				`)
					.run(input.handoff.ownerNodeId, input.handoff.eventId, now);
			}

			return { ok: true, status: "settled" } as const;
		});
		return tx.immediate();
	}

	cancelLifecycleRun(input: LifecycleCancellationInput): LifecycleCancellationResult {
		this.#assertOpen();
		const tx = this.#db.transaction(() => {
			const now = this.#now();
			const run = this.#db.prepare("SELECT * FROM lifecycle_runs WHERE run_id = ?").get(input.runId) as
				| { cancellation_generation: number; plan_version: number; limits_json: string }
				| undefined;
			if (!run) {
				return { ok: false, code: "run_not_found", message: `Run '${input.runId}' not found` } as const;
			}
			if (run.cancellation_generation !== input.expectedCancellationGeneration) {
				return { ok: false, code: "cancellation_conflict", message: "Cancellation generation conflict" } as const;
			}
			const nextGen = run.cancellation_generation + 1;
			this.#db
				.prepare(`
				UPDATE lifecycle_runs
				SET outcome = 'cancelled', cancellation_generation = ?, updated_at = ?
				WHERE run_id = ?
			`)
				.run(nextGen, now, input.runId);

			// The run row was just updated inside this transaction, so an
			// absent snapshot here means the record is corrupt, not missing.
			// Let the typed read error surface rather than relabelling it.
			return { ok: true, snapshot: this.getLifecycleRunSnapshot(input.runId) } as const;
		});
		return tx.immediate();
	}

	/**
	 * Authoritative run snapshot read (A15).
	 *
	 * Maps the persisted v3 rows only. Anything the v3 schema genuinely does
	 * not record is reported as empty; anything it records but cannot be
	 * faithfully projected raises an explicit read error instead of a forged
	 * reference. Missing run throws `run_not_found` rather than fabricating an
	 * empty snapshot that reads like a real, empty run.
	 */
	getLifecycleRunSnapshot(runId: string): LifecycleRunSnapshot {
		this.#assertOpen();
		const row = this.#db
			.prepare(
				"SELECT run_id, outcome, plan_version, cancellation_generation, limits_json, consumed_json, reserved_json FROM lifecycle_runs WHERE run_id = ?",
			)
			.get(runId) as LifecycleRunRow | undefined;
		if (!row) throw new LifecycleReadError("run_not_found", `Lifecycle run '${runId}' not found`);

		const rootNode = this.#db
			.prepare("SELECT node_id FROM lifecycle_nodes WHERE run_id = ? AND owner_node_id IS NULL")
			.get(runId) as { node_id: string } | undefined;
		if (!rootNode) {
			throw new LifecycleReadError(
				"lifecycle_run_missing_root_node",
				`Lifecycle run '${runId}' has no root node; the run record is incomplete`,
			);
		}

		const nodes = (
			this.#db
				.prepare(
					"SELECT node_id, owner_node_id, depth, role, current_attempt_id, session_id, session_generation, planner_activity FROM lifecycle_nodes WHERE run_id = ? ORDER BY node_id ASC",
				)
				.all(runId) as LifecycleNodeRow[]
		).map(n => ({
			nodeId: n.node_id,
			ownerNodeId: n.owner_node_id,
			depth: n.depth,
			role: n.role,
			currentAttemptId: n.current_attempt_id,
			sessionId: n.session_id,
			sessionGeneration: n.session_generation,
			plannerActivity: n.planner_activity,
		}));

		// lifecycle_attempts has no run_id column: attempts are run-scoped only
		// through their owning node. There is also no fence_json column — the
		// fence is reconstructed from the authoritative lease/generation columns.
		const attempts = (
			this.#db
				.prepare(
					"SELECT a.attempt_id, a.node_id, a.job_id, a.contract_ref, a.lease_owner, a.lease_epoch, a.cancellation_generation, a.execution_state, a.capture_state, a.delivery_state, a.publication_state, a.verification_state, a.manifest_ref FROM lifecycle_attempts a JOIN lifecycle_nodes n ON a.node_id = n.node_id WHERE n.run_id = ? ORDER BY a.attempt_id ASC",
				)
				.all(runId) as LifecycleAttemptRow[]
		).map(a => {
			if (a.job_id === null) {
				throw new LifecycleReadError(
					"lifecycle_attempt_missing_job",
					`Attempt '${a.attempt_id}' has no job row; the attempt record is incomplete`,
				);
			}
			return {
				attemptId: a.attempt_id,
				nodeId: a.node_id,
				jobId: a.job_id,
				// An unclaimed attempt genuinely has no write-authentication
				// token yet. Emitting a fence with an empty owner would hand
				// out a token that authenticates nothing.
				fence:
					a.lease_owner === null
						? null
						: {
								runId,
								nodeId: a.node_id,
								attemptId: a.attempt_id,
								leaseOwner: a.lease_owner,
								leaseEpoch: a.lease_epoch,
								cancellationGeneration: a.cancellation_generation,
								contractVersion: LAUNCH_CONTRACT_VERSION,
							},
				execution: a.execution_state,
				capture: a.capture_state,
				delivery: a.delivery_state,
				publication: a.publication_state,
				verification: a.verification_state,
				manifestRef: a.manifest_ref,
			};
		});

		const dependencies = (
			this.#db
				.prepare(
					"SELECT d.node_id, d.prerequisite_id FROM lifecycle_dependencies d JOIN lifecycle_nodes n ON d.node_id = n.node_id WHERE n.run_id = ? ORDER BY d.node_id, d.prerequisite_id ASC",
				)
				.all(runId) as { node_id: string; prerequisite_id: string }[]
		).map(d => ({
			nodeId: d.node_id,
			prerequisiteId: d.prerequisite_id,
		}));

		const obligations = (
			this.#db
				.prepare(
					"SELECT obligation_id, run_id, node_id, criterion_id, kind, state, evidence_receipt_ids_json, waiver_authorization_ref, version FROM lifecycle_obligations WHERE run_id = ? ORDER BY obligation_id ASC",
				)
				.all(runId) as LifecycleObligationRow[]
		).map(o =>
			parseObligationV1({
				schemaVersion: 1,
				obligationId: o.obligation_id,
				runId: o.run_id,
				nodeId: o.node_id,
				criterionId: o.criterion_id,
				kind: o.kind,
				state: o.state,
				evidenceReceiptIds: parseJsonValue(o.evidence_receipt_ids_json),
				waiverAuthorizationRef: o.waiver_authorization_ref,
				version: o.version,
			}),
		);

		const pendingInboxEventIds = (
			this.#db
				.prepare(
					"SELECT i.event_id FROM lifecycle_inbox i JOIN lifecycle_nodes n ON i.owner_node_id = n.node_id WHERE n.run_id = ? AND i.status = 'pending' ORDER BY i.event_id ASC",
				)
				.all(runId) as { event_id: string }[]
		).map(e => e.event_id);

		// v3 persists neither a complete PublicationReceipt (no mutated
		// repositories, changesApplied, recovery refs or obligation links) nor
		// any run/attempt scoping on lifecycle_receipts. Empty is therefore the
		// honest answer only while those tables hold nothing for this run;
		// existing rows cannot be projected without inventing fields, so they
		// surface as an explicit read error until the v4 migration adds the
		// missing columns.
		this.#assertUnrepresentableLifecycleEvidence(runId);

		return {
			schemaVersion: 1 as const,
			runId: row.run_id,
			rootNodeId: rootNode.node_id,
			outcome: row.outcome,
			planVersion: row.plan_version,
			cancellationGeneration: row.cancellation_generation,
			limits: parseRunLimitsV1(parseJsonValue(row.limits_json), `lifecycle_runs[${runId}].limits_json`),
			consumed: parseReservationVector(parseJsonValue(row.consumed_json), `lifecycle_runs[${runId}].consumed_json`),
			reserved: parseReservationVector(parseJsonValue(row.reserved_json), `lifecycle_runs[${runId}].reserved_json`),
			nodes,
			attempts,
			dependencies,
			obligations,
			publicationReceipts: [],
			verificationReceipts: [],
			pendingInboxEventIds,
			// v3 has no projection manifest table, so no manifests are recorded.
			projectionManifestRefs: [],
		};
	}

	#assertUnrepresentableLifecycleEvidence(runId: string): void {
		const publication = this.#db
			.prepare(
				"SELECT COUNT(*) AS n FROM lifecycle_publications p JOIN lifecycle_attempts a ON p.attempt_id = a.attempt_id JOIN lifecycle_nodes n ON a.node_id = n.node_id WHERE n.run_id = ?",
			)
			.get(runId) as { n: number };
		if (publication.n > 0) {
			throw new LifecycleReadError(
				"lifecycle_publication_unrepresentable",
				`Run '${runId}' has ${publication.n} publication row(s) that the v3 schema cannot project into a PublicationReceipt`,
			);
		}
		const receipts = this.#db.prepare("SELECT COUNT(*) AS n FROM lifecycle_receipts").get() as { n: number };
		if (receipts.n > 0) {
			throw new LifecycleReadError(
				"lifecycle_receipt_unattributable",
				`${receipts.n} verification receipt(s) exist but the v3 schema records no run or attempt scope for them`,
			);
		}
	}

	// --- Launch authority commit protocol (§14.5) --------------------------
	//
	// Runtime-private. Every mutation runs in a short `.immediate()`
	// transaction with no awaits inside, and commits authority BEFORE any
	// runtime exposure: a binding is created `authorized`, not live.

	/**
	 * Step 2 of the launch protocol: atomically persist the compiled contract
	 * and an `authorized` binding.
	 *
	 * This is the authorization commit, NOT live exposure. The child becomes
	 * externally visible only after `activateLaunchBinding` records measured
	 * guarantees, so a cancellation between the two leaves an honest audit
	 * row rather than a running worker nobody authorized.
	 */
	admitLaunchAuthority(input: LaunchAuthorityAdmissionInput): LaunchAuthorityAdmissionResult {
		this.#assertOpen();
		const { compiled, guard } = input;
		const now = Date.now();
		const attemptId = input.lifecycle?.attemptId ?? `attempt-${compiled.contractId}-${compiled.contractRevision}`;

		// Bounded retry on lock contention. Retrying is safe here and ONLY
		// because admission is idempotent: a transaction that failed with
		// SQLITE_BUSY committed nothing, and re-running the same input returns
		// the same recorded allocation. Never blind-retry where that is not
		// true.
		const maxAttempts = 8;
		for (let attemptNo = 1; ; attemptNo++) {
			try {
				return this.#db
					.transaction((): LaunchAuthorityAdmissionResult => {
						const existing = this.#db
							.prepare("SELECT binding_id, contract_digest FROM launch_bindings WHERE attempt_id = ?")
							.get(attemptId) as { binding_id: string; contract_digest: string } | undefined;
						if (existing) {
							// Idempotent replay returns the recorded allocation; the
							// same key with different content is a real conflict.
							if (existing.contract_digest !== compiled.contractDigest) {
								return {
									ok: false,
									code: "admission_conflict",
									diagnostics: [
										{
											code: "admission_conflict",
											message: `attempt '${attemptId}' is already bound to a different contract digest`,
											path: "compiled.contractDigest",
										},
									],
								};
							}
							return {
								ok: true,
								launch: bindLaunchContract(compiled, this.#bindingInputFor(existing.binding_id, input)),
								replayed: true,
							};
						}

						this.#db
							.prepare(
								`INSERT OR IGNORE INTO launch_contracts (contract_id, revision, digest, prior_digest, policy_version, root_principal_id, parent_principal_id, child_principal_id, canonical_json, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							)
							.run(
								compiled.contractId,
								compiled.contractRevision,
								compiled.contractDigest,
								compiled.priorContractDigest,
								compiled.policyVersion,
								compiled.rootPrincipalId,
								compiled.parentPrincipalId,
								compiled.childPrincipalId,
								canonicalJson(compiled),
								now,
							);

						const bindingId = `binding-${compiled.contractId}-${compiled.contractRevision}-${attemptId}`;
						this.#db
							.prepare(
								`INSERT INTO launch_bindings (binding_id, contract_id, contract_revision, contract_digest, root_principal_id, parent_principal_id, child_principal_id, attempt_id, policy_epoch, context_generation, state, lifecycle_json, reservation_id, restores_binding_id, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'authorized', ?, ?, ?, ?, ?)`,
							)
							.run(
								bindingId,
								compiled.contractId,
								compiled.contractRevision,
								compiled.contractDigest,
								compiled.rootPrincipalId,
								compiled.parentPrincipalId,
								compiled.childPrincipalId,
								attemptId,
								guard.expectedPolicyEpoch,
								input.lifecycle ? JSON.stringify(input.lifecycle) : null,
								input.lifecycle?.reservationId ?? null,
								input.restoresBindingId,
								now,
								now,
							);

						return {
							ok: true,
							launch: bindLaunchContract(compiled, this.#bindingInputFor(bindingId, input)),
							replayed: false,
						};
						// BEGIN IMMEDIATE: SQLite does NOT honour busy_timeout when a
						// deferred transaction has to upgrade to a write lock, so a
						// deferred variant fails concurrent admissions outright with
						// "database is locked" instead of serialising them.
					})
					.immediate();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (/locked|busy/i.test(message) && attemptNo < maxAttempts) {
					// Jittered backoff so queued writers do not re-collide.
					const backoff = Math.min(25 * 2 ** (attemptNo - 1), 400) + Math.floor(Math.random() * 40);
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoff);
					continue;
				}
				return {
					ok: false,
					code: "admission_failed",
					diagnostics: [
						{
							code: "admission_failed",
							message,
							path: "admitLaunchAuthority",
						},
					],
				};
			}
		}
	}

	#bindingInputFor(bindingId: string, input: LaunchAuthorityAdmissionInput): LaunchBindingInput {
		const lifecycle = input.lifecycle;
		return {
			runId: lifecycle?.runId ?? input.compiled.contractId,
			nodeId: lifecycle?.nodeId ?? input.compiled.childPrincipalId,
			ownerNodeId: lifecycle?.ownerNodeId ?? null,
			attemptId: lifecycle?.attemptId ?? bindingId,
			budgetReservationId: lifecycle?.reservationId ?? `reservation-${bindingId}`,
			leaseEpoch: lifecycle?.leaseEpoch ?? 1,
			cancellationGeneration: lifecycle?.cancellationGeneration ?? 0,
		};
	}

	/**
	 * Deterministically derives the grant identity and digest a request
	 * would produce, without writing anything. Used for idempotency
	 * comparison so a replay is decided by content, not by trusting a prior
	 * row's self-consistency.
	 */
	#candidateGrant(input: { guard: LaunchMutationGuard; request: GrantIssueRequest }): GrantRecordV1 {
		const { request, guard } = input;
		const body = {
			schemaVersion: 1 as const,
			grantId: `grant-${request.idempotencyKey}`,
			issuerPrincipalId: request.issuerPrincipalId,
			recipientPrincipalId: request.recipientPrincipalId,
			recipientBindingId: request.recipientBindingId,
			attemptId: request.attemptId,
			contractRevision: request.contractRevision,
			policyEpoch: guard.expectedPolicyEpoch,
			resource: request.resource,
			operations: request.operations,
			delegableOperations: request.delegableOperations,
			recipientConstraints: request.recipientConstraints,
			remainingDelegationDepth: request.remainingDelegationDepth,
			domains: request.domains,
			sourceGrantIds: request.sourceGrantIds,
			expiresAt: request.expiresAt,
			purpose: request.purpose,
		};
		return Object.freeze({ ...body, recordDigest: sha256Hex(canonicalJson(body)) });
	}

	/**
	 * Issue a grant (§14.5). Validates every source grant's existence,
	 * liveness and depth before writing, records lineage edges for each
	 * source, and appends an immutable `issued` event. Grant content is
	 * never updated afterwards.
	 */
	appendLaunchGrant(input: { guard: LaunchMutationGuard; request: GrantIssueRequest }): GrantIssueResult {
		this.#assertOpen();
		const { request } = input;
		const now = Date.now();
		try {
			return this.#db
				.transaction((): GrantIssueResult => {
					// Idempotency: the same request content under the same
					// idempotency key returns the recorded grant rather than
					// issuing a second one. Different content under the same
					// key is a conflict the caller must resolve.
					const candidate = this.#candidateGrant(input);
					const existing = this.#db
						.prepare("SELECT record_digest FROM launch_grants WHERE grant_id = ?")
						.get(candidate.grantId) as { record_digest: string } | undefined;
					if (existing) {
						if (existing.record_digest !== candidate.recordDigest) {
							throw new Error(
								`grant_conflict: idempotency key '${request.idempotencyKey}' already holds different content`,
							);
						}
						return { ok: true, grant: { grantId: candidate.grantId, recordDigest: candidate.recordDigest } };
					}

					let sourceDepth = Number.POSITIVE_INFINITY;
					for (const sourceId of request.sourceGrantIds) {
						const source = this.#db
							.prepare("SELECT record_digest, revoked_at FROM launch_grants WHERE grant_id = ?")
							.get(sourceId) as { record_digest: string; revoked_at: number | null } | undefined;
						if (!source) {
							throw new Error(`grant_source_not_found: source grant '${sourceId}' does not exist`);
						}
						if (source.revoked_at !== null) {
							// A revoked source must not authorize new
							// derivations, even if its content looks valid.
							throw new Error(`grant_source_revoked: source grant '${sourceId}' is revoked`);
						}
						const sourceRecord = JSON.parse(
							(
								this.#db
									.prepare("SELECT canonical_json FROM launch_grants WHERE grant_id = ?")
									.get(sourceId) as { canonical_json: string }
							).canonical_json,
						) as GrantRecordV1;
						sourceDepth = Math.min(sourceDepth, sourceRecord.remainingDelegationDepth - 1);
					}
					if (request.sourceGrantIds.length > 0 && request.remainingDelegationDepth > sourceDepth) {
						throw new Error(
							`delegation_depth_exceeded: requested depth ${request.remainingDelegationDepth} exceeds the narrowed source depth ${sourceDepth}`,
						);
					}

					const withDigest = candidate;

					this.#db
						.prepare(
							`INSERT INTO launch_grants (grant_id, record_digest, recipient_binding_id, issuer_principal_id, recipient_principal_id, attempt_id, contract_revision, policy_epoch, canonical_json, expires_at, created_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							withDigest.grantId,
							withDigest.recordDigest,
							request.recipientBindingId,
							request.issuerPrincipalId,
							request.recipientPrincipalId,
							request.attemptId,
							request.contractRevision,
							input.guard.expectedPolicyEpoch,
							canonicalJson(withDigest),
							request.expiresAt,
							now,
						);
					this.#db
						.prepare(
							`INSERT INTO launch_grant_events (event_id, grant_id, kind, actor_principal_id, policy_epoch, reason, record_digest, occurred_at)
							 VALUES (?, ?, 'issued', ?, ?, ?, ?, ?)`,
						)
						.run(
							`event-${withDigest.grantId}-issued`,
							withDigest.grantId,
							request.issuerPrincipalId,
							input.guard.expectedPolicyEpoch,
							request.purpose,
							withDigest.recordDigest,
							now,
						);
					for (const sourceId of request.sourceGrantIds) {
						this.#db
							.prepare(
								"INSERT OR IGNORE INTO launch_grant_edges (source_grant_id, derived_grant_id) VALUES (?, ?)",
							)
							.run(sourceId, withDigest.grantId);
					}
					return { ok: true, grant: { grantId: withDigest.grantId, recordDigest: withDigest.recordDigest } };
				})
				.immediate();
		} catch (error) {
			return {
				ok: false,
				code: "grant_issue_failed",
				diagnostics: [
					{
						code: "grant_issue_failed",
						message: error instanceof Error ? error.message : String(error),
						path: "appendLaunchGrant",
					},
				],
			};
		}
	}

	/**
	 * Revoke a grant. Content stays untouched; the revocation is an event,
	 * and every grant derived from this one is transitively revoked too — a
	 * revoked source must not keep authorising through its children.
	 */
	revokeLaunchGrant(input: { guard: LaunchMutationGuard; grantId: string; reason: string }): void {
		this.#assertOpen();
		const now = Date.now();
		this.#db
			.transaction(() => {
				const target = this.#db
					.prepare("SELECT revoked_at FROM launch_grants WHERE grant_id = ?")
					.get(input.grantId) as { revoked_at: number | null } | undefined;
				if (!target) {
					throw new LifecycleReadError("launch_grant_not_found", `grant '${input.grantId}' not found`);
				}
				if (target.revoked_at !== null) return;

				// BFS over lineage edges so derived grants fall with their
				// source, in the same transaction.
				const queue = [input.grantId];
				const revoked = new Set<string>();
				while (queue.length > 0) {
					const current = queue.shift() as string;
					if (revoked.has(current)) continue;
					revoked.add(current);
					this.#db
						.prepare("UPDATE launch_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL")
						.run(now, current);
					this.#db
						.prepare(
							`INSERT INTO launch_grant_events (event_id, grant_id, kind, actor_principal_id, policy_epoch, reason, record_digest, occurred_at)
							 VALUES (?, ?, 'revoked', ?, ?, ?, '', ?)`,
						)
						.run(
							`event-${current}-revoked-${now}`,
							current,
							"",
							input.guard.expectedPolicyEpoch,
							input.reason,
							now,
						);
					const children = (
						this.#db
							.prepare("SELECT derived_grant_id FROM launch_grant_edges WHERE source_grant_id = ?")
							.all(current) as { derived_grant_id: string }[]
					).map(row => row.derived_grant_id);
					queue.push(...children);
				}
			})
			.immediate();
	}

	getLaunchGrant(grantId: string): GrantRecordV1 {
		this.#assertOpen();
		const row = this.#db
			.prepare("SELECT canonical_json, revoked_at FROM launch_grants WHERE grant_id = ?")
			.get(grantId) as { canonical_json: string; revoked_at: number | null } | undefined;
		if (!row) throw new LifecycleReadError("launch_grant_not_found", `grant '${grantId}' not found`);
		return parseGrantRecordV1(JSON.parse(row.canonical_json));
	}

	/**
	 * The disclosure commit point (§14.5): atomic insertion into the
	 * recipient's durable context inbox PLUS channel-budget consumption.
	 *
	 * Stable (binding, delivery) is unique — the same content replays with
	 * zero extra budget; different content under the same id is a conflict.
	 * Admission before a revocation commits stays a historical disclosure; a
	 * revocation before commit denies.
	 */
	admitLaunchDelivery(input: {
		guard: LaunchMutationGuard;
		request: ContextDeliveryRequest;
		senderPrincipalId: string;
		bytes: number;
	}): ContextDeliveryResult {
		this.#assertOpen();
		const { request } = input;
		const now = Date.now();
		try {
			return this.#db
				.transaction((): ContextDeliveryResult => {
					const binding = this.#db
						.prepare("SELECT policy_epoch, state, child_principal_id FROM launch_bindings WHERE binding_id = ?")
						.get(request.recipientBindingId) as
						| { policy_epoch: number; state: string; child_principal_id: string }
						| undefined;
					if (!binding) {
						return this.#authorityFailure(
							"launch_binding_not_found",
							`binding '${request.recipientBindingId}' not found`,
						);
					}
					if (binding.policy_epoch !== request.expectedPolicyEpoch) {
						return this.#authorityFailure(
							"stale_launch_authority",
							`binding is at epoch ${binding.policy_epoch}, request expected ${request.expectedPolicyEpoch}`,
						);
					}
					if (binding.state === "revoked" || binding.state === "superseded") {
						// A revoked binding receives nothing further.
						return this.#authorityFailure(
							"launch_binding_revoked",
							`binding '${request.recipientBindingId}' is ${binding.state}`,
						);
					}

					// Deterministic digest over the delivery's identifying
					// content, computed here rather than trusted from the
					// caller: idempotency is decided by what was actually
					// admitted.
					const requestDigest = sha256Hex(
						canonicalJson({
							channelId: request.channelId,
							attemptId: request.attemptId,
							contractRevision: request.contractRevision,
							contextGeneration: request.contextGeneration,
							payloadRef: request.payloadRef,
							resourceRefs: request.resourceRefs,
							domains: request.domains,
							kind: request.kind,
						}),
					);
					const prior = this.#db
						.prepare("SELECT request_digest FROM launch_deliveries WHERE binding_id = ? AND delivery_id = ?")
						.get(request.recipientBindingId, request.deliveryId) as { request_digest: string } | undefined;
					if (prior) {
						if (prior.request_digest !== requestDigest) {
							return this.#authorityFailure(
								"delivery_conflict",
								`delivery '${request.deliveryId}' already holds different content`,
							);
						}
						// Idempotent replay: no second inbox row, no second
						// budget debit.
						const replayRecord = this.#deliveryRecord(
							request,
							input.senderPrincipalId,
							binding.child_principal_id,
							input.bytes,
							requestDigest,
						);
						return { ok: true, delivery: replayRecord, replayed: true };
					}

					const channel = this.#db
						.prepare(
							"SELECT consumed_bytes, consumed_messages, revoked_at, canonical_json FROM launch_channels WHERE binding_id = ? AND channel_id = ?",
						)
						.get(request.recipientBindingId, request.channelId) as
						| {
								consumed_bytes: number;
								consumed_messages: number;
								revoked_at: number | null;
								canonical_json: string;
						  }
						| undefined;
					if (!channel) {
						return this.#authorityFailure(
							"launch_channel_not_found",
							`channel '${request.channelId}' is not pinned for this binding`,
						);
					}
					if (channel.revoked_at !== null) {
						return this.#authorityFailure("launch_channel_revoked", `channel '${request.channelId}' is revoked`);
					}
					const limits = JSON.parse(channel.canonical_json) as {
						maxMessageBytes: number;
						maxTotalBytes: number;
						maxMessages: number;
					};
					if (input.bytes > limits.maxMessageBytes) {
						return this.#authorityFailure(
							"delivery_too_large",
							`${input.bytes} bytes exceeds the channel's ${limits.maxMessageBytes}-byte message bound`,
						);
					}
					if (channel.consumed_messages + 1 > limits.maxMessages) {
						return this.#authorityFailure(
							"delivery_budget_exhausted",
							`channel '${request.channelId}' has consumed ${channel.consumed_messages} of ${limits.maxMessages} messages`,
						);
					}
					if (channel.consumed_bytes + input.bytes > limits.maxTotalBytes) {
						return this.#authorityFailure(
							"delivery_budget_exhausted",
							`channel '${request.channelId}' would exceed its ${limits.maxTotalBytes}-byte total bound`,
						);
					}

					const record = this.#deliveryRecord(
						request,
						input.senderPrincipalId,
						binding.child_principal_id,
						input.bytes,
						requestDigest,
					);
					this.#db
						.prepare(
							`INSERT INTO launch_deliveries (binding_id, delivery_id, channel_id, sender_principal_id, recipient_principal_id, attempt_id, contract_revision, policy_epoch, context_generation, payload_json, bytes, request_digest, created_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							request.recipientBindingId,
							request.deliveryId,
							request.channelId,
							input.senderPrincipalId,
							record.recipientPrincipalId,
							request.attemptId,
							request.contractRevision,
							request.expectedPolicyEpoch,
							request.contextGeneration,
							JSON.stringify(record),
							input.bytes,
							requestDigest,
							now,
						);
					this.#db
						.prepare(
							"UPDATE launch_channels SET consumed_bytes = consumed_bytes + ?, consumed_messages = consumed_messages + 1, updated_at = ? WHERE binding_id = ? AND channel_id = ?",
						)
						.run(input.bytes, now, request.recipientBindingId, request.channelId);
					this.#db
						.prepare(
							`INSERT INTO launch_delivery_events (event_id, binding_id, delivery_id, kind, occurred_at)
							 VALUES (?, ?, ?, 'admitted', ?)`,
						)
						.run(
							`event-${request.recipientBindingId}-${request.deliveryId}-admitted`,
							request.recipientBindingId,
							request.deliveryId,
							now,
						);
					this.#db
						.prepare(
							`INSERT INTO launch_context_inbox (binding_id, context_generation, delivery_id, admission_order, content_ref, domains_json, admitted_epoch, admitted_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							request.recipientBindingId,
							request.contextGeneration,
							request.deliveryId,
							now,
							request.payloadRef.uri,
							JSON.stringify(request.domains),
							request.expectedPolicyEpoch,
							now,
						);
					return { ok: true, delivery: record, replayed: false };
				})
				.immediate();
		} catch (error) {
			return this.#authorityFailure(
				"delivery_admission_failed",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	#deliveryRecord(
		request: ContextDeliveryRequest,
		senderPrincipalId: string,
		recipientPrincipalId: string,
		bytes: number,
		requestDigest: string,
	): DeliveryRecordV1 {
		return Object.freeze({
			schemaVersion: 1 as const,
			deliveryId: request.deliveryId,
			channelId: request.channelId,
			senderPrincipalId,
			recipientPrincipalId,
			recipientBindingId: request.recipientBindingId,
			attemptId: request.attemptId,
			contractRevision: request.contractRevision,
			policyEpoch: request.expectedPolicyEpoch,
			contextGeneration: request.contextGeneration,
			payloadRef: request.payloadRef,
			resourceRefs: request.resourceRefs,
			domains: request.domains,
			kind: request.kind,
			bytes,
			requestDigest,
		});
	}
	/**
	 * Records a durable provider outcome for an admitted delivery
	 * (§14.5/LC23). `provider-unknown` after a timeout must NOT refund the
	 * disclosure or imply exactly-once processing; it only records that the
	 * outcome could not be observed.
	 */
	recordLaunchProviderOutcome(input: {
		guard: LaunchMutationGuard;
		bindingId: string;
		deliveryId: string;
		requestId: string;
		outcome: "provider-known" | "provider-unknown";
	}): void {
		this.#assertOpen();
		this.#db
			.prepare(
				`INSERT INTO launch_delivery_events (event_id, binding_id, delivery_id, kind, request_id, occurred_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				`event-${input.bindingId}-${input.deliveryId}-${input.outcome}-${input.requestId}`,
				input.bindingId,
				input.deliveryId,
				input.outcome,
				input.requestId,
				Date.now(),
			);
	}

	/**
	 * Steps 3-4: record measured runtime guarantees, then make the binding
	 * live.
	 *
	 * Activation REFUSES to proceed when the measured guarantees fall short
	 * of the contract's requirements on any dimension. Recording them without
	 * that check would let a binding advertise containment nobody probed for,
	 * which is worse than advertising none.
	 */
	activateLaunchBinding(input: LaunchBindingActivationInput): LaunchBindingActivationResult {
		this.#assertOpen();
		const now = Date.now();
		try {
			return this.#db
				.transaction((): LaunchBindingActivationResult => {
					const row = this.#db
						.prepare(
							"SELECT binding_id, contract_digest, state, policy_epoch FROM launch_bindings WHERE binding_id = ?",
						)
						.get(input.bindingId) as
						| { binding_id: string; contract_digest: string; state: string; policy_epoch: number }
						| undefined;
					if (!row) {
						return this.#authorityFailure("launch_binding_not_found", `binding '${input.bindingId}' not found`);
					}
					if (row.state !== input.expectedState) {
						// CAS on state: a concurrent revoke or supersede must not
						// be overwritten by a late activation.
						return this.#authorityFailure(
							"launch_binding_state_conflict",
							`binding '${input.bindingId}' is '${row.state}', expected '${input.expectedState}'`,
						);
					}
					if (row.policy_epoch !== input.guard.expectedPolicyEpoch) {
						return this.#authorityFailure(
							"stale_launch_authority",
							`binding '${input.bindingId}' is at epoch ${row.policy_epoch}, guard expected ${input.guard.expectedPolicyEpoch}`,
						);
					}

					const contractRow = this.#db
						.prepare("SELECT canonical_json FROM launch_contracts WHERE digest = ?")
						.get(row.contract_digest) as { canonical_json: string } | undefined;
					if (!contractRow) {
						return this.#authorityFailure(
							"launch_contract_not_found",
							`contract '${row.contract_digest}' referenced by the binding is missing`,
						);
					}
					const contract = JSON.parse(contractRow.canonical_json) as CompiledLaunchContract;
					const shortfalls = compareRuntimeGuarantees(
						contract.authority.requiredRuntimeGuarantees,
						input.actualRuntimeGuarantees,
					);
					if (shortfalls.length > 0) {
						return {
							ok: false,
							code: "required_isolation_unavailable",
							diagnostics: shortfalls.map(s => ({
								code: "required_isolation_unavailable",
								message: `${String(s.dimension)} requires '${s.required}' but the runtime provides '${s.actual}'`,
								path: `actualRuntimeGuarantees.${String(s.dimension)}`,
							})),
						};
					}
					if (input.guaranteeEvidenceRefs.length === 0) {
						return this.#authorityFailure(
							"guarantee_evidence_required",
							"activation requires evidence for the measured guarantees",
						);
					}

					const nextState = input.expectedState === "authorized" ? "bound" : "active";
					this.#db
						.prepare(
							`UPDATE launch_bindings SET state = ?, session_id = ?, process_ref = ?, service_bindings_json = ?, actual_guarantees_json = ?, guarantee_evidence_json = ?, updated_at = ?
						 WHERE binding_id = ? AND state = ? AND policy_epoch = ?`,
						)
						.run(
							nextState,
							input.sessionId,
							input.processRef,
							JSON.stringify(input.serviceBindings),
							JSON.stringify(input.actualRuntimeGuarantees),
							JSON.stringify(input.guaranteeEvidenceRefs),
							now,
							input.bindingId,
							input.expectedState,
							input.guard.expectedPolicyEpoch,
						);

					return {
						ok: true,
						launch: bindLaunchContract(contract, {
							runId: contract.contractId,
							nodeId: contract.childPrincipalId,
							ownerNodeId: null,
							attemptId: input.bindingId,
							budgetReservationId: `reservation-${input.bindingId}`,
							leaseEpoch: 1,
							cancellationGeneration: 0,
						}),
						replayed: false,
					};
				})
				.immediate();
		} catch (error) {
			return this.#authorityFailure("activation_failed", error instanceof Error ? error.message : String(error));
		}
	}

	#authorityFailure(code: string, message: string): LaunchAuthorityFailure {
		return { ok: false, code, diagnostics: [{ code, message, path: "launchAuthority" }] };
	}

	/** Throws rather than returning null: a missing binding is never "no authority yet". */
	getLaunchBinding(bindingId: string): LaunchBinding {
		this.#assertOpen();
		const row = this.#db.prepare("SELECT * FROM launch_bindings WHERE binding_id = ?").get(bindingId) as
			| Record<string, unknown>
			| undefined;
		if (!row) throw new LifecycleReadError("launch_binding_not_found", `binding '${bindingId}' not found`);
		return Object.freeze({
			schemaVersion: 1 as const,
			bindingId: row.binding_id as string,
			contractId: row.contract_id as string,
			contractRevision: row.contract_revision as number,
			contractDigest: row.contract_digest as string,
			rootPrincipalId: row.root_principal_id as string,
			parentPrincipalId: row.parent_principal_id as string,
			childPrincipalId: row.child_principal_id as string,
			attemptId: row.attempt_id as string,
			sessionId: (row.session_id ?? null) as string | null,
			processRef: (row.process_ref ?? null) as string | null,
			policyEpoch: row.policy_epoch as number,
			contextGeneration: row.context_generation as number,
			state: row.state as LaunchBinding["state"],
			grantBindings: JSON.parse(row.grant_bindings_json as string) as LaunchBinding["grantBindings"],
			serviceBindings: JSON.parse(row.service_bindings_json as string) as LaunchBinding["serviceBindings"],
			actualRuntimeGuarantees: row.actual_guarantees_json
				? (JSON.parse(row.actual_guarantees_json as string) as RuntimeGuaranteesV1)
				: null,
			guaranteeEvidenceRefs: JSON.parse(row.guarantee_evidence_json as string) as readonly ArtifactRefV1[],
			reservationId: (row.reservation_id ?? null) as string | null,
			lifecycle: row.lifecycle_json
				? (JSON.parse(row.lifecycle_json as string) as LaunchBinding["lifecycle"])
				: null,
			expiresAt: (row.expires_at ?? null) as number | null,
			restoresBindingId: (row.restores_binding_id ?? null) as string | null,
		});
	}

	getLaunchContract(digest: string): CompiledLaunchContract {
		this.#assertOpen();
		const row = this.#db.prepare("SELECT canonical_json FROM launch_contracts WHERE digest = ?").get(digest) as
			| { canonical_json: string }
			| undefined;
		if (!row) throw new LifecycleReadError("launch_contract_not_found", `contract '${digest}' not found`);
		return JSON.parse(row.canonical_json) as CompiledLaunchContract;
	}

	listLifecycleNodes(
		runId: string,
	): { nodeId: string; ownerNodeId: string | null; role: string; plannerActivity: string }[] {
		this.#assertOpen();
		const rows = this.#db
			.prepare(
				"SELECT node_id, owner_node_id, role, planner_activity FROM lifecycle_nodes WHERE run_id = ? ORDER BY node_id ASC",
			)
			.all(runId) as { node_id: string; owner_node_id: string | null; role: string; planner_activity: string }[];
		return rows.map(row => ({
			nodeId: row.node_id,
			ownerNodeId: row.owner_node_id,
			role: row.role,
			plannerActivity: row.planner_activity,
		}));
	}

	listLifecycleAttempts(nodeId: string): {
		attemptId: string;
		execution: string;
		capture: string;
		delivery: string;
		publication: string;
		verification: string;
	}[] {
		this.#assertOpen();
		const rows = this.#db
			.prepare(
				"SELECT attempt_id, execution_state, capture_state, delivery_state, publication_state, verification_state FROM lifecycle_attempts WHERE node_id = ? ORDER BY ordinal ASC",
			)
			.all(nodeId) as {
			attempt_id: string;
			execution_state: string;
			capture_state: string;
			delivery_state: string;
			publication_state: string;
			verification_state: string;
		}[];
		return rows.map(row => ({
			attemptId: row.attempt_id,
			execution: row.execution_state,
			capture: row.capture_state,
			delivery: row.delivery_state,
			publication: row.publication_state,
			verification: row.verification_state,
		}));
	}

	listPendingHandoffs(limit = 100): string[] {
		this.#assertOpen();
		const rows = this.#db
			.prepare(
				"SELECT event_id FROM lifecycle_handoffs WHERE status = 'pending' ORDER BY created_at ASC, event_id ASC LIMIT ?",
			)
			.all(this.#normalizeLimit(limit) || 100) as { event_id: string }[];
		return rows.map(row => row.event_id);
	}

	deliverLifecycleHandoff(eventId: string): boolean {
		this.#assertOpen();
		const tx = this.#db.transaction(() => {
			const handoff = this.#db.prepare("SELECT * FROM lifecycle_handoffs WHERE event_id = ?").get(eventId) as
				| { status: string; owner_node_id: string | null }
				| undefined;
			if (handoff?.status !== "pending") return false;
			const now = this.#now();
			if (handoff.owner_node_id) {
				this.#db
					.prepare(`
					INSERT OR IGNORE INTO lifecycle_inbox (owner_node_id, event_id, status, created_at)
					VALUES (?, ?, 'pending', ?)
				`)
					.run(handoff.owner_node_id, eventId, now);
			}
			this.#db.prepare("UPDATE lifecycle_handoffs SET status = 'delivered' WHERE event_id = ?").run(eventId);
			return true;
		});
		return tx.immediate();
	}

	prepareLifecyclePlannerTurn(input: PlannerTurnInput): PlannerTurnRecord {
		this.#assertOpen();
		if (input.maxEvents <= 0) throw new Error("maxEvents must be positive");
		const tx = this.#db.transaction(() => {
			const now = this.#now();
			const rows = this.#db
				.prepare(`
					SELECT i.event_id, h.packet_json FROM lifecycle_inbox i
					JOIN lifecycle_handoffs h ON h.event_id = i.event_id
					WHERE i.owner_node_id = ? AND i.status = 'pending'
					ORDER BY h.created_at ASC, h.event_id ASC LIMIT ?
				`)
				.all(input.ownerNodeId, input.maxEvents) as { event_id: string; packet_json: string }[];
			const inputEvents = rows.map(row => parseJsonValue(row.packet_json) as unknown as LifecycleHandoffV1);
			const inputHash = createHash("sha256")
				.update(JSON.stringify(rows.map(row => row.event_id)))
				.digest("hex");
			const turnId = this.#createId();
			this.#db
				.prepare(`
					INSERT INTO lifecycle_planner_turns (turn_id, owner_node_id, expected_plan_version, input_event_hash, state, created_at)
					VALUES (?, ?, ?, ?, 'prepared', ?)
				`)
				.run(turnId, input.ownerNodeId, input.expectedPlanVersion, inputHash, now);
			for (const row of rows) {
				this.#db
					.prepare(
						"UPDATE lifecycle_inbox SET status = 'claimed', planner_turn_id = ? WHERE owner_node_id = ? AND event_id = ?",
					)
					.run(turnId, input.ownerNodeId, row.event_id);
			}
			return { turnId, inputEvents, inputHash };
		});
		return tx.immediate();
	}

	commitLifecyclePlannerTurn(input: PlannerTurnCommitInput): PlannerTurnCommitResult {
		this.#assertOpen();
		const tx = this.#db.transaction(() => {
			const turn = this.#db.prepare("SELECT * FROM lifecycle_planner_turns WHERE turn_id = ?").get(input.turnId) as
				| { owner_node_id: string; expected_plan_version: number; input_event_hash: string; state: string }
				| undefined;
			if (!turn) {
				return { ok: false, code: "stale_fence", message: "Planner turn not found." } as const;
			}
			if (turn.state !== "prepared") {
				return { ok: false, code: "stale_fence", message: "Planner turn already committed." } as const;
			}
			const node = this.#db
				.prepare("SELECT run_id FROM lifecycle_nodes WHERE node_id = ?")
				.get(turn.owner_node_id) as { run_id: string } | undefined;
			if (!node) {
				return { ok: false, code: "stale_fence", message: "Owner node not found." } as const;
			}
			const run = this.#db.prepare("SELECT plan_version FROM lifecycle_runs WHERE run_id = ?").get(node.run_id) as
				| { plan_version: number }
				| undefined;
			if (
				!run ||
				run.plan_version !== input.expectedPlanVersion ||
				run.plan_version !== turn.expected_plan_version
			) {
				return {
					ok: false,
					code: "version_conflict",
					message: "Plan version changed since the turn was prepared.",
				} as const;
			}
			const now = this.#now();
			for (const action of input.actions) {
				if (action.kind === "add-dependency") {
					this.#db
						.prepare("INSERT OR IGNORE INTO lifecycle_dependencies (node_id, prerequisite_id) VALUES (?, ?)")
						.run(action.nodeId, action.prerequisiteId);
				} else if (action.kind === "resolve-obligation") {
					this.#db
						.prepare(
							"UPDATE lifecycle_obligations SET state = 'resolved', evidence_receipt_ids_json = ?, version = version + 1, updated_at = ? WHERE obligation_id = ?",
						)
						.run(JSON.stringify(action.evidenceReceiptIds), now, action.obligationId);
				}
			}
			const newPlanVersion = run.plan_version + 1;
			this.#db
				.prepare("UPDATE lifecycle_runs SET plan_version = ?, updated_at = ? WHERE run_id = ?")
				.run(newPlanVersion, now, node.run_id);
			this.#db
				.prepare("UPDATE lifecycle_planner_turns SET state = 'committed', result_ref = ? WHERE turn_id = ?")
				.run(input.result.uri, input.turnId);
			this.#db
				.prepare("UPDATE lifecycle_inbox SET status = 'consumed' WHERE planner_turn_id = ? AND status = 'claimed'")
				.run(input.turnId);
			return { ok: true, newPlanVersion } as const;
		});
		return tx.immediate();
	}

	transitionLifecycleObligation(input: ObligationTransitionInput): ObligationV1 {
		this.#assertOpen();
		const tx = this.#db.transaction(() => {
			const row = this.#db
				.prepare("SELECT * FROM lifecycle_obligations WHERE obligation_id = ?")
				.get(input.obligationId) as
				| {
						obligation_id: string;
						run_id: string;
						node_id: string;
						criterion_id: string;
						kind: ObligationV1["kind"];
						state: ObligationV1["state"];
						evidence_receipt_ids_json: string;
						waiver_authorization_ref: string | null;
						version: number;
				  }
				| undefined;
			if (!row) throw new Error(`Obligation '${input.obligationId}' not found`);
			if (row.version !== input.expectedVersion) throw new Error("Obligation version conflict");
			if (input.state === "resolved" && input.evidenceReceiptIds.length === 0) {
				throw new Error("Resolving an obligation requires evidence receipt ids");
			}
			if (input.state === "waived" && !input.waiverAuthorizationRef) {
				throw new Error("Waiving an obligation requires an authorization ref");
			}
			const now = this.#now();
			this.#db
				.prepare(`
					UPDATE lifecycle_obligations
					SET state = ?, evidence_receipt_ids_json = ?, waiver_authorization_ref = ?, version = version + 1, updated_at = ?
					WHERE obligation_id = ?
				`)
				.run(
					input.state,
					JSON.stringify(input.evidenceReceiptIds),
					input.waiverAuthorizationRef,
					now,
					input.obligationId,
				);
			return {
				schemaVersion: 1,
				obligationId: row.obligation_id,
				runId: row.run_id,
				nodeId: row.node_id,
				criterionId: row.criterion_id,
				kind: row.kind,
				state: input.state,
				evidenceReceiptIds: [...input.evidenceReceiptIds],
				waiverAuthorizationRef: input.waiverAuthorizationRef,
				version: row.version + 1,
			} satisfies ObligationV1;
		});
		return tx.immediate();
	}

	#normalizeLimit(limit: number): number {
		if (!Number.isFinite(limit) || limit <= 0) return 0;
		return Math.min(Math.floor(limit), 10_000);
	}
}
