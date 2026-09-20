/**
 * Contender process for the launch-authority contention test.
 *
 * Runs in a SEPARATE Bun process against a shared SQLite file, so the test
 * exercises real cross-process locking rather than sequential calls inside
 * one process (which would share a connection and prove nothing).
 *
 * Usage: bun <this file> <dbPath> <objective> <barrierPath>
 * Prints one JSON line: {"ok":boolean,"replayed"?:boolean,"code"?:string}
 */

import { OperationalStore } from "../../../src/operational/store";
import { createTestCompiledContract } from "../../helpers/lifecycle-fixtures";

const [dbPath, objective, barrierPath] = process.argv.slice(2);
if (!dbPath || !objective || !barrierPath) {
	console.log(JSON.stringify({ ok: false, code: "bad_args" }));
	process.exit(2);
}

// Announce readiness by appending one line to the SHARED ready file, then
// spin on the release barrier. node:fs appendFileSync is used because
// Bun.write in this version silently IGNORES {append:true} and overwrites,
// which would keep the file at one line forever. Readiness is NOT keyed by
// pid: on Windows the pid the parent observes for a spawned process differs
// from the child's own process.pid.
import { appendFileSync } from "node:fs";

appendFileSync(`${barrierPath}.ready`, "ready\n");

const deadline = Date.now() + 60_000;
while (!(await Bun.file(barrierPath).exists())) {
	if (Date.now() > deadline) {
		console.log(JSON.stringify({ ok: false, code: "barrier_timeout" }));
		process.exit(3);
	}
	await Bun.sleep(2);
}
const compiled = createTestCompiledContract({ objective });
const store = OperationalStore.open({ dbPath });
try {
	const result = store.admitLaunchAuthority({
		guard: { actor: {} as never, expectedPolicyEpoch: 1, idempotencyKey: "contended-key" },
		compiled,
		reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
		lifecycle: null,
		restoresBindingId: null,
	});
	console.log(
		JSON.stringify(
			result.ok
				? { ok: true, replayed: result.replayed }
				: { ok: false, code: result.code, detail: result.diagnostics[0]?.message ?? null },
		),
	);
} catch (error) {
	console.log(JSON.stringify({ ok: false, code: error instanceof Error ? error.message : String(error) }));
} finally {
	store.close();
}
