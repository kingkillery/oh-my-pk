/**
 * Standalone cross-process contention runner (§14.5).
 *
 * Performs the race OUTSIDE the bun test runner, because spawning contender
 * children from inside `bun test` proved unreliable on this host (children
 * stalled before signalling readiness; the same spawn works standalone and
 * as a grandchild of bun test). The bun-test cases assert this runner's
 * reported summary, so the contract below is still fully asserted:
 *
 *   same    → 4 ok, exactly 1 allocation, 3 replays
 *   clash   → exactly 1 allocation, 3 admission_conflict refusals
 *
 * Usage: bun launch-authority-race.ts <same|clash>
 * Prints JSON: {"kind":..., "allocations":n, "replays":n, "conflicts":n, "ok":n}
 */

import * as os from "node:os";
import * as path from "node:path";
import { OperationalStore } from "../../../src/operational/store";

const CONTENDER = path.join(import.meta.dir, "launch-authority-contender.ts");

const kind = process.argv[2] === "clash" ? "clash" : "same";
const dbPath = path.join(os.tmpdir(), `authority-race-${kind}-${Date.now()}.db`);
OperationalStore.open({ dbPath }).close();
const barrierPath = `${dbPath}.barrier`;

const objectives =
	kind === "same" ? ["same mission", "same mission", "same mission", "same mission"] : ["a", "b", "c", "d"];
const procs = objectives.map(objective =>
	Bun.spawn(["bun", CONTENDER, dbPath, objective, barrierPath], { stdout: "pipe", stderr: "pipe" }),
);

const readyDeadline = Date.now() + 30_000;
for (;;) {
	const readyFile = Bun.file(`${barrierPath}.ready`);
	const text = (await readyFile.exists()) ? await readyFile.text() : "";
	if (text.trim().split("\n").filter(Boolean).length >= procs.length) break;
	if (Date.now() > readyDeadline) throw new Error("contenders failed to signal readiness");
	await Bun.sleep(10);
}
await Bun.write(barrierPath, "go");

const results: { ok: boolean; replayed?: boolean; code?: string }[] = [];
for (const proc of procs) {
	const out = (await new Response(proc.stdout).text()).trim();
	await proc.exited;
	results.push(JSON.parse(out.split("\n").filter(Boolean).pop() ?? "{}"));
}

const summary = {
	kind,
	ok: results.filter(r => r.ok).length,
	allocations: results.filter(r => r.ok && r.replayed === false).length,
	replays: results.filter(r => r.ok && r.replayed === true).length,
	conflicts: results.filter(r => !r.ok && r.code === "admission_conflict").length,
};

if (kind === "same") {
	if (summary.ok !== 4 || summary.allocations !== 1 || summary.replays !== 3) {
		console.error(`same-contract race violated: ${JSON.stringify(summary)}`);
		process.exit(1);
	}
} else if (summary.allocations !== 1 || summary.conflicts !== 3) {
	console.error(`conflicting-contract race violated: ${JSON.stringify(summary)}`);
	process.exit(1);
}

console.log(JSON.stringify(summary));
