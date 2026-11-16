"""Completion gates run at stop-hook time.

Validates modified Python files, Windsurf rule budget, and MCP sync parity.
Exposes a typed Python API and a JSON CLI (exit 0 pass, 1 fail).
"""

from __future__ import annotations

import argparse
import ast
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

WINDSURF_MAX_CHARS = 6000
WINDSURF_REL = ".windsurf/rules/project.md"
MCP_JSON_REL = ".mcp.json"
MCP_SCRIPT_REL = ".agents/scripts/sync_mcp_configs.py"
CONFLICT_PREFIXES = ("<<<<<<<", "=======", ">>>>>>>", "|||||||")


@dataclass(slots=True, frozen=True)
class GateReport:
    """Result of completion-gate validation."""

    ok: bool
    errors: tuple[str, ...]
    files: tuple[str, ...]

    @property
    def failures(self) -> tuple[str, ...]:
        """Alias for errors."""
        return self.errors

    @property
    def checked_files(self) -> tuple[str, ...]:
        """Alias for files."""
        return self.files

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable dict."""
        return {
            "ok": self.ok,
            "errors": list(self.errors),
            "files": list(self.files),
        }


def collect_modified_files(
    repo_root: Path, files: list[str] | None = None
) -> list[str]:
    """Return modified file paths as repo-relative strings.

    If files is not None it is returned as-is. Otherwise inspect
    ``git status --porcelain`` inside repo_root; empty list when git
    is unavailable or the directory is not a git worktree.
    """
    if files is not None:
        return list(files)
    try:
        proc = subprocess.run(
            ["git", "status", "--porcelain"],
            check=False, cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if proc.returncode != 0:
        return []
    collected: list[str] = []
    for line in proc.stdout.splitlines():
        line = line.rstrip("\n")
        if len(line) < 4:
            continue
        path = line[3:].strip()
        if not path:
            continue
        if " -> " in path:
            path = path.split(" -> ", 1)[-1].strip()
        if len(path) >= 2 and path.startswith('"') and path.endswith('"'):
            path = path[1:-1]
        collected.append(path)
    return collected


def check_python_files(repo_root: Path, files: list[str]) -> list[str]:
    """Syntax and conflict-marker checks for modified .py files."""
    errors: list[str] = []
    for name in files:
        if not name.endswith(".py"):
            continue
        target = repo_root / name
        if not target.exists() or not target.is_file():
            continue
        try:
            source = target.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            errors.append(f"{name}: unreadable file: {exc}")
            continue
        lines = source.splitlines()
        for number, text in enumerate(lines, start=1):
            stripped = text.strip()
            for prefix in CONFLICT_PREFIXES:
                if stripped.startswith(prefix):
                    errors.append(
                        f"{name}:{number}: merge conflict marker {stripped[:16]}"
                    )
                    break
        try:
            ast.parse(source, filename=name)
        except SyntaxError as exc:
            line_no = exc.lineno if exc.lineno is not None else 0
            message = exc.msg or "invalid syntax"
            errors.append(f"{name}:{line_no}: SyntaxError: {message}")
    return errors


def check_ruff(repo_root: Path, files: list[str]) -> list[str]:
    """Run ``ruff check --quiet`` on modified .py files when available."""
    targets = [
        str(repo_root / name)
        for name in files
        if name.endswith(".py") and (repo_root / name).is_file()
    ]
    if not targets:
        return []
    if shutil.which("ruff") is None:
        return []
    try:
        proc = subprocess.run(
            ["ruff", "check", "--quiet", *targets],
            check=False, cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if proc.returncode == 0:
        return []
    output = (proc.stdout or "") + (proc.stderr or "")
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return ["ruff check found issues"]
    return lines


def check_windsurf_budget(repo_root: Path) -> list[str]:
    """Validate the Windsurf rule file stays within the char budget."""
    target = repo_root / WINDSURF_REL
    if not target.is_file():
        return []
    try:
        content = target.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return [f"{WINDSURF_REL}: unreadable file: {exc}"]
    if len(content) > WINDSURF_MAX_CHARS:
        return [
            (f"{WINDSURF_REL}: {len(content)} chars exceeds "
            f"{WINDSURF_MAX_CHARS} char budget")
        ]
    return []


def check_mcp_sync(repo_root: Path) -> list[str]:
    """Invoke sync_mcp_configs.py --check when both inputs exist."""
    mcp_json = repo_root / MCP_JSON_REL
    script = repo_root / MCP_SCRIPT_REL
    if not (mcp_json.is_file() and script.is_file()):
        return []
    try:
        proc = subprocess.run(
            [sys.executable, str(script), "--check"],
            check=False, cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return [f"{MCP_SCRIPT_REL}: check failed to run: {exc}"]
    if proc.returncode == 0:
        return []
    detail = ((proc.stdout or "") + (proc.stderr or "")).strip()
    if detail:
        return [f"{MCP_SCRIPT_REL}: {detail}"]
    return [f"{MCP_SCRIPT_REL}: --check exited {proc.returncode}"]


def run_completion_gates(
    repo_root: Path, files: list[str] | None = None
) -> GateReport:
    """Run all completion gates and return a typed report."""
    checked = collect_modified_files(repo_root, files)
    problems: list[str] = []
    problems.extend(check_python_files(repo_root, checked))
    problems.extend(check_ruff(repo_root, checked))
    problems.extend(check_windsurf_budget(repo_root))
    problems.extend(check_mcp_sync(repo_root))
    return GateReport(
        ok=len(problems) == 0,
        errors=tuple(problems),
        files=tuple(checked),
    )


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI argument parser."""
    parser = argparse.ArgumentParser(description="Run completion gates.")
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=None,
        help="Repository root (default: current directory).",
    )
    parser.add_argument(
        "--files",
        nargs="*",
        default=None,
        help="Explicit file list; when omitted use git status.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print the report as JSON.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Returns 0 on pass, 1 on fail."""
    args = build_parser().parse_args(argv)
    repo_root = args.repo_root.resolve() if args.repo_root is not None else Path.cwd()
    report = run_completion_gates(repo_root, files=args.files)
    if args.json:
        print(json.dumps(report.to_dict(), indent=2))
    else:
        if report.ok:
            print("completion gates: PASS")
        else:
            print("completion gates: FAIL")
            for problem in report.errors:
                print(f"- {problem}")
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
