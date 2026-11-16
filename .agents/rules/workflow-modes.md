---
description: "Workflow modes: Simple Mode, Colab gates, PR 45 convergence, and machine safety"
alwaysApply: false
globs: ["packages/coding-agent/src/**/*.ts", "docs/*.md", "C:/dev/Infra/ompk-remote/**/*"]
---

# Workflow Modes Rules

- Solo-first: reuse Simple Mode (`task.simpleMode`, `/simple`); primary agent keeps accountability; `work_context` is a scoped read-only tool after verifying native availability; preserve full multi-agent when deliberately selected.
- Colab: general compute by default; `/colab-model` or explicit inference intent establishes model intent; inspect sessions first; runtime, model, bridge, registration, generation are separate gates.
- PR 45: `main` is baseline; port one coherent lane at a time for **Pull into main** only; prove `main` lacks it; preserve CoLab/Hub/IRC/`/remote`/SSH/remote-workspace boundaries; keep prefixes byte-stable.
- Machine safety (`pk`): never `taskkill` `bun.exe`/`node.exe` broadly; filter `Get-CimInstance Win32_Process` on `CommandLine`. Heavy verification offloads to `msi` via `cd C:/dev/Infra/ompk-remote && bun run remote.mjs auto --bg -- bun test <file>`.
- Kade: bootstrap `C:\Users\prest\.agents\kade.md` + `human.md` via `kade-hq`; unqualified wiki updates route to `C:\dev\Vaults\Design-and-Building\oh-my-pk Wiki\`; `C:\dev\Vaults\Kade` is explicit-only; `pk-has-adhd` supplemental.
- Collaboration: `docs/multi-agent-fork-collaboration.md` (Linear-suspended manual queue mode); surfaces: `docs/fork-boundaries.md`.
