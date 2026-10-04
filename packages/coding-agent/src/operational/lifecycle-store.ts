/**
 * Durable launch authority, selectively ported from donor 6ab37d338e.
 *
 * This database owns authority only. Legacy operational jobs and their v1
 * schema remain in operational.db; their identifiers are opaque references
 * here. Importing this module never opens either database. The runtime must
 * explicitly opt into opening LifecycleStore.
 */
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils";
import { getLifecycleRegistration } from "../orchestration/lifecycle-authority";
import {
	type ArtifactRefV1,
	type AuthorityEnvelopeV1,
	bindLaunchContract,
	type CompiledLaunchContract,
	canonicalJson,
	compareRuntimeGuarantees,
	compileLaunchAuthority,
	computeLaunchContractDigest,
	isScopeSubsetOfParent,
	type LaunchBinding,
	type LaunchBindingState,
	type LaunchClass,
	parseCompiledLaunchContract,
	parseLaunchBinding,
	type RuntimeGuaranteesV1,
	sha256Hex,
} from "../task/launch-contract";
import type {
	LaunchAuthorityAdmissionInput,
	LaunchAuthorityAdmissionResult,
	LaunchAuthorityFailure,
	LaunchBindingActivationInput,
	LaunchBindingActivationResult,
	LaunchBindingTerminationResult,
	LaunchMutationGuard,
	LaunchPrincipalRow,
} from "./launch-authority-types";

export class LifecycleReadError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "LifecycleReadError";
	}
}

export interface LifecycleStoreOptions {
	/** A dedicated authority file; never point this at operational.db. */
	readonly dbPath?: string;
	readonly durability?: "full" | "normal";
}

const SCHEMA_VERSION = 1;

export class LifecycleStore {
	readonly #db: Database;
	readonly dbPath: string;
	#closed = false;

	private constructor(options: LifecycleStoreOptions) {
		this.dbPath = options.dbPath ?? path.join(getAgentDir(), "lifecycle.db");
		this.#db = new Database(this.dbPath, { create: true });
		try {
			if (
				this.#db
					.query(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schema_version', 'jobs', 'scoped_state')",
					)
					.get()
			) {
				throw new Error(
					"LifecycleStore requires a dedicated database; legacy operational storage cannot be migrated here.",
				);
			}
			this.#db.run("PRAGMA busy_timeout = 5000");
			this.#db.run("PRAGMA journal_mode = WAL");
			this.#db.run(`PRAGMA synchronous = ${options.durability === "normal" ? "NORMAL" : "FULL"}`);
			this.#db.run("PRAGMA foreign_keys = ON");
			this.#initializeSchema();
		} catch (error) {
			this.#db.close();
			throw error;
		}
	}

