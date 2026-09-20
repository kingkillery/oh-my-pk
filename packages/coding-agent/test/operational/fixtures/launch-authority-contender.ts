/**
 * Contender process for the launch-authority contention test.
 *
 * Runs in a SEPARATE Bun process against a shared SQLite file, so the test
 * exercises real cross-process locking rather than sequential calls inside
 * one process (which would share a connection and prove nothing).
 *
 * EVERY outcome — including a crash while opening the store — writes a
 * result file, so the parent can always distinguish "contender reported" from
 * "contender vanished".
 *
 * Usage: bun <this file> <dbPath> <objective> <barrierPath> <slot>
 * Writes its outcome to <dbPath>.result.<slot>.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { OperationalStore } from "../../../src/operational/store";
import { createTestCompiledContract } from "../../helpers/lifecycle-fixtures";

const [dbPath, objective, barrierPath, slot] = process.argv.slice(2);
if (!dbPath || !objective || !barrierPath || !slot) {
	writeFileSync(`${dbPath ?? "contender"}.result.${slot ?? "x"}`, JSON.stringify({ ok: false, code: "bad_args" }));
	process.exit(2);
}

const resultPath = `${dbPath}.result.${slot}`;

// Announce readiness by appending one line to the SHARED ready file, then
// spin on the release barrier. node:fs appendFileSync is used because
// Bun.write in this version silently IGNORES {append:true} and overwrites.
// Readiness is NOT keyed by pid: on Windows the pid the parent observes for
// a spawned process differs from the child's own process.pid.
appendFileSync(`${barrierPath}.ready`, "ready\n");

const deadline = Date.now() + 60_000;
while (!(await Bun.file(barrierPath).exists())) {
	if (Date.now() > deadline) {
		writeFileSync(resultPath, JSON.stringify({ ok: false, code: "barrier_timeout" }));
		process.exit(3);
	}
	await Bun.sleep(2);
}

let store: OperationalStore | undefined;
try {
	// Store opening lives INSIDE the try: a crash here (e.g. temp-file
	// contention under rapid reruns) must still produce a result file.
	store = OperationalStore.open({ dbPath });
	const compiled = createTestCompiledContract({ objective });
	const result = store.admitLaunchAuthority({
		guard: { actor: {} as never, expectedPolicyEpoch: 1, idempotencyKey: "contended-key" },
		compiled,
		reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
		lifecycle: null,
		restoresBindingId: null,
	});
	writeFileSync(
		resultPath,
		JSON.stringify(
			result.ok
				? { ok: true, replayed: result.replayed }
				: { ok: false, code: result.code, detail: result.diagnostics[0]?.message ?? null },
		),
	);
} catch (error) {
	writeFileSync(
		resultPath,
		JSON.stringify({ ok: false, code: error instanceof Error ? error.message : String(error) }),
	);
} finally {
	store?.close();
}
