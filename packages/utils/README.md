# @pk-nerdsaver-ai/pi-utils

Shared utilities for [oh-my-pk](https://github.com/kingkillery/oh-my-pk) packages. Zero ceremony, Bun-first.

## Notable modules

| Module | Purpose |
| --- | --- |
| `logger` | Centralized logger writing to `~/.ompk/logs/` with rotation (TUI-safe — never stdout) |
| `prompt` | Handlebars-based prompt templating and formatting helpers |
| `dirs` | Path helpers for omp config directories (`~/.ompk`, XDG-aware on Linux) |
| `stream` | `readStream` / `readLines` helpers over `ReadableStream` |
| `ptree` / `procmgr` | Process trees, `ChildProcess` wrapper, process lifecycle management |
| `postmortem` | Cleanup callbacks on exit, signals, and fatal exceptions |
| `which` | `$which()` binary lookup with caching |
| `fetch-retry` | `fetch` with retry/backoff policies |
| `fs-error` | Errno guards (`isEnoent` and friends) |
| `env` / `worker-host` | Environment plumbing and side-effect-free worker-host entry contract (`workerHostEntry`) |
| `abortable` / `async` | AbortSignal-aware stream/promise helpers |
| `math-delimiters` | LaTeX span/block delimiter grammar (offsets only) shared by the TUI and collab-web renderers |
| `peek-file` | Read the first N bytes of a file with pooled buffers |
| `frontmatter`, `glob`, `mime`, `temp`, `format`, `color`, `snowflake`, `tab-spacing`, `path-tree`, `sanitize-text` | Smaller single-purpose helpers |

Import from the root barrel or per-module subpaths (`@pk-nerdsaver-ai/pi-utils/<module>`).

## Install

```sh
bun add @pk-nerdsaver-ai/pi-utils
```

Ships TypeScript source directly (no build step); requires Bun ≥ 1.3.14.

## References

- [Monorepo README](https://github.com/kingkillery/oh-my-pk#readme)
- [CHANGELOG](./CHANGELOG.md)
