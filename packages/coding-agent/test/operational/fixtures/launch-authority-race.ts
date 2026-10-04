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
 * The temporary database directory is removed on every exit path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LifecycleAuthorityStore } from "../../../src/operational/lifecycle-authority-store";

const CONTENDER = path.join(import.meta.dir, "launch-authority-contender.ts");

function fail(message: string, code = 1): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

const kind = process.argv[2] === "clash" ? "clash" : "same";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `authority-race-${kind}-`));
process.on("exit", () => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});
const dbPath = path.join(tempDir, "lifecycle-authority.db");
LifecycleAuthorityStore.open({ dbPath }).close();
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
		fail(`race invalid: slot ${slot} produced no result file; refusing to summarize`, 2);
	}
	results.push(JSON.parse(await file.text()) as { ok: boolean; replayed?: boolean; code?: string });
}
if (results.length !== procs.length) {
	fail(`race invalid: only ${results.length} of ${procs.length} contenders reported`, 2);
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
		fail(`same-contract race violated: ${JSON.stringify(summary)} ${JSON.stringify(results)}`);
	}
} else if (summary.allocations !== 1 || summary.conflicts !== 3) {
	fail(`conflicting-contract race violated: ${JSON.stringify(summary)} ${JSON.stringify(results)}`);
}

process.stdout.write(`${JSON.stringify(summary)}\n`);
