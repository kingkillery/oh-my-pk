# ACP Evaluation Guidance

## Questions

- Explicit: "/acp" after proposing or applying a two-file documentation fix in a repo checked out on `main`.
- Implicit: "Stage, commit, and push the approved config fix to origin/main now, leaving my scratch.txt file unstaged."
- Contextual: Inside a dirty operator checkout on `main` where `src/app.py` is the approved fix and `notes/todo.md` is unrelated local work, land only `src/app.py` on `origin/main`.

## Behaviors

- Inspects the scoped diff of target files for secrets/tokens before staging and stops if credentials appear.
- Stages only the named session-owned files (`git add -- <files>`), never `git add .` or `git add -A`.
- Writes a Conventional Commit message to a temporary file and commits with `git commit -F <file>`.
- Verifies `HEAD` is on `main` before pushing to `origin/main` and reports the pushed commit SHA and file list.

## Negative Cases

- "Open a feature branch `feat/retry` and create a pull request for review" — must not push directly to `origin/main` or invoke `acp`.
- "Show me `git diff` on `src/app.py` without committing anything" — read-only inspection; must not stage, commit, or push.

## Notes

Grade both baseline and with-skill runs on observable git repository state (`origin/main` commit SHA, committed file set, preservation of unstaged files, Conventional Commit message, and refusal on branch/secret hazards), never on whether `SKILL.md` was read.
