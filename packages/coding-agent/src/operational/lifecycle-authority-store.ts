import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils";
import { getLifecycleRegistration } from "../orchestration/lifecycle-authority";
import {
	type ArtifactRefV1,
	bindLaunchContract,
	type CompiledLaunchContract,
	canonicalJson,
	compareRuntimeGuarantees,
	computeLaunchContractDigest,
	type GrantRecordV1,
	type LaunchBinding,
	type LaunchBindingState,
	type LaunchClass,
	parseGrantRecordV1,
	type RuntimeGuaranteesV1,
	sha256Hex,
} from "../task/launch-contract";
import type {
	ContextDeliveryRequest,
	ContextDeliveryResult,
	DeliveryRecordV1,
	GrantIssueRequest,
	GrantIssueResult,
	LaunchAuthorityAdmissionInput,
	LaunchAuthorityAdmissionResult,
	LaunchAuthorityFailure,
	LaunchBindingActivationInput,
	LaunchBindingActivationResult,
	LaunchMutationGuard,
	LaunchMutationResult,
} from "./lifecycle-types";

/**
 * Durable launch authority (§14.5): principals, compiled contracts, bindings,
 * grants and context deliveries.
 *
 * It lives in its own SQLite file next to `operational.db` rather than inside
 * it. The operational store keeps its own schema version, so turning lifecycle
 * on never migrates the file every older build and every legacy caller opens,
 * and a build without lifecycle support can still read it. Nothing opens this
 * file unless `task.lifecycle.enabled` installed a lifecycle issuer, or a
 * session recorded under lifecycle is being revived.
 */

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

/** States whose authority may still be mutated by an authenticated issuer. */
function isLiveLaunchBindingState(state: string): boolean {
	return state === "authorized" || state === "bound" || state === "active" || state === "suspended";
}

/** A `launch_principals` row as read back by `getLaunchPrincipal` (§14.5). */
export interface LaunchPrincipalRow {
	readonly principalId: string;
	readonly rootPrincipalId: string | null;
	readonly parentPrincipalId: string | null;
	readonly launchClass: LaunchClass | null;
	readonly authorityEnvelopeRef: string | null;
	readonly policyEpoch: number;
	readonly status: "active" | "revoked" | "terminal";
	readonly createdAt: number;
	readonly updatedAt: number;
}

/**
 * Result of `terminateLaunchBinding`: the binding's post-call state and the
 * epoch it now carries. Terminalization is idempotent — replaying it against
 * an already-terminal binding returns ok rather than a conflict.
 */
export type LaunchBindingTerminationResult =
	| {
			readonly ok: true;
			readonly bindingId: string;
			readonly state: LaunchBindingState;
			readonly policyEpoch: number;
	  }
	| LaunchAuthorityFailure;

const SCHEMA_VERSION = 1;

export interface LifecycleAuthorityStoreOptions {
	/** Explicit SQLite path. Defaults to `~/.ompk/agent/lifecycle-authority.db`. */
	readonly dbPath?: string;
	/** SQLite synchronous mode. Production defaults to `full`; tests may opt into `normal`. */
	readonly durability?: "full" | "normal";
}

export function defaultLifecycleAuthorityDbPath(): string {
	return path.join(getAgentDir(), "lifecycle-authority.db");
}

// Authority records are append-only by construction. Contract and grant
// CONTENT is never UPDATEd; revocation and supersession are separate event
// rows, so history stays reconstructable after the fact rather than being
// overwritten in place.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
	version INTEGER PRIMARY KEY
);

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

