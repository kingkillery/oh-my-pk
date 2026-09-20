import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { OperationalStore } from "../../src/operational/store";

describe("Acceptance 22 — rollback", () => {
	it("keeps new-run defaults off while readers serve active records", () => {
		const settings = Settings.isolated({});
		expect(settings.get("task.lifecycle.enabled")).toBe(false);
		expect(settings.get("task.topology")).toBe("legacy");

		const dbPath = path.join(os.tmpdir(), `rollback-${Date.now()}.db`);
		const store = OperationalStore.open({ dbPath });
		try {
			expect(() => store.getLifecycleRunSnapshot("no-such-run")).toThrowError(
				expect.objectContaining({ code: "run_not_found" }),
			);
			expect(store.listPendingHandoffs()).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("blocks a newer unknown database version without writing", () => {
		const dbPath = path.join(os.tmpdir(), `future-db-${Date.now()}.db`);
		const seed = OperationalStore.open({ dbPath });
		expect(() => seed.getLifecycleRunSnapshot("no-such-run")).toThrowError(
			expect.objectContaining({ code: "run_not_found" }),
		);
		seed.close();

		const raw = new Database(dbPath);
		raw.run("UPDATE schema_version SET version = 99");
		raw.close();

		expect(() => OperationalStore.open({ dbPath })).toThrow(/newer than supported/);

		const probe = new Database(dbPath, { readonly: true });
		const version = probe.prepare("SELECT version FROM schema_version").get() as { version: number };
		probe.close();
		expect(version.version).toBe(99);
	});
});
