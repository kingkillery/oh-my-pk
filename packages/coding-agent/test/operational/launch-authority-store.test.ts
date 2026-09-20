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
import { createTestCompiledContract, createTestRunLimits } from "../helpers/lifecycle-fixtures";

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