-- reservation_id and lifecycle_json belong to the LaunchBinding wire shape.
-- Authority-only admission has no scheduler job, so it leaves both NULL.
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
`;

export class LifecycleAuthorityStore {
	readonly #db: Database;
	readonly #dbPath: string;
	#closed = false;

	constructor(options: LifecycleAuthorityStoreOptions = {}) {
		this.#dbPath = options.dbPath ?? defaultLifecycleAuthorityDbPath();
		fs.mkdirSync(path.dirname(this.#dbPath), { recursive: true });
		this.#db = new Database(this.#dbPath);
		// 30s rather than 5s: every mutation uses BEGIN IMMEDIATE, so writers
		// queue on the write lock rather than deadlocking. Under concurrent
		// admissions from independent processes a 5s wait was exceeded and
		// admissions failed with SQLITE_BUSY despite the protocol being correct.
		this.#db.run("PRAGMA busy_timeout = 30000");
		this.#db.run("PRAGMA journal_mode = WAL");
		this.#db.run(`PRAGMA synchronous = ${options.durability === "normal" ? "NORMAL" : "FULL"}`);
		this.#db.run("PRAGMA foreign_keys = ON");
		try {
			this.#initializeSchema();
		} catch (error) {
			// A refused or failed open must not leave the connection (and, on
			// Windows, the file lock) behind.
			this.#db.close();
			throw error;
		}
	}

	/** Open (or create) the lifecycle authority SQLite database. */
	static open(options: LifecycleAuthorityStoreOptions = {}): LifecycleAuthorityStore {
		return new LifecycleAuthorityStore(options);
	}

	get dbPath(): string {
		return this.#dbPath;
	}

	/**
	 * Every statement goes through `db.query()`, whose cache `close()`
	 * finalizes, so closing releases the connection and its WAL handles
	 * without a forced checkpoint that would stall on a concurrent writer.
	 */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("LifecycleAuthorityStore is closed");
	}

	/**
	 * The version check, DDL and version write run in one IMMEDIATE
	 * transaction so two processes opening a fresh file cannot interleave.
	 */
	#initializeSchema(): void {
		this.#db
			.transaction(() => {
				this.#db.run(SCHEMA_SQL);
				const versionRow = this.#db
					.query("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
					.get() as { version?: number } | null;
				const current = typeof versionRow?.version === "number" ? versionRow.version : 0;
				if (current > SCHEMA_VERSION) {
					throw new Error(
						`Lifecycle authority database schema ${current} is newer than supported version ${SCHEMA_VERSION}`,
					);
				}
				if (current < SCHEMA_VERSION) {
					this.#db.query("INSERT OR REPLACE INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
				}
			})
			.immediate();
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
		const attemptId = `attempt-${compiled.contractId}-${compiled.contractRevision}`;

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
						// Authenticate the mutating actor BEFORE any write: the
						// guard's context must resolve to a registered issuer whose
						// durable principal/binding is live at the claimed epoch,
						// and whose lineage matches the contract being admitted.
						const actorDenied = this.#authenticateActor(guard, {
							rootPrincipalId: compiled.rootPrincipalId,
							parentPrincipalId: compiled.parentPrincipalId,
						});
						if (actorDenied) return actorDenied;
						const admitted = this.#admitLaunchAuthorityRow({
							compiled,
							attemptId,
							policyEpoch: guard.expectedPolicyEpoch,
							restoresBindingId: input.restoresBindingId,
						});
						if (!admitted.ok) return admitted;
						// Bound against the row that was just committed, read back
						// through the same decoder every other reader uses.
						return {
							ok: true,
							launch: bindLaunchContract(compiled, this.getLaunchBinding(admitted.bindingId)),
							replayed: admitted.replayed,
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

	/**
	 * The launch-authority row writer.
	 *
	 * Persists the compiled contract, the root/issuer/child principal rows
	 * and EXACTLY ONE `launch_bindings` row, or resolves the row an earlier
	 * admission of the same attempt already committed, so a replay can never
	 * mint a second authority for one attempt.
	 *
	 * MUST be called inside the caller's `.immediate()` transaction: it
	 * neither opens one nor retries, so authority commits atomically with
	 * whatever else that transaction writes.
	 */
	#admitLaunchAuthorityRow(input: {
		readonly compiled: CompiledLaunchContract;
		readonly attemptId: string;
		readonly policyEpoch: number;
		readonly restoresBindingId: string | null;
	}): { readonly ok: true; readonly bindingId: string; readonly replayed: boolean } | LaunchAuthorityFailure {
		const { compiled, attemptId } = input;
		const now = Date.now();

		// Recompute the canonical digest BEFORE any write or replay lookup:
		// a tampered body must fail with a typed diagnostic and commit
		// nothing, never surface as a generic admission failure or ride in
		// behind an existing attempt row.
		const { contractDigest, ...body } = compiled;
		if (computeLaunchContractDigest(body) !== contractDigest) {
			return {
				ok: false,
				code: "digest_mismatch",
				diagnostics: [
					{
						code: "digest_mismatch",
						message: `compiled contract '${compiled.contractId}' digest does not recompute from its body`,
						path: "compiled.contractDigest",
					},
				],
			};
		}

		const existing = this.#db
			.query("SELECT binding_id, contract_digest FROM launch_bindings WHERE attempt_id = ?")
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
			return { ok: true, bindingId: existing.binding_id, replayed: true };
		}

		this.#db
			.query(
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

		// §14.5 lazy principal persistence: the launch_principals
		// row for the root, the issuer and the new child is written
		// inside the SAME transaction that commits the contract and
		// authorized binding, so a root stays scheduler-free until
		// its first delegated child. INSERT OR IGNORE keeps the
		// first-recorded lineage; a later admission never rewrites
		// an existing principal's parent or envelope.
		this.ensureLaunchPrincipal(compiled.rootPrincipalId, compiled.rootPrincipalId, null, null);
		if (compiled.parentPrincipalId !== compiled.rootPrincipalId) {
			const parentRow = this.#db
				.query(
					`SELECT parent_principal_id, digest FROM launch_contracts
					 WHERE child_principal_id = ? ORDER BY rowid DESC LIMIT 1`,
				)
				.get(compiled.parentPrincipalId) as { parent_principal_id: string; digest: string } | undefined;
			this.ensureLaunchPrincipal(
				compiled.parentPrincipalId,
				compiled.rootPrincipalId,
				parentRow?.parent_principal_id ?? null,
				parentRow?.digest ?? null,
			);
		}
		this.ensureLaunchPrincipal(
			compiled.childPrincipalId,
			compiled.rootPrincipalId,
			compiled.parentPrincipalId,
			compiled.contractDigest,
			{ launchClass: compiled.authority.launchClass, policyEpoch: input.policyEpoch },
		);

		const bindingId = `binding-${compiled.contractId}-${compiled.contractRevision}-${attemptId}`;
		this.#db
			.query(
				`INSERT INTO launch_bindings (binding_id, contract_id, contract_revision, contract_digest, root_principal_id, parent_principal_id, child_principal_id, attempt_id, policy_epoch, context_generation, state, restores_binding_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'authorized', ?, ?, ?)`,
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
				input.policyEpoch,
				input.restoresBindingId,
				now,
				now,
			);

		return { ok: true, bindingId, replayed: false };
	}

	/**
	 * Authenticate the mutating actor inside the caller's `.immediate()`
	 * transaction. The guard's context must resolve to a registered issuer
	 * whose durable identity is live at the epoch the guard claims:
	 *
	 * - A bound actor (`registration.authority`) must be the child principal
	 *   of a live (`bound`/`active`) binding whose epoch matches both the
	 *   registration's pinned epoch and `guard.expectedPolicyEpoch`, and it
	 *   may only mutate authority it issued: `expected.parentPrincipalId`
	 *   must be that principal and `expected.rootPrincipalId` must be the
	 *   binding's recorded root.
	 * - A root actor (`registration.root`) may only issue for its own
	 *   principal: `expected.parentPrincipalId` and `expected.rootPrincipalId`
	 *   must both equal the root principal id. When the principal row exists
	 *   it must be `active` at the claimed epoch; when it does not (lazy
	 *   persistence), only the schema-default epoch 1 is honest.
	 *
	 * Returns null when the actor authenticates; otherwise the typed failure
	 * the caller returns without writing anything.
	 */
	#authenticateActor(
		guard: LaunchMutationGuard,
		expected: { readonly rootPrincipalId: string; readonly parentPrincipalId: string },
	): LaunchAuthorityFailure | null {
		const registration = getLifecycleRegistration(guard.actor);
		if (!registration) {
			return this.#authorityFailure(
				"unauthenticated_actor",
				"mutation guard carries no registered execution context",
			);
		}
		const authority = registration.authority;
		if (authority) {
			const issuer = this.#db
				.query(
					"SELECT state, policy_epoch, child_principal_id, root_principal_id FROM launch_bindings WHERE binding_id = ?",
				)
				.get(authority.bindingId) as
				| { state: string; policy_epoch: number; child_principal_id: string; root_principal_id: string }
				| undefined;
			if (!issuer) {
				return this.#authorityFailure(
					"unauthenticated_actor",
					`actor binding '${authority.bindingId}' is not persisted`,
				);
			}
			if (issuer.state !== "bound" && issuer.state !== "active") {
				return this.#authorityFailure(
					"unauthenticated_actor",
					`actor binding '${authority.bindingId}' is '${issuer.state}', not live`,
				);
			}
			if (
				issuer.child_principal_id !== authority.principalId ||
				issuer.policy_epoch !== authority.policyEpoch ||
				issuer.policy_epoch !== guard.expectedPolicyEpoch
			) {
				return this.#authorityFailure(
					"stale_launch_authority",
					`actor binding '${authority.bindingId}' is at epoch ${issuer.policy_epoch}, guard expected ${guard.expectedPolicyEpoch}`,
				);
			}
			if (
				authority.principalId !== expected.parentPrincipalId ||
				issuer.root_principal_id !== expected.rootPrincipalId
			) {
				return this.#authorityFailure(
					"unauthenticated_actor",
					"actor lineage does not match the mutated authority's parent/root principals",
				);
			}
			return null;
		}
		const root = registration.root;
		if (root) {
			if (
				expected.parentPrincipalId !== expected.rootPrincipalId ||
				root.rootPrincipalId !== expected.rootPrincipalId
			) {
				return this.#authorityFailure(
					"unauthenticated_actor",
					"a root actor may only issue authority whose parent is that root principal",
				);
			}
			const principal = this.#db
				.query("SELECT status, policy_epoch FROM launch_principals WHERE principal_id = ?")
				.get(root.rootPrincipalId) as { status: string; policy_epoch: number } | undefined;
			if (principal) {
				if (principal.status !== "active") {
					return this.#authorityFailure(
						"unauthenticated_actor",
						`actor principal '${root.rootPrincipalId}' is '${principal.status}'`,
					);
				}
				if (principal.policy_epoch !== guard.expectedPolicyEpoch) {
					return this.#authorityFailure(
						"stale_launch_authority",
						`actor principal '${root.rootPrincipalId}' is at epoch ${principal.policy_epoch}, guard expected ${guard.expectedPolicyEpoch}`,
					);
				}
			} else if (guard.expectedPolicyEpoch !== 1) {
				return this.#authorityFailure(
					"stale_launch_authority",
					`actor principal '${root.rootPrincipalId}' is unpersisted at epoch 1, guard expected ${guard.expectedPolicyEpoch}`,
				);
			}
			return null;
		}
		return this.#authorityFailure(
			"unauthenticated_actor",
			"registered context carries neither root nor bound authority",
		);
	}

	/**
	 * §14.5 lazy principal persistence (additive). INSERT OR IGNOREs one row
	 * into `launch_principals`: the first-recorded lineage wins and a later
	 * admission never rewrites an existing principal's parent or envelope.
	 * Called inside `admitLaunchAuthority`'s transaction for the root, the
	 * issuer and the new child; also safe standalone (autocommit) for a host
	 * that wants to persist a root principal before any child exists.
	 *
	 * `envelopeRef` is the durable ref backing the principal's authority
	 * envelope — the contract digest for a contract-admitted principal, null
	 * for a lazily stubbed root/issuer row whose envelope is not persisted.
	 */
	ensureLaunchPrincipal(
		principalId: string,
		rootPrincipalId: string,
		parentPrincipalId: string | null,
		envelopeRef: string | null,
		opts?: { readonly launchClass?: LaunchClass | null; readonly policyEpoch?: number },
	): void {
		this.#assertOpen();
		const now = Date.now();
		this.#db
			.query(
				`INSERT OR IGNORE INTO launch_principals
				 (principal_id, root_principal_id, parent_principal_id, launch_class, authority_envelope_ref, policy_epoch, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				principalId,
				rootPrincipalId,
				parentPrincipalId,
				opts?.launchClass ?? null,
				envelopeRef,
				opts?.policyEpoch ?? 1,
				now,
				now,
			);
	}

	/** Read-back for a lazily persisted principal; null when none was recorded. */
	getLaunchPrincipal(principalId: string): LaunchPrincipalRow | null {
		this.#assertOpen();
		const row = this.#db.query("SELECT * FROM launch_principals WHERE principal_id = ?").get(principalId) as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;
		return Object.freeze({
			principalId: row.principal_id as string,
			rootPrincipalId: (row.root_principal_id ?? null) as string | null,
			parentPrincipalId: (row.parent_principal_id ?? null) as string | null,
			launchClass: (row.launch_class ?? null) as LaunchClass | null,
			authorityEnvelopeRef: (row.authority_envelope_ref ?? null) as string | null,
			policyEpoch: row.policy_epoch as number,
			status: row.status as LaunchPrincipalRow["status"],
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
		});
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
					const binding = this.#db
						.query(
							`SELECT state, policy_epoch, root_principal_id, parent_principal_id, child_principal_id, attempt_id, contract_revision
							 FROM launch_bindings WHERE binding_id = ?`,
						)
						.get(request.recipientBindingId) as
						| {
								state: string;
								policy_epoch: number;
								root_principal_id: string;
								parent_principal_id: string;
								child_principal_id: string;
								attempt_id: string;
								contract_revision: number;
						  }
						| undefined;
					if (!binding) {
						return this.#authorityFailure(
							"launch_binding_not_found",
							`binding '${request.recipientBindingId}' not found`,
						);
					}
					if (binding.policy_epoch !== input.guard.expectedPolicyEpoch) {
						return this.#authorityFailure(
							"stale_launch_authority",
							`binding is at epoch ${binding.policy_epoch}, guard expected ${input.guard.expectedPolicyEpoch}`,
						);
					}
					if (!isLiveLaunchBindingState(binding.state)) {
						return this.#authorityFailure(
							"launch_binding_not_live",
							`binding '${request.recipientBindingId}' is '${binding.state}', not live`,
						);
					}
					const actorDenied = this.#authenticateActor(input.guard, {
						rootPrincipalId: binding.root_principal_id,
						parentPrincipalId: binding.parent_principal_id,
					});
					if (actorDenied) return actorDenied;
					if (
						request.issuerPrincipalId !== binding.parent_principal_id ||
						request.recipientPrincipalId !== binding.child_principal_id
					) {
						return this.#authorityFailure(
							"grant_principal_mismatch",
							"grant issuer/recipient principals do not match the durable recipient binding",
						);
					}
					if (request.attemptId !== binding.attempt_id || request.contractRevision !== binding.contract_revision) {
						return this.#authorityFailure(
							"grant_binding_mismatch",
							"grant attempt/revision do not match the durable recipient binding",
						);
					}

					// Idempotency: the same request content under the same
					// idempotency key returns the recorded grant rather than
					// issuing a second one. Different content under the same
					// key is a conflict the caller must resolve.
					const candidate = this.#candidateGrant(input);
					const existing = this.#db
						.query("SELECT record_digest FROM launch_grants WHERE grant_id = ?")
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
							.query("SELECT record_digest, revoked_at FROM launch_grants WHERE grant_id = ?")
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
								this.#db.query("SELECT canonical_json FROM launch_grants WHERE grant_id = ?").get(sourceId) as {
									canonical_json: string;
								}
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
						.query(
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
						.query(
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
							.query(
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
	revokeLaunchGrant(input: { guard: LaunchMutationGuard; grantId: string; reason: string }): LaunchMutationResult {
		this.#assertOpen();
		const now = Date.now();
		try {
			return this.#db
				.transaction((): LaunchMutationResult => {
					const target = this.#db
						.query("SELECT recipient_binding_id, revoked_at FROM launch_grants WHERE grant_id = ?")
						.get(input.grantId) as { recipient_binding_id: string; revoked_at: number | null } | undefined;
					if (!target) {
						return this.#authorityFailure("launch_grant_not_found", `grant '${input.grantId}' not found`);
					}
					const binding = this.#db
						.query(
							"SELECT state, policy_epoch, root_principal_id, parent_principal_id FROM launch_bindings WHERE binding_id = ?",
						)
						.get(target.recipient_binding_id) as
						| {
								state: string;
								policy_epoch: number;
								root_principal_id: string;
								parent_principal_id: string;
						  }
						| undefined;
					if (!binding) {
						return this.#authorityFailure(
							"launch_binding_not_found",
							`binding '${target.recipient_binding_id}' not found`,
						);
					}
					if (binding.policy_epoch !== input.guard.expectedPolicyEpoch) {
						return this.#authorityFailure(
							"stale_launch_authority",
							`binding is at epoch ${binding.policy_epoch}, guard expected ${input.guard.expectedPolicyEpoch}`,
						);
					}
					if (!isLiveLaunchBindingState(binding.state)) {
						return this.#authorityFailure(
							"launch_binding_not_live",
							`binding '${target.recipient_binding_id}' is '${binding.state}', not live`,
						);
					}
					const actorDenied = this.#authenticateActor(input.guard, {
						rootPrincipalId: binding.root_principal_id,
						parentPrincipalId: binding.parent_principal_id,
					});
					if (actorDenied) return actorDenied;
					if (target.revoked_at !== null) return { ok: true };

					// BFS over lineage edges so derived grants fall with their
					// source, in the same transaction.
					const queue = [input.grantId];
					const revoked = new Set<string>();
					while (queue.length > 0) {
						const current = queue.shift() as string;
						if (revoked.has(current)) continue;
						revoked.add(current);
						const grant = this.#db
							.query("SELECT record_digest FROM launch_grants WHERE grant_id = ?")
							.get(current) as { record_digest: string } | undefined;
						if (!grant) {
							return this.#authorityFailure("launch_grant_not_found", `derived grant '${current}' not found`);
						}
						const update = this.#db
							.query("UPDATE launch_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL")
							.run(now, current);
						if (update.changes === 1) {
							this.#db
								.query(
									`INSERT INTO launch_grant_events (event_id, grant_id, kind, actor_principal_id, policy_epoch, reason, record_digest, occurred_at)
									 VALUES (?, ?, 'revoked', ?, ?, ?, ?, ?)`,
								)
								.run(
									`event-${current}-revoked-${now}`,
									current,
									binding.parent_principal_id,
									input.guard.expectedPolicyEpoch,
									input.reason,
									grant.record_digest,
									now,
								);
						}
						const children = (
							this.#db
								.query("SELECT derived_grant_id FROM launch_grant_edges WHERE source_grant_id = ?")
								.all(current) as { derived_grant_id: string }[]
						).map(row => row.derived_grant_id);
						queue.push(...children);
					}
					return { ok: true };
				})
				.immediate();
		} catch (error) {
			return this.#authorityFailure(
				"grant_revocation_failed",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	getLaunchGrant(grantId: string): GrantRecordV1 {
		this.#assertOpen();
		const row = this.#db
			.query("SELECT canonical_json, revoked_at FROM launch_grants WHERE grant_id = ?")
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
						.query(
							`SELECT policy_epoch, state, root_principal_id, parent_principal_id, child_principal_id, attempt_id, contract_revision
							 FROM launch_bindings WHERE binding_id = ?`,
						)
						.get(request.recipientBindingId) as
						| {
								policy_epoch: number;
								state: string;
								root_principal_id: string;
								parent_principal_id: string;
								child_principal_id: string;
								attempt_id: string;
								contract_revision: number;
						  }
						| undefined;
					if (!binding) {
						return this.#authorityFailure(
							"launch_binding_not_found",
							`binding '${request.recipientBindingId}' not found`,
						);
					}
					if (
						binding.policy_epoch !== input.guard.expectedPolicyEpoch ||
						binding.policy_epoch !== request.expectedPolicyEpoch
					) {
						return this.#authorityFailure(
							"stale_launch_authority",
							`binding is at epoch ${binding.policy_epoch}, guard expected ${input.guard.expectedPolicyEpoch} and request expected ${request.expectedPolicyEpoch}`,
						);
					}
					if (!isLiveLaunchBindingState(binding.state)) {
						return this.#authorityFailure(
							binding.state === "revoked" || binding.state === "superseded"
								? "launch_binding_revoked"
								: "launch_binding_not_live",
							`binding '${request.recipientBindingId}' is '${binding.state}', not live`,
						);
					}
					const actorDenied = this.#authenticateActor(input.guard, {
						rootPrincipalId: binding.root_principal_id,
						parentPrincipalId: binding.parent_principal_id,
					});
					if (actorDenied) return actorDenied;
					if (input.senderPrincipalId !== binding.parent_principal_id) {
						return this.#authorityFailure(
							"delivery_sender_mismatch",
							"delivery sender principal does not match the durable recipient binding's parent",
						);
					}
					if (request.attemptId !== binding.attempt_id || request.contractRevision !== binding.contract_revision) {
						return this.#authorityFailure(
							"delivery_binding_mismatch",
							"delivery attempt/revision do not match the durable recipient binding",
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
						.query("SELECT request_digest FROM launch_deliveries WHERE binding_id = ? AND delivery_id = ?")
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
						.query(
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
						.query(
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
						.query(
							"UPDATE launch_channels SET consumed_bytes = consumed_bytes + ?, consumed_messages = consumed_messages + 1, updated_at = ? WHERE binding_id = ? AND channel_id = ?",
						)
						.run(input.bytes, now, request.recipientBindingId, request.channelId);
					this.#db
						.query(
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
						.query(
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
	}): LaunchMutationResult {
		this.#assertOpen();
		try {
			return this.#db
				.transaction((): LaunchMutationResult => {
					const binding = this.#db
						.query(
							"SELECT state, policy_epoch, root_principal_id, parent_principal_id FROM launch_bindings WHERE binding_id = ?",
						)
						.get(input.bindingId) as
						| {
								state: string;
								policy_epoch: number;
								root_principal_id: string;
								parent_principal_id: string;
						  }
						| undefined;
					if (!binding) {
						return this.#authorityFailure("launch_binding_not_found", `binding '${input.bindingId}' not found`);
					}
					if (binding.policy_epoch !== input.guard.expectedPolicyEpoch) {
						return this.#authorityFailure(
							"stale_launch_authority",
							`binding is at epoch ${binding.policy_epoch}, guard expected ${input.guard.expectedPolicyEpoch}`,
						);
					}
					if (!isLiveLaunchBindingState(binding.state)) {
						return this.#authorityFailure(
							"launch_binding_not_live",
							`binding '${input.bindingId}' is '${binding.state}', not live`,
						);
					}
					const actorDenied = this.#authenticateActor(input.guard, {
						rootPrincipalId: binding.root_principal_id,
						parentPrincipalId: binding.parent_principal_id,
					});
					if (actorDenied) return actorDenied;
					const delivery = this.#db
						.query("SELECT 1 AS present FROM launch_deliveries WHERE binding_id = ? AND delivery_id = ?")
						.get(input.bindingId, input.deliveryId) as { present: number } | undefined;
					if (!delivery) {
						return this.#authorityFailure(
							"launch_delivery_not_found",
							`delivery '${input.deliveryId}' is not admitted for binding '${input.bindingId}'`,
						);
					}
					this.#db
						.query(
							`INSERT OR IGNORE INTO launch_delivery_events (event_id, binding_id, delivery_id, kind, request_id, occurred_at)
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
					return { ok: true };
				})
				.immediate();
		} catch (error) {
			return this.#authorityFailure(
				"provider_outcome_failed",
				error instanceof Error ? error.message : String(error),
			);
		}
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
						.query(
							"SELECT binding_id, contract_digest, state, policy_epoch, root_principal_id, parent_principal_id FROM launch_bindings WHERE binding_id = ?",
						)
						.get(input.bindingId) as
						| {
								binding_id: string;
								contract_digest: string;
								state: string;
								policy_epoch: number;
								root_principal_id: string;
								parent_principal_id: string;
						  }
						| undefined;
					if (!row) {
						return this.#authorityFailure("launch_binding_not_found", `binding '${input.bindingId}' not found`);
					}
					// Authenticate the activating actor against the binding's
					// recorded lineage: only the issuer (parent) or the root may
					// move this binding, at the epoch the guard claims.
					const actorDenied = this.#authenticateActor(input.guard, {
						rootPrincipalId: row.root_principal_id,
						parentPrincipalId: row.parent_principal_id,
					});
					if (actorDenied) return actorDenied;
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
						.query("SELECT canonical_json FROM launch_contracts WHERE digest = ?")
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
						.query(
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

					// Read the row back AFTER the state/guarantee write: the
					// returned contract must carry the binding as it now stands
					// (`bound`/`active` with its measured guarantees), not the
					// pre-activation row and never a synthesized identity.
					const activated = this.#db
						.query("SELECT * FROM launch_bindings WHERE binding_id = ?")
						.get(input.bindingId) as Record<string, unknown> | undefined;
					if (!activated) {
						return this.#authorityFailure(
							"launch_binding_not_found",
							`binding '${input.bindingId}' disappeared during activation`,
						);
					}
					return {
						ok: true,
						launch: bindLaunchContract(contract, this.#launchBindingFromRow(activated)),
						replayed: false,
					};
				})
				.immediate();
		} catch (error) {
			return this.#authorityFailure("activation_failed", error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Fenced, idempotent terminalization (§14.5/R12): move a binding out of a
	 * live or `authorized` state into `failed` or `revoked`.
	 *
	 * The transition CASes on the row being non-terminal, bumps
	 * `policy_epoch` so in-process registrations pinned to the old epoch go
	 * stale. Replaying terminalization against an
	 * already-terminal binding returns ok — abort handling must never become
	 * the flakiest path in the system.
	 */
	terminateLaunchBinding(input: {
		readonly guard: LaunchMutationGuard;
		readonly bindingId: string;
		readonly targetState?: "failed" | "revoked";
		readonly reason: string;
	}): LaunchBindingTerminationResult {
		this.#assertOpen();
		const targetState = input.targetState ?? "failed";
		const now = Date.now();
		try {
			return this.#db
				.transaction((): LaunchBindingTerminationResult => {
					const row = this.#db
						.query(
							"SELECT state, policy_epoch, root_principal_id, parent_principal_id FROM launch_bindings WHERE binding_id = ?",
						)
						.get(input.bindingId) as
						| {
								state: LaunchBindingState;
								policy_epoch: number;
								root_principal_id: string;
								parent_principal_id: string;
						  }
						| undefined;
					if (!row) {
						return this.#authorityFailure("launch_binding_not_found", `binding '${input.bindingId}' not found`);
					}
					// Same authentication as activation: only the issuer (parent)
					// or the root may terminalize this binding.
					const actorDenied = this.#authenticateActor(input.guard, {
						rootPrincipalId: row.root_principal_id,
						parentPrincipalId: row.parent_principal_id,
					});
					if (actorDenied) return actorDenied;

					if (
						row.state === "revoked" ||
						row.state === "superseded" ||
						row.state === "failed" ||
						row.state === "terminal"
					) {
						// Already terminal: replay is a no-op, not a conflict.
						return {
							ok: true,
							bindingId: input.bindingId,
							state: row.state,
							policyEpoch: row.policy_epoch,
						};
					}

					const updated = this.#db
						.query(
							`UPDATE launch_bindings SET state = ?, policy_epoch = policy_epoch + 1, updated_at = ?
							 WHERE binding_id = ? AND state NOT IN ('revoked','superseded','failed','terminal')`,
						)
						.run(targetState, now, input.bindingId);
					if (updated.changes !== 1) {
						return this.#authorityFailure(
							"launch_binding_state_conflict",
							`binding '${input.bindingId}' changed state during terminalization`,
						);
					}
					return {
						ok: true,
						bindingId: input.bindingId,
						state: targetState,
						policyEpoch: row.policy_epoch + 1,
					};
				})
				.immediate();
		} catch (error) {
			return this.#authorityFailure("termination_failed", error instanceof Error ? error.message : String(error));
		}
	}

	#authorityFailure(code: string, message: string): LaunchAuthorityFailure {
		return { ok: false, code, diagnostics: [{ code, message, path: "launchAuthority" }] };
	}

	/** Throws rather than returning null: a missing binding is never "no authority yet". */
	getLaunchBinding(bindingId: string): LaunchBinding {
		this.#assertOpen();
		const row = this.#db.query("SELECT * FROM launch_bindings WHERE binding_id = ?").get(bindingId) as
			| Record<string, unknown>
			| undefined;
		if (!row) throw new LifecycleReadError("launch_binding_not_found", `binding '${bindingId}' not found`);
		return this.#launchBindingFromRow(row);
	}

	/**
	 * Additive read for §4.3 resolve-existing: `attempt_id` is UNIQUE, so a
	 * persisted launchAuthority pin (or a v2 native payload) can re-find its
	 * binding without carrying the bindingId. Throws like getLaunchBinding —
	 * a missing binding is never "no authority yet".
	 */
	getLaunchBindingByAttempt(attemptId: string): LaunchBinding {
		this.#assertOpen();
		const row = this.#db.query("SELECT * FROM launch_bindings WHERE attempt_id = ?").get(attemptId) as
			| Record<string, unknown>
			| undefined;
		if (!row)
			throw new LifecycleReadError("launch_binding_not_found", `binding for attempt '${attemptId}' not found`);
		return this.#launchBindingFromRow(row);
	}

	/**
	 * Live children an issuer principal currently holds. `maxChildren` is a
	 * concurrency ceiling, not a lifetime quota, so terminal states
	 * (revoked/superseded/failed/terminal) are excluded — a completed child
	 * must not permanently consume the issuer's fan-out budget.
	 */
	countLiveChildBindings(parentPrincipalId: string): number {
		this.#assertOpen();
		const row = this.#db
			.query(
				"SELECT COUNT(*) AS live FROM launch_bindings WHERE parent_principal_id = ? AND state IN ('authorized','bound','active','suspended')",
			)
			.get(parentPrincipalId) as { live: number } | undefined;
		return row?.live ?? 0;
	}

	#launchBindingFromRow(row: Record<string, unknown>): LaunchBinding {
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
		const row = this.#db.query("SELECT canonical_json FROM launch_contracts WHERE digest = ?").get(digest) as
			| { canonical_json: string }
			| undefined;
		if (!row) throw new LifecycleReadError("launch_contract_not_found", `contract '${digest}' not found`);
		return JSON.parse(row.canonical_json) as CompiledLaunchContract;
	}
}
