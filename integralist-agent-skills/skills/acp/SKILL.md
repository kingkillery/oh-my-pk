---
name: acp
version: "1.1.0"
description: Use when the user invokes /acp or asks to stage, record, and push approved session edits to origin/main. Do not use for branch PRs or rebases.
disable-model-invocation: true
metadata:
  author: nerdsaver <kingkillery@users.noreply.github.com>
  version: "1.1.0"
  model-tier: trivial
  tags:
    - git
    - workflow
    - push
    - automation
---

# ACP — Approve, Commit, and Push

## Purpose

Treat `/acp` (or an explicit request to stage, record, and push already-reviewed session changes) as approval to apply any pending proposed edit, stage only the intended files by name, create a Conventional Commit, and push it to `origin/main` in two consecutive tool rounds without exploratory `git status` or `git log` round-trips. Follow [GIT-COMMIT.md](references/GIT-COMMIT.md) for staging discipline and commit message structure.

## Prerequisites

- Working tree inside a Git repository checked out on `main` with push access to `origin`.
- Known list of session-owned modified, new, or proposed files to ship.
- Conventional Commit rules in [GIT-COMMIT.md](references/GIT-COMMIT.md).

## Instructions

1. **Prepare (tool round 1).** Read [GIT-COMMIT.md](references/GIT-COMMIT.md). Apply the pending proposed edit if it is not written yet, inspect `git diff -- <files>` on the target paths to verify zero secrets (`API_KEY`, tokens, passwords, private keys, or `.env` values), resolve the commit-message path with `git rev-parse --git-path ACP_COMMIT_MSG` (gives `.git/ACP_COMMIT_MSG` in standard clones and the gitdir path in worktrees/submodules), and write the commit message to that returned path. Note: in a linked worktree whose gitdir lies outside a sandboxed workspace, fall back to passing the message via shell if the file-writing tool blocks external paths. Do not run whole-file linters, exploratory test commands, or cache-deletion commands on approved changes.
2. **Verify branch, commit, and push immediately (tool round 2).** Unless a safety check in step 1 fails, immediately continue in the same invocation—do not pause after writing `ACP_COMMIT_MSG`. Confirm `HEAD` is on `main` (`git symbolic-ref --short HEAD`); if `HEAD` is detached, on another branch, or ambiguous, stop and ask before committing. Otherwise run staging, commit, push, and SHA verification in one `bash` call while leaving unrelated modified or untracked files unstaged:

```bash
test "$(git symbolic-ref --short HEAD)" = "main" && \
  git add -- <file1> <file2> && \
  git commit -F <resolved-msg-path> && \
  git push origin main && \
  git rev-parse --short HEAD
```

3. **Report completion.** Confirm `origin/main` received the commit by reporting the pushed short SHA, pushed ref range, and exact files committed.

## Examples

### Trigger and boundary phrasings

- **Should use `acp`:** `/acp`, `"stage, commit, and push this fix"`, `"push this to main"`, `"land the approved edit on origin/main"`, `"ship the proposed change now"`.
- **Should NOT use `acp`:** `"open a pull request on feat/auth"` (branch PR workflow), `"interactive rebase the last 3 commits"` (history rewrite), `"review my working tree changes"` (read-only review).

### Two-turn execution example

Turn 1 — inspect scoped diff for secrets, resolve `git rev-parse --git-path ACP_COMMIT_MSG`, and write the message to that resolved path:

```txt
docs(agents): cut root guidance overhead by half without losing rules

Move detailed sync procedures into their owner skill and runbook while keeping
all safety gates and contract markers intact.
```

Turn 2 — stage named files, commit from the resolved message path, push `main`, and print receipt:

```bash
test "$(git symbolic-ref --short HEAD)" = "main" && \
  git add -- <changed-file-1> <changed-file-2> && \
  git commit -F <resolved-msg-path> && \
  git push origin main && \
  git rev-parse --short HEAD
```

## Limitations

- Pushes fast-forward commits to `origin/main` only; never rewrites remote history, creates feature branches, or opens pull requests.
- Sets `disable-model-invocation: true` so harnesses that enforce manual-only skills require explicit `/acp` or user invocation rather than auto-committing mid-exploration.
- Never stages all working-tree changes blindly, preserving concurrent unstaged work in shared operator checkouts.

## Troubleshooting

| Symptom | Cause | Resolution |
| --- | --- | --- |
| Secret, token, or `.env` value appears in scoped diff | Credential or local config leaked into target file | Stop before staging; redact or move secret to environment storage and tell the user |
| `HEAD` is detached or on a non-`main` branch | Checkout is on a feature branch, sparse worker, or bisect | Stop and ask whether to push the current branch or switch to `main` |
| Pre-commit hook modifies files and exits non-zero | Formatter rewrote staged lines | Re-read diff, re-stage named files, and re-run commit with git hooks enabled |
| Push to `origin/main` is rejected (`fetch first`) | Remote `origin/main` has newer commits | Stop and ask before rebasing onto `origin/main`; never overwrite remote history |
