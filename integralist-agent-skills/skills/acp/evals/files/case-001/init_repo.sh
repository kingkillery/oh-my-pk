#!/usr/bin/env bash
set -euo pipefail
TARGET_DIR="${1:-/workspace/work-repo}"
mkdir -p "$(dirname "$TARGET_DIR")"
ABS_PARENT="$(cd "$(dirname "$TARGET_DIR")" && pwd)"
ABS_TARGET="${ABS_PARENT}/$(basename "$TARGET_DIR")"
ABS_REMOTE="${ABS_TARGET}-origin.git"

if [ -d "${ABS_TARGET}/.git" ] && [ -d "${ABS_REMOTE}" ]; then
  echo "Fixture already initialized at ${ABS_TARGET} (remote: ${ABS_REMOTE})"
  exit 0
fi

rm -rf "$ABS_TARGET" "$ABS_REMOTE"
git init --bare --initial-branch=main "$ABS_REMOTE" >/dev/null
git init --initial-branch=main "$ABS_TARGET" >/dev/null
cd "$ABS_TARGET"
git config user.name "Eval Operator"
git config user.email "eval@users.noreply.github.com"
mkdir -p src scratch
printf 'def parse(line: str) -> list[str]:\n    return line.split(",")\n' > src/parser.py
git add src/parser.py
git commit -m "feat(parser): initial comma splitter" >/dev/null
git remote add origin "$ABS_REMOTE"
git push -u origin main >/dev/null

# Approved session edit in src/parser.py + unrelated local scratch file
printf 'def parse(line: str) -> list[str]:\n    return [part.strip() for part in line.split(",") if part.strip()]\n' > src/parser.py
printf 'local debug notes - keep unstaged\n' > scratch/debug.txt
echo "Fixture ready at ${ABS_TARGET} (remote: ${ABS_REMOTE})"
