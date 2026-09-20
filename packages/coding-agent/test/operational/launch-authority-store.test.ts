/**
 * Real-store coverage for the v4 launch-authority migration (§14.5).
 *
 * These use actual temporary SQLite databases. The point is not that the DDL
 * parses — it is that upgrading a populated v3 database preserves its
 * evidence, that a future-version database is refused rather than
 * downgraded, and that the append-only invariants are enforced by the schema
 * rather than only by convention in calling code.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { OperationalStore } from "../../src/operational/store";
import {
	createTestArtifactRef,
	createTestCompiledContract,
	createTestRunLimits,
	createTestRuntimeGuarantees,
} from "../helpers/lifecycle-fixtures";

function tempPath(label: string): string {
	return path.join(os.tmpdir(), `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

const AUTHORITY_TABLES = [
	"launch_principals",
	"launch_contracts",
	"launch_bindings",
	"launch_grants",
	"launch_grant_events",
	"launch_grant_edges",
	"launch_channels",
	"launch_channel_events",
	"launch_deliveries",
	"launch_delivery_events",
	"launch_context_inbox",
	"launch_revisions",
	"launch_releases",
];

describe("v4 launch-authority migration (§14.5)", () => {
	it("creates every authority table on a fresh database", () => {
		const dbPath = tempPath("authority-fresh");
		const store = OperationalStore.open({ dbPath });
		store.close();

		const db = new Database(dbPath, { readonly: true });
		try {
			const present = (
				db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
			).map(r => r.name);
			for (const table of AUTHORITY_TABLES) expect(present).toContain(table);
			const version = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
			expect(version.v).toBe(4);
		} finally {
			db.close();
		}
	});

	it("preserves populated v3 lifecycle evidence when upgrading to v4", () => {
		const dbPath = tempPath("authority-upgrade");

		// Populate through the real store, then force the recorded version
		// back to 3 so reopening exercises the actual 3 -> 4 migration.
		const seeded = OperationalStore.open({ dbPath });
		const created = seeded.createLifecycleRun(
			"run-upgrade",
			createTestCompiledContract(),
			createTestRunLimits(),
			"idem-upgrade",
		);
		expect(created.ok).toBe(true);
		seeded.close();

		const downgrade = new Database(dbPath);
		downgrade.run("DELETE FROM schema_version");
		downgrade.run("INSERT INTO schema_version(version) VALUES (3)");
		downgrade.run(`DROP TABLE IF EXISTS launch_contracts`);
		downgrade.run(`DROP TABLE IF EXISTS launch_bindings`);
		downgrade.close();

		const upgraded = OperationalStore.open({ dbPath });
		try {
			// The pre-existing run survives the migration intact.
			const snapshot = upgraded.getLifecycleRunSnapshot("run-upgrade");
			expect(snapshot.rootNodeId).toBe("run-upgrade-root");
			expect(snapshot.attempts).toHaveLength(1);
		} finally {
			upgraded.close();
		}

		const verify = new Database(dbPath, { readonly: true });
		try {
			const present = (
				verify.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
			).map(r => r.name);
			expect(present).toContain("launch_contracts");
			expect(present).toContain("launch_bindings");
			const version = verify.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
			expect(version.v).toBe(4);
		} finally {
			verify.close();
		}
	});

	it("refuses to open a database from a future schema version", () => {
		const dbPath = tempPath("authority-future");
		const seeded = OperationalStore.open({ dbPath });
		seeded.close();

		const bumped = new Database(dbPath);
		bumped.run("INSERT INTO schema_version(version) VALUES (99)");
		bumped.close();

		// Refusing is the point: silently treating a newer database as v4
		// would let an older binary write rows the newer schema cannot read.
		expect(() => OperationalStore.open({ dbPath })).toThrow(/newer than supported/);
	});

	it("is idempotent across repeated opens", () => {
		const dbPath = tempPath("authority-reopen");
		for (let i = 0; i < 3; i++) {
			const store = OperationalStore.open({ dbPath });
			store.close();
		}
		const db = new Database(dbPath, { readonly: true });
		try {
			const rows = db.prepare("SELECT COUNT(*) AS n FROM schema_version WHERE version = 4").get() as { n: number };
			expect(rows.n).toBe(1);
		} finally {
			db.close();
		}
	});
});

describe("v4 authority schema invariants", () => {
	function openRaw(label: string): { store: OperationalStore; db: Database; dbPath: string } {
		const dbPath = tempPath(label);
		const store = OperationalStore.open({ dbPath });
		store.close();
		return { store, db: new Database(dbPath), dbPath };
	}

	function seedContract(db: Database, digest: string, revision = 1): void {
		db.run(
			`INSERT INTO launch_contracts (contract_id, revision, digest, prior_digest, policy_version, root_principal_id, parent_principal_id, child_principal_id, canonical_json, created_at)
			 VALUES ('contract-1', ?, ?, NULL, 1, 'p-root', 'p-parent', 'p-child', '{}', 1)`,
			[revision, digest],
		);
	}

	function seedBinding(db: Database, bindingId: string, attemptId: string, digest: string): void {
		db.run(
			`INSERT INTO launch_bindings (binding_id, contract_id, contract_revision, contract_digest, root_principal_id, parent_principal_id, child_principal_id, attempt_id, policy_epoch, state, created_at, updated_at)
			 VALUES (?, 'contract-1', 1, ?, 'p-root', 'p-parent', 'p-child', ?, 1, 'authorized', 1, 1)`,
			[bindingId, digest, attemptId],
		);
	}

	it("rejects two contract revisions sharing one digest", () => {
		const { db } = openRaw("authority-digest");
		try {
			seedContract(db, "digest-a", 1);
			// Same bytes under a different revision would make the digest
			// ambiguous as an identity, which fencing depends on.
			expect(() => seedContract(db, "digest-a", 2)).toThrow(/UNIQUE/);
		} finally {
			db.close();
		}
	});

	it("allows only one binding per attempt", () => {
		const { db } = openRaw("authority-attempt");
		try {
			seedContract(db, "digest-b");
			seedBinding(db, "binding-1", "att-1", "digest-b");
			// A second binding on one attempt would mean two live authorities
			// for the same execution unit.
			expect(() => seedBinding(db, "binding-2", "att-1", "digest-b")).toThrow(/UNIQUE/);
		} finally {
			db.close();
		}
	});

	it("rejects an unknown binding state", () => {
		const { db } = openRaw("authority-state");
		try {
			seedContract(db, "digest-c");
			expect(() =>
				db.run(
					`INSERT INTO launch_bindings (binding_id, contract_id, contract_revision, contract_digest, root_principal_id, parent_principal_id, child_principal_id, attempt_id, policy_epoch, state, created_at, updated_at)
					 VALUES ('binding-x', 'contract-1', 1, 'digest-c', 'p-root', 'p-parent', 'p-child', 'att-x', 1, 'probably-fine', 1, 1)`,
				),
			).toThrow(/CHECK/);
		} finally {
			db.close();
		}
	});

	it("rejects an unknown delivery event kind and negative channel budgets", () => {
		const { db } = openRaw("authority-events");
		try {
			expect(() =>
				db.run(
					`INSERT INTO launch_delivery_events (event_id, binding_id, delivery_id, kind, occurred_at)
					 VALUES ('e1', 'b1', 'd1', 'sort-of-delivered', 1)`,
				),
			).toThrow(/CHECK/);

			seedContract(db, "digest-d");
			seedBinding(db, "binding-d", "att-d", "digest-d");
			// A negative consumed count would let a channel refund itself past
			// its own budget.
			expect(() =>
				db.run(
					`INSERT INTO launch_channels (binding_id, channel_id, canonical_json, policy_epoch, consumed_bytes, consumed_messages, created_at, updated_at)
					 VALUES ('binding-d', 'c1', '{}', 1, -1, 0, 1, 1)`,
				),
			).toThrow(/CHECK/);
		} finally {
			db.close();
		}
	});

	it("admits one inbox row per delivery within a context generation", () => {
		const { db } = openRaw("authority-inbox");
		try {
			seedContract(db, "digest-e");
			seedBinding(db, "binding-e", "att-e", "digest-e");
			const insert = `INSERT INTO launch_context_inbox (binding_id, context_generation, delivery_id, admission_order, content_ref, domains_json, admitted_epoch, admitted_at)
				 VALUES ('binding-e', 0, 'delivery-1', 1, 'artifact://x', '[]', 1, 1)`;
			db.run(insert);
			// Re-admitting the same delivery must not double-count it.
			expect(() => db.run(insert)).toThrow(/UNIQUE|constraint/i);

			// The same delivery in a NEW context generation is a distinct
			// admission and is allowed.
			db.run(
				`INSERT INTO launch_context_inbox (binding_id, context_generation, delivery_id, admission_order, content_ref, domains_json, admitted_epoch, admitted_at)
				 VALUES ('binding-e', 1, 'delivery-1', 1, 'artifact://x', '[]', 1, 1)`,
			);
			const count = db.prepare("SELECT COUNT(*) AS n FROM launch_context_inbox").get() as { n: number };
			expect(count.n).toBe(2);
		} finally {
			db.close();
		}
	});

	it("enforces one committed result per revision idempotency key and input digest", () => {
		const { db } = openRaw("authority-revision");
		try {
			const insert = (digest: string) =>
				db.run(
					`INSERT INTO launch_revisions (revision_event_id, binding_id, prior_contract_digest, new_contract_digest, actor_principal_id, delta_json, reason, policy_epoch, idempotency_key, input_digest, occurred_at)
					 VALUES (?, 'binding-1', 'old', 'new', 'p-parent', '{}', 'widen', 1, 'key-1', ?, 1)`,
					[`rev-${digest}`, digest],
				);
			insert("input-a");
			expect(() => insert("input-a")).toThrow(/UNIQUE|constraint/i);
			// A different input under the same key is a genuine conflict the
			// caller must resolve, not a silent second commit of the same one.
			insert("input-b");
			const count = db.prepare("SELECT COUNT(*) AS n FROM launch_revisions").get() as { n: number };
			expect(count.n).toBe(2);
		} finally {
			db.close();
		}
	});
});

describe("launch authority commit protocol (§14.5)", () => {
	function openStore(label: string): OperationalStore {
		return OperationalStore.open({ dbPath: tempPath(label) });
	}

	const GUARD = { actor: {} as never, expectedPolicyEpoch: 1, idempotencyKey: "idem-1" };

	function admit(store: OperationalStore, compiled = createTestCompiledContract()) {
		return store.admitLaunchAuthority({
			guard: GUARD,
			compiled,
			reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
			lifecycle: null,
			restoresBindingId: null,
		});
	}

	it("commits authority as authorized, not live", () => {
		const store = openStore("protocol-admit");
		try {
			const compiled = createTestCompiledContract();
			const result = admit(store, compiled);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.replayed).toBe(false);

			// Authorization commit must not produce a live child: the binding
			// carries no measured guarantees until activation probes them.
			const bindingId = `binding-${compiled.contractId}-${compiled.contractRevision}-attempt-${compiled.contractId}-${compiled.contractRevision}`;
			const binding = store.getLaunchBinding(bindingId);
			expect(binding.state).toBe("authorized");
			expect(binding.actualRuntimeGuarantees).toBeNull();
			expect(binding.guaranteeEvidenceRefs).toEqual([]);

			expect(store.getLaunchContract(compiled.contractDigest).contractDigest).toBe(compiled.contractDigest);
		} finally {
			store.close();
		}
	});

	it("replays an identical admission instead of allocating twice", () => {
		const store = openStore("protocol-replay");
		try {
			const compiled = createTestCompiledContract();
			expect(admit(store, compiled).ok).toBe(true);
			const second = admit(store, compiled);
			expect(second.ok).toBe(true);
			if (!second.ok) return;
			expect(second.replayed).toBe(true);
		} finally {
			store.close();
		}
	});

	it("rejects a different contract on an attempt that is already bound", () => {
		const store = openStore("protocol-conflict");
		try {
			const first = createTestCompiledContract({ objective: "first mission" });
			expect(admit(store, first).ok).toBe(true);

			// Same derived attempt id, different contract bytes: a real
			// conflict, never a silent rebind.
			const second = createTestCompiledContract({ objective: "second mission" });
			const result = admit(store, second);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("admission_conflict");
		} finally {
			store.close();
		}
	});

	it("refuses activation when measured guarantees fall short of the contract", () => {
		const store = openStore("protocol-shortfall");
		try {
			const compiled = createTestCompiledContract();
			expect(admit(store, compiled).ok).toBe(true);
			const bindingId = `binding-${compiled.contractId}-${compiled.contractRevision}-attempt-${compiled.contractId}-${compiled.contractRevision}`;

			const result = store.activateLaunchBinding({
				guard: GUARD,
				bindingId,
				expectedState: "authorized",
				sessionId: "session-1",
				processRef: null,
				serviceBindings: [],
				// Ambient everywhere: cannot satisfy the strict requirements.
				actualRuntimeGuarantees: {
					initialContext: "legacy-inherited",
					transcriptAccess: "ambient",
					serviceAccess: "ambient",
					artifactAccess: "ambient",
					memoryAccess: "ambient",
					evalState: "ambient",
					filesystemRead: "ambient",
					filesystemWrite: "ambient",
					process: "ambient",
					network: "ambient",
					credentials: "ambient",
				},
				guaranteeEvidenceRefs: [createTestArtifactRef("artifact-probe")],
			});
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("required_isolation_unavailable");
			expect(result.diagnostics.length).toBeGreaterThan(1);

			// The binding must remain unactivated after a refused probe.
			expect(store.getLaunchBinding(bindingId).state).toBe("authorized");
		} finally {
			store.close();
		}
	});

	it("activates when guarantees are met and evidence is supplied", () => {
		const store = openStore("protocol-activate");
		try {
			const compiled = createTestCompiledContract();
			expect(admit(store, compiled).ok).toBe(true);
			const bindingId = `binding-${compiled.contractId}-${compiled.contractRevision}-attempt-${compiled.contractId}-${compiled.contractRevision}`;
			const activation = {
				guard: GUARD,
				bindingId,
				expectedState: "authorized" as const,
				sessionId: "session-1",
				processRef: null,
				serviceBindings: [],
				actualRuntimeGuarantees: createTestRuntimeGuarantees(),
				guaranteeEvidenceRefs: [createTestArtifactRef("artifact-probe")],
			};
			expect(store.activateLaunchBinding(activation).ok).toBe(true);
			const bound = store.getLaunchBinding(bindingId);
			expect(bound.state).toBe("bound");
			expect(bound.actualRuntimeGuarantees).not.toBeNull();
			expect(bound.sessionId).toBe("session-1");

			// Re-running the same authorized->bound transition must now fail
			// the state CAS rather than silently repeating.
			const repeat = store.activateLaunchBinding(activation);
			expect(repeat.ok).toBe(false);
			if (repeat.ok) return;
			expect(repeat.code).toBe("launch_binding_state_conflict");

			expect(store.activateLaunchBinding({ ...activation, expectedState: "bound" }).ok).toBe(true);
			expect(store.getLaunchBinding(bindingId).state).toBe("active");
		} finally {
			store.close();
		}
	});

	it("refuses activation without guarantee evidence", () => {
		const store = openStore("protocol-evidence");
		try {
			const compiled = createTestCompiledContract();
			expect(admit(store, compiled).ok).toBe(true);
			const bindingId = `binding-${compiled.contractId}-${compiled.contractRevision}-attempt-${compiled.contractId}-${compiled.contractRevision}`;
			const result = store.activateLaunchBinding({
				guard: GUARD,
				bindingId,
				expectedState: "authorized",
				sessionId: "session-1",
				processRef: null,
				serviceBindings: [],
				actualRuntimeGuarantees: createTestRuntimeGuarantees(),
				guaranteeEvidenceRefs: [],
			});
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("guarantee_evidence_required");
		} finally {
			store.close();
		}
	});

	it("refuses activation under a stale policy epoch", () => {
		const store = openStore("protocol-stale");
		try {
			const compiled = createTestCompiledContract();
			expect(admit(store, compiled).ok).toBe(true);
			const bindingId = `binding-${compiled.contractId}-${compiled.contractRevision}-attempt-${compiled.contractId}-${compiled.contractRevision}`;
			const result = store.activateLaunchBinding({
				guard: { actor: {} as never, expectedPolicyEpoch: 99, idempotencyKey: "idem-1" },
				bindingId,
				expectedState: "authorized",
				sessionId: "session-1",
				processRef: null,
				serviceBindings: [],
				actualRuntimeGuarantees: createTestRuntimeGuarantees(),
				guaranteeEvidenceRefs: [createTestArtifactRef("artifact-probe")],
			});
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("stale_launch_authority");
		} finally {
			store.close();
		}
	});

	it("throws typed read errors for unknown bindings and contracts", () => {
		const store = openStore("protocol-missing");
		try {
			expect(() => store.getLaunchBinding("nope")).toThrowError(
				expect.objectContaining({ code: "launch_binding_not_found" }),
			);
			expect(() => store.getLaunchContract("nope")).toThrowError(
				expect.objectContaining({ code: "launch_contract_not_found" }),
			);
		} finally {
			store.close();
		}
	});
});

describe("launch grant lifecycle (§14.5)", () => {
	const GUARD = { actor: {} as never, expectedPolicyEpoch: 1, idempotencyKey: "guard-1" };

	/** A grant must attach to a real binding; the schema enforces this. */
	function admitBinding(store: OperationalStore, objective: string): string {
		const admitted = store.admitLaunchAuthority({
			guard: GUARD,
			compiled: createTestCompiledContract({ objective }),
			reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
			lifecycle: null,
			restoresBindingId: null,
		});
		if (!admitted.ok) throw new Error(`binding fixture failed: ${admitted.code}`);
		// In the authority-only path the envelope's attempt id carries the
		// binding identity.
		return admitted.launch.envelope.attemptId;
	}

	function grantRequest(overrides: Partial<Parameters<OperationalStore["appendLaunchGrant"]>[0]["request"]> = {}) {
		return {
			idempotencyKey: "grant-key-1",
			issuerPrincipalId: "principal-parent",
			recipientPrincipalId: "principal-child",
			recipientBindingId: "binding-1",
			resource: {
				kind: "workspace" as const,
				resourceId: "repo:main",
				versionDigest: null,
				scope: { roots: ["src/"], exactIds: [], maxBytes: null, range: null },
			},
			operations: ["read" as const],
			delegableOperations: ["read" as const],
			recipientConstraints: [],
			remainingDelegationDepth: 2,
			domains: ["public-task" as const],
			sourceGrantIds: [],
			contractRevision: 1,
			attemptId: "att-1",
			expiresAt: null,
			purpose: "read the worker's own source scope",
			...overrides,
		};
	}

	it("issues a grant and reads it back through the strict parser", () => {
		const store = OperationalStore.open({ dbPath: tempPath("grant-issue") });
		try {
			const bindingId = admitBinding(store, "Grant issue fixture");
			const issued = store.appendLaunchGrant({
				guard: GUARD,
				request: grantRequest({ recipientBindingId: bindingId }),
			});
			expect(issued.ok).toBe(true);
			if (!issued.ok) return;

			// The persisted canonical JSON must satisfy parseGrantRecordV1;
			// an issuer/recipient stub or malformed field would throw here.
			const read = store.getLaunchGrant(issued.grant.grantId);
			expect(read.issuerPrincipalId).toBe("principal-parent");
			expect(read.recipientPrincipalId).toBe("principal-child");
			expect(read.remainingDelegationDepth).toBe(2);
			expect(read.recordDigest).toBe(issued.grant.recordDigest);
		} finally {
			store.close();
		}
	});

	it("replays identical content and refuses different content under the same key", () => {
		const store = OperationalStore.open({ dbPath: tempPath("grant-idem") });
		try {
			const bindingId = admitBinding(store, "Grant idempotency fixture");
			const first = store.appendLaunchGrant({
				guard: GUARD,
				request: grantRequest({ recipientBindingId: bindingId }),
			});
			expect(first.ok).toBe(true);

			const replay = store.appendLaunchGrant({
				guard: GUARD,
				request: grantRequest({ recipientBindingId: bindingId }),
			});
			expect(replay.ok).toBe(true);
			if (!replay.ok || !first.ok) return;
			expect(replay.grant.grantId).toBe(first.grant.grantId);
			expect(replay.grant.recordDigest).toBe(first.grant.recordDigest);
			const conflict = store.appendLaunchGrant({
				guard: GUARD,
				request: grantRequest({
					recipientBindingId: bindingId,
					purpose: "different purpose, same key",
				}),
			});
			expect(conflict.ok).toBe(false);
			if (conflict.ok) return;
			expect(conflict.code).toBe("grant_issue_failed");
			expect(conflict.diagnostics[0]?.message).toMatch(/grant_conflict/);
		} finally {
			store.close();
		}
	});

	it("refuses to derive from a nonexistent or revoked source grant", () => {
		const store = OperationalStore.open({ dbPath: tempPath("grant-source") });
		try {
			const bindingId = admitBinding(store, "Grant source fixture");
			const missing = store.appendLaunchGrant({
				guard: GUARD,
				request: grantRequest({ recipientBindingId: bindingId, sourceGrantIds: ["grant-nonexistent"] }),
			});
			expect(missing.ok).toBe(false);
			if (!missing.ok) expect(missing.diagnostics[0]?.message).toMatch(/grant_source_not_found/);

			const root = store.appendLaunchGrant({
				guard: GUARD,
				request: grantRequest({ recipientBindingId: bindingId, idempotencyKey: "root-key" }),
			});
			expect(root.ok).toBe(true);
			if (!root.ok) return;
			store.revokeLaunchGrant({ guard: GUARD, grantId: root.grant.grantId, reason: "operator revoked" });

			const derived = store.appendLaunchGrant({
				guard: GUARD,
				request: grantRequest({
					recipientBindingId: bindingId,
					idempotencyKey: "derived-key",
					sourceGrantIds: [root.grant.grantId],
				}),
			});
			expect(derived.ok).toBe(false);
			if (!derived.ok) expect(derived.diagnostics[0]?.message).toMatch(/grant_source_revoked/);
		} finally {
			store.close();
		}
	});

	it("narrows delegation depth at each derivation and refuses non-narrowing requests", () => {
		const store = OperationalStore.open({ dbPath: tempPath("grant-depth") });
		try {
			const bindingId = admitBinding(store, "Grant depth fixture");
			const root = store.appendLaunchGrant({
				guard: GUARD,
				request: grantRequest({
					recipientBindingId: bindingId,
					idempotencyKey: "root-2",
					remainingDelegationDepth: 2,
				}),
			});
			expect(root.ok).toBe(true);
			if (!root.ok) return;

			const child = store.appendLaunchGrant({
				guard: GUARD,
				request: grantRequest({
					recipientBindingId: bindingId,
					idempotencyKey: "child-1",
					sourceGrantIds: [root.grant.grantId],
					remainingDelegationDepth: 1,
				}),
			});
			expect(child.ok).toBe(true);

			// Requesting the SAME depth as the source would let a chain hold
			// its parent's depth forever.
			const notNarrower = store.appendLaunchGrant({
				guard: GUARD,
				request: grantRequest({
					recipientBindingId: bindingId,
					idempotencyKey: "child-2",
					sourceGrantIds: [root.grant.grantId],
					remainingDelegationDepth: 2,
				}),
			});
			expect(notNarrower.ok).toBe(false);
			if (!notNarrower.ok) {
				expect(notNarrower.diagnostics[0]?.message).toMatch(/delegation_depth_exceeded/);
			}
		} finally {
			store.close();
		}
	});

	it("revokes derived grants transitively in one transaction", () => {
		const store = OperationalStore.open({ dbPath: tempPath("grant-revoke") });
		try {
			const bindingId = admitBinding(store, "Grant revoke fixture");
			const root = store.appendLaunchGrant({
				guard: GUARD,
				request: grantRequest({
					recipientBindingId: bindingId,
					idempotencyKey: "rev-root",
					remainingDelegationDepth: 3,
				}),
			});
			const mid = store.appendLaunchGrant({
				guard: GUARD,
				request: grantRequest({
					recipientBindingId: bindingId,
					idempotencyKey: "rev-mid",
					sourceGrantIds: [root.ok ? root.grant.grantId : "unreachable"],
					remainingDelegationDepth: 2,
				}),
			});
			const leaf = store.appendLaunchGrant({
				guard: GUARD,
				request: grantRequest({
					recipientBindingId: bindingId,
					idempotencyKey: "rev-leaf",
					sourceGrantIds: [mid.ok ? mid.grant.grantId : "unreachable"],
					remainingDelegationDepth: 1,
					delegableOperations: [],
				}),
			});
			expect([root.ok, mid.ok, leaf.ok]).toEqual([true, true, true]);
			if (!root.ok || !mid.ok) return;

			store.revokeLaunchGrant({ guard: GUARD, grantId: root.grant.grantId, reason: "root revoked" });

			// Revoking the ROOT must close the whole chain: a revoked source
			// must not keep authorising through its children.
			const deriveAfterRevoke = store.appendLaunchGrant({
				guard: GUARD,
				request: grantRequest({
					recipientBindingId: bindingId,
					idempotencyKey: "after-revoke",
					sourceGrantIds: [mid.grant.grantId],
					remainingDelegationDepth: 1,
				}),
			});
			expect(deriveAfterRevoke.ok).toBe(false);
			if (!deriveAfterRevoke.ok) {
				expect(deriveAfterRevoke.diagnostics[0]?.message).toMatch(/grant_source_revoked/);
			}

			// Double revocation is a no-op, not an error.
			store.revokeLaunchGrant({ guard: GUARD, grantId: root.grant.grantId, reason: "again" });
		} finally {
			store.close();
		}
	});

	it("throws a typed read error for an unknown grant", () => {
		const store = OperationalStore.open({ dbPath: tempPath("grant-missing") });
		try {
			expect(() => store.getLaunchGrant("nope")).toThrowError(
				expect.objectContaining({ code: "launch_grant_not_found" }),
			);
		} finally {
			store.close();
		}
	});
});

