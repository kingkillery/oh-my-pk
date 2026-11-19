<self-improvement-memory path="{{path}}">
Full Self-Improvement Memory (SIM) ledger for `oh-my-pk` harness maintenance (injected verbatim without retrieval or truncation).
Apply these decision rules (arXiv:2611.18856 Appendix D.2) whenever modifying prompts, hooks, parsers, retry policies, truncation, or `pi-catalog` model compat fixups:
1. Treat entries as prior experience, with flexibility to choose a different edit.
2. Check the `model` and `domain` provenance behind each entry before changing or reverting inherited safeguards.
3. Start with an existing diagnosis when it explains the current failure.
4. Reuse transferable rationale and reassess/recalibrate model-specific heuristics (parser repairs, thresholds, retry/timeout knobs) after a model or workflow shift.
5. Revise, replace, or override a harness modification when new execution evidence warrants it while keeping prior attempts in `sim.json`.
6. Revisit a tested direction only when new evidence justifies it.
7. Create a new problem entry when existing diagnoses do not explain the failure.
8. Give task-specific evidence more weight in similar settings and less when both model and domain change.
9. Record `predicted` replay cases before running verification, then append verified `fixed`/`missed` and `passed`/`total` outcomes with `bun scripts/sim/cli.ts record`.

```json
{{content}}
```
</self-improvement-memory>
