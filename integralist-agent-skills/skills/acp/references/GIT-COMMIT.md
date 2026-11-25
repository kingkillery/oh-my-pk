# Git Commit Conventions

Shared safety, staging, and commit-message rules for skills that create Git
commits.

## Safety

- Never commit secrets (keys, tokens, passwords, or `.env` files).
- Read the diff and untracked files before staging; if you find a secret, stop
  and tell the user.
- Hooks always run.

## Staging

Stage by name. Never use `git add -A` or `git add .`.

## Message

The commits are the user's own: add no co-author or "generated with" trailer.
Use this shape, with type `feat`, `fix`, `docs`, `chore`, or `ci`:

```txt
<type>(<scope>): <why it matters, imperative mood>

<what changed and how it was verified>
```

The subject answers "so what?"; the diff already shows the mechanics. Describe
the diff, not the request — if they disagree, tell the user.

```txt
BAD:  fix(ratelimit): set burst to 200
GOOD: fix(ratelimit): raise burst so valid retries stop being dropped
```

## Commit

Resolve the message path with `git rev-parse --git-path ACP_COMMIT_MSG` (gives
`.git/ACP_COMMIT_MSG` in standard clones and the gitdir path in worktrees or
submodules, staying git-ignored), write the message to that returned path with
the file-writing tool, and run `git commit -F <resolved-msg-path>`.
In a linked worktree whose gitdir sits outside a sandboxed workspace, fall back
to writing via shell if the file-writing tool blocks external paths. A malformed
heredoc into `git commit -F -` can hang forever. If a hook rewrites files, amend
only for formatting or lint fixes; otherwise ask.
