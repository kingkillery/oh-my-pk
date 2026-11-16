#!/bin/sh
# Packman Python launcher (POSIX /bin/sh).
# Resolve a working Python 3.11+ interpreter in priority order:
#   1. $PACKMAN_PYTHON
#   2. <repo>/.venv/bin/python
#   3. <repo>/.venv/Scripts/python.exe
#   4. python3
#   5. python
# Then exec it with all arguments ("$@").
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
VERSION_CHECK='import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'
if [ -n "${PACKMAN_PYTHON:-}" ]; then
    if [ -x "$PACKMAN_PYTHON" ] || command -v "$PACKMAN_PYTHON" >/dev/null 2>&1; then
        if "$PACKMAN_PYTHON" -c "$VERSION_CHECK" >/dev/null 2>&1; then
            exec "$PACKMAN_PYTHON" "$@"
        fi
    fi
fi
VENV_BIN="$REPO_ROOT/.venv/bin/python"
if [ -x "$VENV_BIN" ]; then
    if "$VENV_BIN" -c "$VERSION_CHECK" >/dev/null 2>&1; then
        exec "$VENV_BIN" "$@"
    fi
fi
VENV_WIN="$REPO_ROOT/.venv/Scripts/python.exe"
if [ -x "$VENV_WIN" ]; then
    if "$VENV_WIN" -c "$VERSION_CHECK" >/dev/null 2>&1; then
        exec "$VENV_WIN" "$@"
    fi
fi
if command -v python3 >/dev/null 2>&1; then
    if python3 -c "$VERSION_CHECK" >/dev/null 2>&1; then
        exec python3 "$@"
    fi
fi
if command -v python >/dev/null 2>&1; then
    if python -c "$VERSION_CHECK" >/dev/null 2>&1; then
        exec python "$@"
    fi
fi
echo "packman python: no Python 3.11+ interpreter found" >&2
exit 1
