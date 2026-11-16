---
name: superpowers
description: "PR 45 convergence and fork-boundary-safe porting: one lane at a time with contract, tests, union check"
---

# superpowers

Applies PR 45 convergence policy and fork boundaries without copying them.

- Read `.agents/instructions.md` (PR 45 section) and `.agents/rules/workflow-modes.md`.
- Port one coherent lane for **Pull into main** only; prove `main` lacks it; prefer current `main` design.
- Gate: observable contract, focused tests, `bun check`, union check. Preserve CoLab/Hub/IRC/`/remote`/SSH/remote-workspace separation.
- Keep stable prompt prefixes byte-stable, dynamic context late.
- Verify with `.agents/commands/verify.md`.
