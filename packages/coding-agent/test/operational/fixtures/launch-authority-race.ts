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
 * Results arrive as one file per contender slot (not shared-file appends,
 * which lose writes on Windows; not stdout, which vanished under load). A
 * missing slot file makes the run INVALID — the race never happened — rather
 * than a well-formed summary over a shrunken field.
 *
 * Usage: bun launch-authority-race.ts <same|clash>
 * Prints JSON: {"kind":...,"ok":n,"allocations":n,"replays":n,"conflicts":n}
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
const slots = ["0", "1", "2", "3"];
const procs = objectives.map((objective, index) =>
	Bun.spawn(["bun", CONTENDER, dbPath, objective, barrierPath, slots[index] as string], {
		stdout: "pipe",
		stderr: "pipe",
	}),
);

const readyDeadline = Date.now() + 120_000;
for (;;) {
	const readyFile = Bun.file(`${barrierPath}.ready`);
	const text = (await readyFile.exists()) ? await readyFile.text() : "";
	if (text.trim().split("\n").filter(Boolean).length >= procs.length) break;
	if (Date.now() > readyDeadline) throw new Error("contenders failed to signal readiness");
	await Bun.sleep(10);
}
await Bun.write(barrierPath, "go");
await Promise.all(procs.map(proc => proc.exited));

const results: { ok: boolean; replayed?: boolean; code?: string; detail?: string | null }[] = [];
for (const slot of slots) {
	const file = Bun.file(`${dbPath}.result.${slot}`);
	if (!(await file.exists())) {
		console.error(`race invalid: slot ${slot} produced no result file; refusing to summarize`);
		process.exit(2);
	}
	results.push(JSON.parse(await file.text()) as { ok: boolean; replayed?: boolean; code?: string });
}
if (results.length !== procs.length) {
	console.error(`race invalid: only ${results.length} of ${procs.length} contenders reported`);
	process.exit(2);
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
		console.error(`same-contract race violated: ${JSON.stringify(summary)} ${JSON.stringify(results)}`);
		process.exit(1);
	}
} else if (summary.allocations !== 1 || summary.conflicts !== 3) {
	console.error(`conflicting-contract race violated: ${JSON.stringify(summary)} ${JSON.stringify(results)}`);
	process.exit(1);
}

console.log(JSON.stringify(summary));
