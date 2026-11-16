# Claude Code Entry Point

Thin entry. Canonical rules SSOT: `.agents/instructions.md` (imported below). Settings: `.claude/settings.json` (80% auto-compact ceiling; proactive compaction protocol at 50-75% context). Keep stable prompt prefix byte-stable; append dynamic context late.

@.agents/instructions.md

!git status -sb
!git diff --name-only
!git log --oneline -5
