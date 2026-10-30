# Vendored TokenEconomizer

Source: `https://github.com/microsoft/TokenEconomizer` clone at `.te-inspect/te-repo`
Commit: `4932c12` (Merge pull request #13 from microsoft/fix-codex-toml-source)

Vendored subtree:
- `tokeneconomizer/` — full Python package (stdlib-only, requires Python 3.10+)
- `plugin/scripts/` — POSIX `sh` launchers (`te`, `te-hook`) plus `te_bootstrap.py`

Consumed by `src/tokeneconomizer/extension.ts` (inline builtin extension) via `te-hook`/`te` dispatchers.

## Host

Canonical OMPK host name is `ompk` (alias `omp` also accepted). Python host class `Ompk` in `tokeneconomizer/plugin/hosts.py` subclasses `Pi` because OMPK session file format is Pi-compatible. `te --host ompk` targets OMPK sessions; `te --host pi` is still supported for Pi installations.

## Env vars (forwarded by extension via `process.env` spread)

`TE_DISABLE`, `TE_SIDECALL`, `TE_PYTHON`, `TE_CORE_PATH`, `TOKENECONOMIZER_HOME`, `TE_OMPK_MODE`, `TE_OMPK_CLI`, `TE_SESSION_ID`, `TE_MICROSKILLS`, `TE_TOOLPRUNE`, `TE_LOOPGUARD`

## Updating

Re-clone from upstream and re-copy:

```
git -C .te-inspect/te-repo fetch origin && git -C .te-inspect/te-repo log --oneline -1
# then re-copy tokeneconomizer/ and plugin/scripts/ per this directory's history
```

Then fix CRLF on Windows checkouts (git autocrlf) and re-apply `Ompk` patch to `tokeneconomizer/plugin/hosts.py` + `sidecall.py` if still vendored.