describe("launch delivery admission (§14.5)", () => {
	const GUARD = { actor: {} as never, expectedPolicyEpoch: 1, idempotencyKey: "guard-1" };

	function seedChannelFixture(label: string, maxMessageBytes = 2000, maxTotalBytes = 4000, maxMessages = 2) {
		const store = OperationalStore.open({ dbPath: tempPath(label) });
		const admitted = store.admitLaunchAuthority({
			guard: GUARD,
			compiled: createTestCompiledContract({ objective: `Delivery fixture ${label}` }),
			reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
			lifecycle: null,
			restoresBindingId: null,
		});
		if (!admitted.ok) throw new Error(`fixture failed: ${admitted.code}`);
		const bindingId = admitted.launch.envelope.attemptId;
		return { store, bindingId, limits: { maxMessageBytes, maxTotalBytes, maxMessages } };
	}

	function deliveryRequest(bindingId: string, deliveryId: string, overrides: Record<string, unknown> = {}) {
		return {
			deliveryId,
			channelId: "chan-1",
			recipientBindingId: bindingId,
			expectedPolicyEpoch: 1,
			attemptId: "att-d",
			contractRevision: 1,
			contextGeneration: 0,
			grantRefs: [],
			payloadRef: createTestArtifactRef("artifact-payload"),
			resourceRefs: [],
			domains: ["public-task" as const],
			kind: "assignment" as const,
			...overrides,
		};
	}

	function admitDelivery(
		store: OperationalStore,
		bindingId: string,
		deliveryId: string,
		bytes: number,
		limits: { maxMessageBytes: number; maxTotalBytes: number; maxMessages: number },
		overrides: Record<string, unknown> = {},
	) {
		// Seed the pinned channel row directly: channel pinning belongs to the
		// compiler's initial-channel generation (W3); here we exercise the
		// admission transaction against its recorded limits.
		const channelId = (overrides.channelId as string | undefined) ?? "chan-1";
		const db = new Database(store.dbPath);
		db.run(
			`INSERT OR IGNORE INTO launch_channels (binding_id, channel_id, canonical_json, policy_epoch, created_at, updated_at)
			 VALUES (?, ?, ?, 1, 1, 1)`,
			[bindingId, channelId, JSON.stringify(limits)],
		);
		db.close();
		return store.admitLaunchDelivery({
			guard: GUARD,
			request: deliveryRequest(bindingId, deliveryId, { channelId, ...overrides }),
			senderPrincipalId: "principal-parent",
			bytes,
		});
	}

	it("admits a delivery once and consumes channel budget exactly once", () => {
		const { store, bindingId, limits } = seedChannelFixture("delivery-admit");
		try {
			const first = admitDelivery(store, bindingId, "d-1", 500, limits);
			expect(first.ok).toBe(true);
			if (!first.ok) return;
			expect(first.replayed).toBe(false);
			expect(first.delivery.recipientPrincipalId).toBeTruthy();

			// Same content again: replay, NOT a second debit.
			const replay = admitDelivery(store, bindingId, "d-1", 500, limits);
			expect(replay.ok).toBe(true);
			if (!replay.ok) return;
			expect(replay.replayed).toBe(true);

			const db = new Database(store.dbPath, { readonly: true });
			const channel = db
				.prepare("SELECT consumed_bytes, consumed_messages FROM launch_channels WHERE channel_id = 'chan-1'")
				.get() as { consumed_bytes: number; consumed_messages: number };
			const inbox = db.prepare("SELECT COUNT(*) AS n FROM launch_context_inbox WHERE delivery_id = 'd-1'").get() as {
				n: number;
			};
			db.close();
			expect(channel.consumed_bytes).toBe(500);
			expect(channel.consumed_messages).toBe(1);
			expect(inbox.n).toBe(1);
		} finally {
			store.close();
		}
	});

	it("rejects different content under the same delivery id", () => {
		const { store, bindingId, limits } = seedChannelFixture("delivery-conflict");
		try {
			expect(admitDelivery(store, bindingId, "d-1", 500, limits).ok).toBe(true);
			const conflict = admitDelivery(store, bindingId, "d-1", 500, limits, {
				kind: "plan-excerpt",
			});
			expect(conflict.ok).toBe(false);
			if (conflict.ok) return;
			expect(conflict.code).toBe("delivery_conflict");
		} finally {
			store.close();
		}
	});

	it("enforces per-message and total byte bounds and the message count", () => {
		const { store, bindingId, limits } = seedChannelFixture("delivery-budget");
		try {
			const tooLarge = admitDelivery(store, bindingId, "d-big", 5000, limits);
			expect(tooLarge.ok).toBe(false);
			if (!tooLarge.ok) expect(tooLarge.code).toBe("delivery_too_large");

			// maxMessages = 2: two admissions fit, the third is refused.
			expect(admitDelivery(store, bindingId, "d-1", 1000, limits).ok).toBe(true);
			expect(admitDelivery(store, bindingId, "d-2", 1000, limits).ok).toBe(true);
			const exhausted = admitDelivery(store, bindingId, "d-3", 100, limits);
			expect(exhausted.ok).toBe(false);
			if (!exhausted.ok) expect(exhausted.code).toBe("delivery_budget_exhausted");

			// Total bytes: a SEPARATE channel (chan-2) with a 3000-byte
			// message bound but only a 1000-byte total. The 2500-byte message
			// fits per-message yet still exceeds the total. A second channel
			// is needed because chan-1's limits are already pinned.
			const totalRefused = admitDelivery(
				store,
				bindingId,
				"d-wide",
				2500,
				{ maxMessageBytes: 3000, maxTotalBytes: 1000, maxMessages: 5 },
				{ channelId: "chan-2" },
			);
			expect(totalRefused.ok).toBe(false);
			if (!totalRefused.ok) expect(totalRefused.code).toBe("delivery_budget_exhausted");
		} finally {
			store.close();
		}
	});

	it("refuses a delivery to a revoked or unknown binding", () => {
		const { store, bindingId, limits } = seedChannelFixture("delivery-revoked");
		try {
			const unknown = admitDelivery(store, "binding-none", "d-1", 100, limits);
			expect(unknown.ok).toBe(false);
			if (!unknown.ok) expect(unknown.code).toBe("launch_binding_not_found");

			const db = new Database(store.dbPath);
			db.run("UPDATE launch_bindings SET state = 'revoked' WHERE binding_id = ?", [bindingId]);
			db.close();
			const revoked = admitDelivery(store, bindingId, "d-1", 100, limits);
			expect(revoked.ok).toBe(false);
			if (!revoked.ok) expect(revoked.code).toBe("launch_binding_revoked");
		} finally {
			store.close();
		}
	});

	it("records a provider-unknown outcome without refunding the channel", () => {
		const { store, bindingId, limits } = seedChannelFixture("delivery-provider");
		try {
			expect(admitDelivery(store, bindingId, "d-1", 500, limits).ok).toBe(true);
			// A provider timeout must not undo the admission or the debit.
			store.recordLaunchProviderOutcome({
				guard: GUARD,
				bindingId,
				deliveryId: "d-1",
				requestId: "req-77",
				outcome: "provider-unknown",
			});
			const db = new Database(store.dbPath, { readonly: true });
			const events = db
				.prepare("SELECT kind FROM launch_delivery_events WHERE delivery_id = 'd-1' ORDER BY occurred_at")
				.all() as { kind: string }[];
			const channel = db.prepare("SELECT consumed_bytes FROM launch_channels WHERE channel_id = 'chan-1'").get() as {
				consumed_bytes: number;
			};
			db.close();
			expect(events.map(e => e.kind)).toEqual(["admitted", "provider-unknown"]);
			expect(channel.consumed_bytes).toBe(500);
		} finally {
			store.close();
		}
	});
});

