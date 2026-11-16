# verify — Focused Verification Procedure

Run only the checks that cover the touched slice. Never run project-wide gates inside worker tasks.

1. Typecheck/lint the owning package: `bun check` (never `tsc` or `npx tsc`). Python: `bun run lint:py` / `bun run fix:py` per `python/robomp/AGENTS.md`.
2. Focused behavior tests: `bun test <file>` for TypeScript, `bun run test:py` for Python (`pytest -x python/omp-rpc/tests python/robomp/tests`).
3. Bend work: `bend guide`, `LAWS.bend`, `bend PROOF.bend` before commit.
4. PR 45 ports only: observable contract, focused tests, package checks, final union check.
5. Log inspection: `tokf raw last` with secret scrubbing before pasting output.
6. Release-adjacent changes: `bun run check:dist` in `packages/coding-agent` (exe + `build-manifest.json` parity).

Report exact commands and pass/fail. A proven pre-existing or environment-only failure needs an explicit merge-owner waiver. See `.agents/rules/testing-and-verification.md`.
