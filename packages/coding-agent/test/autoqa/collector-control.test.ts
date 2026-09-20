/**
 * Collector control plane: mode routing, target resolution, and the local
 * binary lookup contract.
 *
 * Asserts externally observable behavior:
 * 1. `off` resolves no target — reports stay local (the pre-collector default).
 * 2. `remote` resolves the paired URL/token and refuses when either is missing.
 * 3. The env override wins over the setting.
 * 4. `countUnpushedReports` counts only unpushed rows.
 * 5. The binary finder prefers an explicit path and never throws when absent.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	countUnpushedReports,
	findCollectorBinary,
	localCollectorUrl,
	resolveBundledCollectorPath,
	resolveCollectorMode,
	resolveCollectorTarget,
} from "@pk-nerdsaver-ai/pi-coding-agent/autoqa/collector-control";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";

const COLLECTOR_EXE = process.platform === "win32" ? "ompk-collector.exe" : "ompk-collector";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "autoqa-control-"));
	delete process.env.PI_AUTO_QA_COLLECTOR_MODE;
});

afterEach(() => {
	delete process.env.PI_AUTO_QA_COLLECTOR_MODE;
	rmSync(dir, { recursive: true, force: true });
});

function settingsWith(values: Record<string, unknown>): Settings {
	return Settings.isolated(values);
}

describe("resolveCollectorMode", () => {
	it("defaults to off — collection is opt-in", () => {
		expect(resolveCollectorMode(settingsWith({}))).toBe("off");
	});

	it("reads the setting", () => {
		expect(resolveCollectorMode(settingsWith({ "dev.autoqa.collector.mode": "remote" }))).toBe("remote");
		expect(resolveCollectorMode(settingsWith({ "dev.autoqa.collector.mode": "local" }))).toBe("local");
	});

	it("lets the env override win over the setting", () => {
		process.env.PI_AUTO_QA_COLLECTOR_MODE = "local";
		expect(resolveCollectorMode(settingsWith({ "dev.autoqa.collector.mode": "off" }))).toBe("local");
	});

	it("ignores a junk env value rather than crashing", () => {
		process.env.PI_AUTO_QA_COLLECTOR_MODE = "bogus";
		expect(resolveCollectorMode(settingsWith({ "dev.autoqa.collector.mode": "remote" }))).toBe("remote");
	});
});

describe("resolveCollectorTarget", () => {
	it("returns null when off — nothing ships", async () => {
		expect(await resolveCollectorTarget(settingsWith({ "dev.autoqa.collector.mode": "off" }))).toBeNull();
	});

	it("resolves the paired remote URL and token", async () => {
		const target = await resolveCollectorTarget(
			settingsWith({
				"dev.autoqa.collector.mode": "remote",
				"dev.autoqa.collector.remoteUrl": "http://100.1.2.3:8791/v1/grievances",
				"dev.autoqa.collector.remoteToken": "t0ken",
			}),
		);
		expect(target).toEqual({ url: "http://100.1.2.3:8791/v1/grievances", token: "t0ken" });
	});

	it("refuses a remote collector with no URL or no token", async () => {
		expect(await resolveCollectorTarget(settingsWith({ "dev.autoqa.collector.mode": "remote" }))).toBeNull();
		expect(
			await resolveCollectorTarget(
				settingsWith({
					"dev.autoqa.collector.mode": "remote",
					"dev.autoqa.collector.remoteUrl": "http://x/v1/grievances",
				}),
			),
		).toBeNull();
	});
});

describe("localCollectorUrl", () => {
	it("builds the loopback ingest URL from the port", () => {
		expect(localCollectorUrl(8791)).toBe("http://127.0.0.1:8791/v1/grievances");
	});
});

describe("countUnpushedReports", () => {
	it("counts only unpushed rows and tolerates a missing database", () => {
		const dbPath = join(dir, "autoqa.db");
		const db = new Database(dbPath);
		try {
			db.run(
				"CREATE TABLE grievances (id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT, version TEXT, tool TEXT, report TEXT, pushed INTEGER NOT NULL DEFAULT 0)",
			);
			db.run("INSERT INTO grievances (model, version, tool, report, pushed) VALUES ('m','1','read','a',0)");
			db.run("INSERT INTO grievances (model, version, tool, report, pushed) VALUES ('m','1','read','b',0)");
			db.run("INSERT INTO grievances (model, version, tool, report, pushed) VALUES ('m','1','read','c',1)");
		} finally {
			db.close();
		}
		expect(countUnpushedReports(dbPath)).toBe(2);
		expect(countUnpushedReports(join(dir, "absent.db"))).toBe(0);
	});
});

describe("findCollectorBinary", () => {
	it("prefers an explicit path that exists", () => {
		const explicit = join(dir, process.platform === "win32" ? "ompk-collector.exe" : "ompk-collector");
		Bun.write(explicit, "");
		expect(findCollectorBinary(explicit)).toBe(explicit);
	});

	it("prefers the sidecar shipped with this build over PATH", () => {
		const bundled = resolveBundledCollectorPath();
		const resolved = findCollectorBinary();
		if (bundled) {
			// A release install has extracted the sidecar into the per-version
			// native cache; the local collector must use it, not PATH.
			expect(resolved).toBe(bundled);
			expect(resolved).not.toBe(COLLECTOR_EXE);
		} else {
			// No sidecar in this install — fall back to bare-name PATH
			// resolution, verified by spawn failure rather than a file probe.
			expect(resolved).toBe(COLLECTOR_EXE);
		}
	});

	it("ignores a non-existent explicit path", () => {
		const missing = join(dir, "does-not-exist-collector");
		expect(findCollectorBinary(missing)).not.toBe(missing);
	});
});
