"""Memory-promotion checks for stop-hook validation.

Enforces SSOT adapter thinness (blocking) and surfaces architectural
changes that lack a matching context/rules/memory/docs update as
advisories (blocking only under ``--strict-promotion``).
"""

from __future__ import annotations

import argparse
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

THIN_WRAPPERS = ("CLAUDE.md", "GEMINI.md", ".clinerules")
THIN_WRAPPER_MAX_CHARS = 2000
PROMOTION_PREFIXES = (
    ".agents/context/",
    ".agents/rules/",
    "memory/",
    "docs/",
)


@dataclass(slots=True, frozen=True)
class PromotionReport:
    """Result of memory-promotion validation."""

    ok: bool
    errors: tuple[str, ...]
    advisories: tuple[str, ...]
    files: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable dict."""
        return {
            "ok": self.ok,
            "errors": list(self.errors),
            "advisories": list(self.advisories),
            "files": list(self.files),
        }


def collect_modified_files(
    repo_root: Path, files: list[str] | None = None
) -> list[str]:
    """Return modified file paths as repo-relative strings."""
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


def check_thin_wrappers(repo_root: Path) -> list[str]:
    """Enforce thin-wrapper rules for SSOT adapter files."""
    errors: list[str] = []
    for name in THIN_WRAPPERS:
        target = repo_root / name
        if not target.is_file():
            continue
        try:
            content = target.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            errors.append(f"{name}: unreadable file: {exc}")
            continue
        if len(content) > THIN_WRAPPER_MAX_CHARS:
            errors.append(
                f"{name}: {len(content)} chars exceeds "
                f"thin-wrapper cap {THIN_WRAPPER_MAX_CHARS}"
            )
        has_canonical = ".agents/" in content or "AGENTS.md" in content
        if not has_canonical:
            errors.append(
                f"{name}: missing canonical .agents/ reference "
                f"(expected .agents/instructions.md or AGENTS.md)"
            )
    return errors


def is_arch_file(path: str) -> bool:
    """Return True for architectural/config paths."""
    normalized = path.replace("\\", "/")
    normalized = normalized.removeprefix("./")
    if normalized.startswith("packages/") and "/src/" in normalized:
        return True
    if normalized.startswith("crates/"):
        return True
    if normalized.startswith("python/"):
        return True
    return normalized.startswith("docs/")


def is_promotion_file(path: str) -> bool:
    """Return True for paths that count as context promotion."""
    normalized = path.replace("\\", "/")
    normalized = normalized.removeprefix("./")
    for prefix in PROMOTION_PREFIXES:
        if normalized.startswith(prefix):
            return True
    return False


def check_promotion_advisories(files: list[str]) -> list[str]:
    """Detect architectural changes lacking a promotion update."""
    arch = [name for name in files if is_arch_file(name)]
    if not arch:
        return []
    promoted = [name for name in files if is_promotion_file(name)]
    if promoted:
        return []
    joined = ", ".join(sorted(arch)[:5])
    return [
        (f"Architectural change without context promotion: {joined} "
        f"-- update .agents/context/, .agents/rules/, memory/, or docs/")
    ]


def run_memory_promotion_check(
    repo_root: Path,
    files: list[str] | None = None,
    strict_promotion: bool = False,
) -> PromotionReport:
    """Run memory-promotion analysis and return a typed report."""
    checked = collect_modified_files(repo_root, files)
    blocking = check_thin_wrappers(repo_root)
    advisories = check_promotion_advisories(checked)
    effective_errors = list(blocking)
    if strict_promotion:
        effective_errors.extend(advisories)
    return PromotionReport(
        ok=len(effective_errors) == 0,
        errors=tuple(blocking),
        advisories=tuple(advisories),
        files=tuple(checked),
    )


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI argument parser."""
    parser = argparse.ArgumentParser(description="Run memory-promotion check.")
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
    parser.add_argument(
        "--strict-promotion",
        action="store_true",
        help="Treat promotion advisories as blocking errors.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Returns 0 on pass, 1 on blocking failure."""
    args = build_parser().parse_args(argv)
    repo_root = args.repo_root.resolve() if args.repo_root is not None else Path.cwd()
    report = run_memory_promotion_check(
        repo_root,
        files=args.files,
        strict_promotion=args.strict_promotion,
    )
    if args.json:
        print(json.dumps(report.to_dict(), indent=2))
    else:
        for problem in report.errors:
            print(f"error: {problem}")
        for note in report.advisories:
            print(f"advisory: {note}")
        if report.ok:
            print("memory promotion: PASS")
        else:
            print("memory promotion: FAIL")
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
