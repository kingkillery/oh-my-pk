 # A02 Entry Slice — Immutable Launch Contract Integration (Phase 0 definition only — do not implement beyond slice)

 Correction 2026-09-20: A02 is immutable launch contract integration, NOT an updater workaround. Prior Windows `--version` capture fix below is retained as a Phase 0 baseline defect slice (lane A), separate from A02 contract work (lane B).

 ## A02 scope (lane B, W1)
 - Repair EXISTING `src/task/launch-contract.ts` exports: `compileLaunchContract`, `bindLaunchContract`, `parseLaunchContract`, `computeMissionHash` — separate compilation from binding, frozen hashes, no synthetic capability refs.
 - Freeze shared types per §4.4; no second compiler, no parallel policy engine.
 - Prior updater workaround is NOT A02 closure.

 ## Phase 0 baseline slice retained (lane A, W0)
 - `packages/coding-agent/src/cli/update-cli.ts` `verifyInstalledVersion()` + one focused regression test.
 - `omp.exe --version` completes under pipe/quiet child capture on Windows with 20s timeout.
 - Existing `bun test test/operational/` and `scripts/release-query.test.ts` stay green; `bun run check` passes.
 - Independent channel health re-recorded (GitHub/hosted/npm separate).
 - No change to CLI output, version string, topology, capabilities, or durable schema beyond this seam. No A03–A18 work in this slice.

 ## Non-goals
 - No trusted-publisher automation; npm 16.4.24 already recovered, do not republish.
 - No VERSION pointer/tag moves until fix verified.