describe("launch authority under cross-process contention (§14.5)", () => {
	// The race runs in a STANDALONE runner rather than inside bun test:
	// contender children spawned directly from the test process stalled
	// before signalling readiness on this host, while the identical spawn
	// works standalone and as a grandchild of bun test. The runner performs
	// the readiness barrier itself and asserts the full contract, so this
	// suite asserts its summary rather than merely its exit code.
	const RACE_RUNNER = path.join(import.meta.dir, "fixtures", "launch-authority-race.ts");

	async function runRace(kind: "same" | "clash") {
		const proc = Bun.spawn(["bun", RACE_RUNNER, kind], { stdout: "pipe", stderr: "pipe" });
		const out = (await new Response(proc.stdout).text()).trim();
		const err = (await new Response(proc.stderr).text()).trim();
		const code = await proc.exited;
		if (code !== 0) throw new Error(`race runner exited ${code}: ${err}`);
		return JSON.parse(out.split("\n").filter(Boolean).pop() ?? "{}") as {
			kind: string;
			ok: number;
			allocations: number;
			replays: number;
			conflicts: number;
		};
	}

	it("admits one authority exactly once when four processes race the same contract", async () => {
		const summary = await runRace("same");
		// Identical contracts: all four succeed, exactly one performed the
		// allocation, and the rest observed a replay — never a second binding
		// for the same attempt.
		expect(summary.ok).toBe(4);
		expect(summary.allocations).toBe(1);
		expect(summary.replays).toBe(3);
	}, 90_000);

	it("lets exactly one of four conflicting contracts win the attempt", async () => {
		const summary = await runRace("clash");
		// Distinct contracts derive the same attempt id, so exactly one may
		// bind it and the others must be refused admission_conflict rather
		// than overwriting each other's authority.
		expect(summary.allocations).toBe(1);
		expect(summary.conflicts).toBe(3);
	}, 90_000);
});
