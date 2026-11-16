---
name: ponytail
description: "Scoped minimal edits: protect parallel sessions, prefer smallest correct fix, avoid collateral changes"
---

# ponytail

Applies scoped-change and machine-safety discipline without copying canonical prose.

- Read `.agents/instructions.md` (Scope, Machine and compute) and `.agents/rules/core-engineering.md`.
- Make the smallest correct fix at the root cause. Touch only owned paths; report newly discovered scope before editing it.
- Never `taskkill` `bun.exe`/`node.exe` broadly; filter `Get-CimInstance Win32_Process` on `CommandLine`.
- Heavy verification offload to `msi` only when needed; keep light commands local.
- Verify with `.agents/commands/verify.md`.