	static async open(options: LifecycleStoreOptions = {}): Promise<LifecycleStore> {
		const dbPath = options.dbPath ?? path.join(getAgentDir(), "lifecycle.db");
		if (!dbPath.trim()) throw new Error("LifecycleStore database path is required.");
		if (dbPath !== ":memory:") await mkdir(path.dirname(dbPath), { recursive: true });
		for (let attempt = 0; ; attempt++) {
			try {
				return new LifecycleStore({ ...options, dbPath });
			} catch (error) {
				if (attempt >= 7 || !/locked|busy/i.test(String(error))) throw error;
				await Bun.sleep(Math.min(25 * 2 ** attempt, 400));
			}
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		// Never demote WAL: other processes can hold this file concurrently.
		// query() caches prepared statements; close() releases the whole cache.
		this.#db.close();
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("LifecycleStore is closed.");
	}

	#initializeSchema(): void {
		this.#db
			.transaction(() => {
				this.#db.run("CREATE TABLE IF NOT EXISTS lifecycle_schema_version (version INTEGER NOT NULL)");
				const row = this.#db.query("SELECT version FROM lifecycle_schema_version").get() as {
					version: number;
				} | null;
				if (row && row.version !== SCHEMA_VERSION)
					throw new Error(`Unsupported lifecycle schema version ${row.version}`);
				this.#db.run(`CREATE TABLE IF NOT EXISTS launch_principals (
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

CREATE TABLE IF NOT EXISTS launch_admissions (
  parent_principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  binding_id TEXT NOT NULL REFERENCES launch_bindings(binding_id),
  PRIMARY KEY (parent_principal_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS launch_binding_events (
  event_id INTEGER PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES launch_bindings(binding_id),
  kind TEXT NOT NULL CHECK(kind IN ('bound','active','failed','revoked')),
  reason TEXT NOT NULL,
  policy_epoch INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL
);`);
				if (!row) this.#db.query("INSERT INTO lifecycle_schema_version VALUES (?)").run(SCHEMA_VERSION);
			})
			.immediate();
	}

	async admitLaunchAuthority(input: LaunchAuthorityAdmissionInput): Promise<LaunchAuthorityAdmissionResult> {
		this.#assertOpen();
		if (!input.guard.idempotencyKey.trim())
			return this.#authorityFailure("missing_admission_identity", "idempotencyKey is required");
		let compiled: CompiledLaunchContract;
		try {
			const { contractDigest, ...body } = input.compiled;
			if (computeLaunchContractDigest(body) !== contractDigest)
				return this.#authorityFailure("digest_mismatch", "compiled contract digest does not recompute");
			compiled = parseCompiledLaunchContract(JSON.parse(canonicalJson(input.compiled)));
		} catch (error) {
			return this.#authorityFailure("invalid_launch_contract", String(error));
		}
		const guard = { ...input.guard };
		const lifecycle = input.lifecycle ? { ...input.lifecycle } : null;
		const restoresBindingId = input.restoresBindingId;
		if (canonicalJson(input.reservation) !== canonicalJson(compiled.authority.budget.reservation))
			return this.#authorityFailure("inconsistent_reservation", "reservation must match the immutable contract");
		const inputDigest = sha256Hex(
			canonicalJson({ compiled, lifecycle, reservation: input.reservation, restoresBindingId }),
		);
		const attemptId = lifecycle?.attemptId ?? `attempt-${compiled.contractId}-${compiled.contractRevision}`;
		for (let attempt = 0; ; attempt++) {
			this.#assertOpen();
			try {
				return this.#db
					.transaction((): LaunchAuthorityAdmissionResult => {
						const actorDenied = this.#authenticateActor(guard, compiled);
						if (actorDenied) return actorDenied;
						const prior = this.#db
							.query(
								"SELECT input_digest, binding_id FROM launch_admissions WHERE parent_principal_id = ? AND idempotency_key = ?",
							)
							.get(compiled.parentPrincipalId, guard.idempotencyKey) as {
							input_digest: string;
							binding_id: string;
						} | null;
						if (prior) {
							if (prior.input_digest !== inputDigest)
								return this.#authorityFailure(
									"admission_conflict",
									"idempotencyKey is already committed with different inputs",
								);
							return {
								ok: true,
								launch: bindLaunchContract(compiled, this.getLaunchBinding(prior.binding_id)),
								replayed: true,
							};
						}
						const previousAttempt = this.#db
							.query("SELECT binding_id FROM launch_bindings WHERE attempt_id = ?")
							.get(attemptId) as { binding_id: string } | null;
						if (previousAttempt) {
							const binding = this.getLaunchBinding(previousAttempt.binding_id);
							const expectedLifecycle = lifecycle
								? {
										runId: lifecycle.runId,
										nodeId: lifecycle.nodeId,
										ownerNodeId: lifecycle.ownerNodeId,
										jobId: lifecycle.jobId,
										leaseEpoch: lifecycle.leaseEpoch,
										cancellationGeneration: lifecycle.cancellationGeneration,
									}
								: null;
							if (
								binding.contractDigest !== compiled.contractDigest ||
								canonicalJson(binding.lifecycle) !== canonicalJson(expectedLifecycle) ||
								binding.reservationId !== (lifecycle?.reservationId ?? null) ||
								binding.restoresBindingId !== restoresBindingId
							) {
								return this.#authorityFailure(
									"admission_conflict",
									"attempt already has different immutable admission facts",
								);
							}
							this.#db
								.query("INSERT INTO launch_admissions VALUES (?, ?, ?, ?)")
								.run(compiled.parentPrincipalId, guard.idempotencyKey, inputDigest, binding.bindingId);
							return { ok: true, launch: bindLaunchContract(compiled, binding), replayed: true };
						}
						const denied = this.#validateDelegation(guard, compiled);
						if (denied) return denied;
						const admitted = this.#admitLaunchAuthorityRow({
							compiled,
							attemptId,
							policyEpoch: guard.expectedPolicyEpoch,
							lifecycle: lifecycle
								? {
										runId: lifecycle.runId,
										nodeId: lifecycle.nodeId,
										ownerNodeId: lifecycle.ownerNodeId,
										jobId: lifecycle.jobId,
										leaseEpoch: lifecycle.leaseEpoch,
										cancellationGeneration: lifecycle.cancellationGeneration,
									}
								: null,
							reservationId: lifecycle?.reservationId ?? null,
							restoresBindingId,
						});
						if (!admitted.ok) return admitted;
						this.#db
							.query("INSERT INTO launch_admissions VALUES (?, ?, ?, ?)")
							.run(compiled.parentPrincipalId, guard.idempotencyKey, inputDigest, admitted.bindingId);
						return {
							ok: true,
							launch: bindLaunchContract(compiled, this.getLaunchBinding(admitted.bindingId)),
							replayed: admitted.replayed,
						};
					})
					.immediate();
			} catch (error) {
				if (attempt < 7 && /locked|busy/i.test(String(error))) {
					await Bun.sleep(Math.min(25 * 2 ** attempt, 400));
					continue;
				}
				return this.#authorityFailure("admission_failed", String(error));
			}
		}
	}
	/** Re-check the actual host/durable issuer; compiled snapshots are proposals, not authentication. */
	#validateDelegation(guard: LaunchMutationGuard, compiled: CompiledLaunchContract): LaunchAuthorityFailure | null {
		const registration = getLifecycleRegistration(guard.actor);
		const parent = registration?.authority
			? this.getLaunchContract(this.getLaunchBinding(registration.authority.bindingId).contractDigest)
			: null;
		const envelope: AuthorityEnvelopeV1 | undefined =
			registration?.root?.authorityEnvelope ??
			(parent
				? {
						schemaVersion: 1,
						usableCapabilities: parent.authority.usableCapabilities,
						delegableCapabilities: parent.authority.delegableCapabilities,
						resources: parent.authority.resources,
						collaboration: parent.authority.collaboration,
						spawn: parent.authority.spawn,
						budget: parent.authority.budget,
						result: parent.authority.result,
					}
				: undefined);
		if (!envelope) return this.#authorityFailure("unauthenticated_actor", "issuer envelope is unavailable");
		if (!envelope.spawn.maySpawn || envelope.spawn.maxDepth <= 0)
			return this.#authorityFailure("spawn_not_permitted", "issuer may not spawn children");
		if (!envelope.spawn.allowedLaunchClasses.includes(compiled.authority.launchClass))
			return this.#authorityFailure("spawn_launch_class_not_permitted", "child launch class exceeds actual issuer");
		// Delegation does not require the planner to hold invocation rights itself.
		const delegationCeiling = { ...envelope, usableCapabilities: envelope.delegableCapabilities };
		const narrowed = compileLaunchAuthority({
			schemaVersion: 1,
			authorizationRef: compiled.provenance.authorizationRef,
			issuerPrincipalId: compiled.parentPrincipalId,
			rootPrincipalId: compiled.rootPrincipalId,
			parentPrincipalId: compiled.parentPrincipalId,
			childPrincipalId: compiled.childPrincipalId,
			contractId: compiled.contractId,
			contractRevision: compiled.contractRevision,
			priorContractDigest: compiled.priorContractDigest,
			issuerPolicyEpoch: guard.expectedPolicyEpoch,
			entryPoint: "store.admission",
			reason: compiled.provenance.reason,
			requestedAuthority: compiled.authority,
			sourceGrants: [],
			parentDelegable: envelope,
			hostMaximum: delegationCeiling,
			agentMaximum: delegationCeiling,
			workflowMaximum: delegationCeiling,
			toolCatalogDigest: sha256Hex(canonicalJson(envelope.delegableCapabilities)),
		});
		if (!narrowed.ok)
			return {
				ok: false,
				code: narrowed.diagnostics[0]?.code ?? "authority_exceeds_issuer",
				diagnostics: narrowed.diagnostics,
			};
		// Resource, grant and channel issuance belong to a later independently verified slice.
		if (
			compiled.policy.grantRefs.length ||
			compiled.authority.resources.length ||
			compiled.authority.initialDisclosures.length ||
			compiled.authority.deliveryChannels.length
		)
			return this.#authorityFailure(
				"unsupported_launch_authority",
				"resource grants and delivery channels are not supported by this authority-only store",
			);
		if (parent) {
			for (const scope of compiled.capsule.readableScope)
				if (!isScopeSubsetOfParent(scope, parent.capsule.readableScope))
					return this.#authorityFailure("scope_not_proven_subset", "readable scope exceeds durable parent");
			for (const scope of compiled.capsule.writableScope)
				if (!isScopeSubsetOfParent(scope, parent.capsule.writableScope))
					return this.#authorityFailure("scope_not_proven_subset", "writable scope exceeds durable parent");
		}
		for (const operation of ["apply", "allowCommit", "allowPush", "allowMerge"] as const) {
			if (
				(compiled.policy.mutation[operation] || compiled.authority.result.mutation[operation]) &&
				!envelope.result.mutation[operation]
			)
				return this.#authorityFailure("mutation_exceeds_issuer", "child mutation authority exceeds actual issuer");
		}
		if (compiled.authority.result.maxOutputBytes > envelope.result.maxOutputBytes)
			return this.#authorityFailure("result_exceeds_issuer", "child result budget exceeds actual issuer");
		if (envelope.budget.kind === "finite") {
			if (compiled.authority.budget.kind !== "finite")
				return this.#authorityFailure(
					"budget_exceeds_issuer",
					"legacy unlimited budget cannot descend from a finite issuer",
				);
			const bounds = envelope.budget.limits;
			for (const limit of [
				"maxNodes",
				"maxDepth",
				"maxAttemptsPerNode",
				"maxOutstanding",
				"maxActiveCompute",
				"maxRequests",
				"maxRuntimeMs",
				"maxComputeRuntimeMs",
				"maxHandoffBytes",
				"maxInboxEvents",
			] as const) {
				if (
					compiled.policy.limits[limit] > bounds[limit] ||
					compiled.authority.budget.limits[limit] > bounds[limit]
				)
					return this.#authorityFailure("budget_exceeds_issuer", `child ${limit} exceeds actual issuer`);
			}
			for (const limit of ["maxTokens", "maxCostMicrounits"] as const) {
				const maximum = bounds[limit];
				if (
					maximum !== null &&
					(compiled.policy.limits[limit] === null ||
						(compiled.policy.limits[limit] ?? 0) > maximum ||
						compiled.authority.budget.limits[limit] === null ||
						(compiled.authority.budget.limits[limit] ?? 0) > maximum)
				)
					return this.#authorityFailure("budget_exceeds_issuer", `child ${limit} exceeds actual issuer`);
			}
			if (bounds.currency !== compiled.policy.limits.currency)
				return this.#authorityFailure("budget_exceeds_issuer", "child currency differs from finite issuer");
		}
		if (this.countLiveChildBindings(compiled.parentPrincipalId) >= envelope.spawn.maxChildren)
			return this.#authorityFailure("spawn_children_exhausted", "issuer live-child ceiling is exhausted");
		return null;
	}
	/**
	 * Persist the immutable contract, principal lineage and authorized binding.
	 * The admission transaction authenticates and checks replay/capacity first;
	 * this private writer never opens its own transaction or awaits/retries.
	 */
	#admitLaunchAuthorityRow(input: {
		readonly compiled: CompiledLaunchContract;
		readonly attemptId: string;
		readonly policyEpoch: number;
		readonly lifecycle: LaunchBinding["lifecycle"];
		readonly reservationId: string | null;
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
		this.#ensureLaunchPrincipal(compiled.rootPrincipalId, compiled.rootPrincipalId, null, null);
		if (compiled.parentPrincipalId !== compiled.rootPrincipalId) {
			const parentRow = this.#db
				.query(
					`SELECT parent_principal_id, digest FROM launch_contracts
					 WHERE child_principal_id = ? ORDER BY rowid DESC LIMIT 1`,
				)
				.get(compiled.parentPrincipalId) as { parent_principal_id: string; digest: string } | undefined;
			this.#ensureLaunchPrincipal(
				compiled.parentPrincipalId,
				compiled.rootPrincipalId,
				parentRow?.parent_principal_id ?? null,
				parentRow?.digest ?? null,
			);
		}
		this.#ensureLaunchPrincipal(
			compiled.childPrincipalId,
			compiled.rootPrincipalId,
			compiled.parentPrincipalId,
			compiled.contractDigest,
			{ launchClass: compiled.authority.launchClass, policyEpoch: input.policyEpoch },
		);

		const bindingId = `binding-${compiled.contractId}-${compiled.contractRevision}-${attemptId}`;
		this.#db
			.query(
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
				input.policyEpoch,
				input.lifecycle ? JSON.stringify(input.lifecycle) : null,
				input.reservationId,
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
				root.issuerPolicyEpoch !== guard.expectedPolicyEpoch ||
				registration.policyEpoch !== guard.expectedPolicyEpoch
			) {
				return this.#authorityFailure(
					"stale_launch_authority",
					"root issuer registration is pinned to a different epoch",
				);
			}
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
	 * issuer and the new child. No unauthenticated standalone writer is exposed.
	 *
	 * `envelopeRef` is the durable ref backing the principal's authority
	 * envelope — the contract digest for a contract-admitted principal, null
	 * for a lazily stubbed root/issuer row whose envelope is not persisted.
	 */
	#ensureLaunchPrincipal(
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
					const contract = parseCompiledLaunchContract(JSON.parse(contractRow.canonical_json));
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
							"INSERT INTO launch_binding_events (binding_id, kind, reason, policy_epoch, occurred_at) VALUES (?, ?, ?, ?, ?)",
						)
						.run(input.bindingId, nextState, "runtime guarantees validated", row.policy_epoch, now);
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
	 * stale, and records the reason exactly once. Replaying an already-terminal
	 * binding returns its recorded terminal state without another event.
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
							"SELECT state, policy_epoch, root_principal_id, parent_principal_id, reservation_id FROM launch_bindings WHERE binding_id = ?",
						)
						.get(input.bindingId) as
						| {
								state: LaunchBindingState;
								policy_epoch: number;
								root_principal_id: string;
								parent_principal_id: string;
								reservation_id: string | null;
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
					this.#db
						.query(
							"INSERT INTO launch_binding_events (binding_id, kind, reason, policy_epoch, occurred_at) VALUES (?, ?, ?, ?, ?)",
						)
						.run(input.bindingId, targetState, input.reason, row.policy_epoch + 1, now);
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
		return parseLaunchBinding({
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
		return parseCompiledLaunchContract(JSON.parse(row.canonical_json));
	}
}
