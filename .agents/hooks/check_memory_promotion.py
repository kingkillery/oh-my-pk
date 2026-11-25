"""Memory-promotion checks for stop-hook validation.

Enforces SSOT adapter thinness (blocking) and surfaces architectural
changes that lack a matching context/rules/memory/docs update as
advisories (blocking only under ``--strict-promotion``).
"""

from __future__ import annotations

import argparse
import json
import math
import re
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
SIM_LEDGER_REL = ".omp/sim.json"
SIM_PROBLEM_ID_RE = re.compile(r"^P[1-9][0-9]*$")
SIM_BASELINE_TYPES = frozenset(
    {"unchanged", "heuristic", "random", "no_op", "prior_arm"}
)
MEMORY_VERIFICATION_RE = re.compile(
    r"^\s*(?:[-*]\s*)?(?:\*\*)?verification(?:\*\*)?\s*:\s*(.+)$",
    re.IGNORECASE | re.MULTILINE,
)
PLACEHOLDER_VERIFICATION_VALUES = frozenset(
    {"todo", "tbd", "n/a", "na", "none", "placeholder", "...", "pending"}
)
SECRET_LEAK_RE = re.compile(
    r"(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{10,}|user:pass@)"
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


def check_memory_entries(repo_root: Path, files: list[str]) -> list[str]:
    """Require concrete verification evidence and zero secrets on promoted memory/*.md files."""
    errors: list[str] = []
    for raw_name in files:
        normalized = raw_name.replace("\\", "/").removeprefix("./")
        if not normalized.startswith("memory/") or not normalized.endswith(".md"):
            continue
        if normalized == "memory/README.md":
            continue
        target = repo_root / normalized
        if not target.is_file():
            continue
        try:
            content = target.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            errors.append(f"{normalized}: unreadable file: {exc}")
            continue
        if SECRET_LEAK_RE.search(content):
            errors.append(f"{normalized}: contains potential secret or credential token")
        match = MEMORY_VERIFICATION_RE.search(content)
        if not match:
            errors.append(
                f"{normalized}: missing required 'verification:' command or evidence basis"
            )
            continue
        value = match.group(1).strip().strip("`*").strip()
        if not value or value.lower() in PLACEHOLDER_VERIFICATION_VALUES:
            errors.append(
                f"{normalized}: 'verification:' must name a concrete verification command, not a placeholder"
            )
    return errors


def _is_non_empty_str(value: object) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _is_non_neg_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _is_pos_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def _is_finite_num(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _validate_unique_str_list(value: object, label: str, errors: list[str]) -> list[str]:
    if not isinstance(value, list):
        errors.append(f"{label} must be an array of strings")
        return []
    seen: set[str] = set()
    out: list[str] = []
    for idx, item in enumerate(value):
        if not _is_non_empty_str(item):
            errors.append(f"{label}[{idx}] must be a non-empty string")
            continue
        assert isinstance(item, str)
        if item in seen:
            errors.append(f"{label}[{idx}] duplicates {item!r}")
            continue
        seen.add(item)
        out.append(item)
    return out


def validate_sim_ledger_data(raw: object) -> list[str]:
    """Pure-Python structural validator for .omp/sim.json (works even without node_modules)."""
    errors: list[str] = []
    if not isinstance(raw, dict):
        return [f"{SIM_LEDGER_REL}: root must be a JSON object"]
    next_id = raw.get("next_id")
    if not _is_pos_int(next_id):
        errors.append(f"{SIM_LEDGER_REL}: next_id must be a positive integer")
    aliases = raw.get("aliases")
    if not isinstance(aliases, dict):
        errors.append(f"{SIM_LEDGER_REL}: aliases must be an object")
        aliases = {}
    problems = raw.get("problems")
    if not isinstance(problems, list):
        errors.append(f"{SIM_LEDGER_REL}: problems must be an array")
        return errors

    seen_ids: set[str] = set()
    max_num = 0
    for p_idx, problem in enumerate(problems):
        p_prefix = f"{SIM_LEDGER_REL}: problems[{p_idx}]"
        if not isinstance(problem, dict):
            errors.append(f"{p_prefix} must be an object")
            continue
        pid = problem.get("id")
        if not isinstance(pid, str) or not SIM_PROBLEM_ID_RE.match(pid):
            errors.append(f"{p_prefix}.id must match /^P[1-9][0-9]*$/")
        else:
            if pid in seen_ids:
                errors.append(f"{p_prefix}.id duplicates {pid!r}")
            seen_ids.add(pid)
            max_num = max(max_num, int(pid[1:]))
        if not _is_non_empty_str(problem.get("name")):
            errors.append(f"{p_prefix}.name must be a non-empty string")
        if not _is_pos_int(problem.get("opened_round")):
            errors.append(f"{p_prefix}.opened_round must be a positive integer")
        attempts = problem.get("attempts")
        if not isinstance(attempts, list) or len(attempts) == 0:
            errors.append(f"{p_prefix}.attempts must be a non-empty array")
            continue
        for a_idx, attempt in enumerate(attempts):
            a_prefix = f"{p_prefix}.attempts[{a_idx}]"
            if not isinstance(attempt, dict):
                errors.append(f"{a_prefix} must be an object")
                continue
            if not _is_pos_int(attempt.get("round")):
                errors.append(f"{a_prefix}.round must be a positive integer")
            if attempt.get("accepted") is not True:
                errors.append(f"{a_prefix}.accepted must be true")
            for field in ("what", "model", "domain", "benchmark"):
                if not _is_non_empty_str(attempt.get(field)):
                    errors.append(f"{a_prefix}.{field} must be a non-empty string")
            files_list = attempt.get("files")
            if not isinstance(files_list, list) or len(files_list) == 0 or not all(
                _is_non_empty_str(f) for f in files_list
            ):
                errors.append(f"{a_prefix}.files must be a non-empty array of strings")
            predicted = _validate_unique_str_list(attempt.get("predicted"), f"{a_prefix}.predicted", errors)
            fixed = _validate_unique_str_list(attempt.get("fixed"), f"{a_prefix}.fixed", errors)
            missed = _validate_unique_str_list(attempt.get("missed"), f"{a_prefix}.missed", errors)
            _validate_unique_str_list(attempt.get("regressed"), f"{a_prefix}.regressed", errors)
            preserved = (
                _validate_unique_str_list(attempt["preserved"], f"{a_prefix}.preserved", errors)
                if "preserved" in attempt
                else []
            )
            unproven = (
                _validate_unique_str_list(attempt["unproven"], f"{a_prefix}.unproven", errors)
                if "unproven" in attempt
                else []
            )
            incomplete = (
                _validate_unique_str_list(attempt["incomplete"], f"{a_prefix}.incomplete", errors)
                if "incomplete" in attempt
                else []
            )
            partition: dict[str, str] = {}
            predicted_set = set(predicted)
            for b_name, items in (
                ("fixed", fixed),
                ("missed", missed),
                ("preserved", preserved),
                ("unproven", unproven),
                ("incomplete", incomplete),
            ):
                for item in items:
                    if item in partition:
                        errors.append(f"{a_prefix}: {item!r} appears in both {partition[item]} and {b_name}")
                    else:
                        partition[item] = b_name
                    if item not in predicted_set:
                        errors.append(f"{a_prefix}.{b_name} contains {item!r} not in predicted")
            for item in predicted:
                if item not in partition:
                    errors.append(f"{a_prefix}.predicted contains {item!r} missing from outcome buckets")
            passed = attempt.get("passed")
            total = attempt.get("total")
            if not _is_non_neg_int(passed):
                errors.append(f"{a_prefix}.passed must be a non-negative integer")
            if not _is_non_neg_int(total):
                errors.append(f"{a_prefix}.total must be a non-negative integer")
            if _is_non_neg_int(passed) and _is_non_neg_int(total) and passed > total:
                errors.append(f"{a_prefix}.passed ({passed}) cannot exceed total ({total})")
            if "control_baseline" in attempt:
                cb = attempt["control_baseline"]
                cb_prefix = f"{a_prefix}.control_baseline"
                if not isinstance(cb, dict):
                    errors.append(f"{cb_prefix} must be an object")
                else:
                    extra = set(cb.keys()) - {
                        "baseline_type",
                        "baseline_score",
                        "candidate_score",
                        "delta",
                        "notes",
                    }
                    for key in sorted(extra):
                        errors.append(f"{cb_prefix}.{key} is not an allowed property")
                    btype = cb.get("baseline_type")
                    if not isinstance(btype, str) or btype not in SIM_BASELINE_TYPES:
                        errors.append(f"{cb_prefix}.baseline_type must be a valid baseline type")
                    bscore = cb.get("baseline_score")
                    cscore = cb.get("candidate_score")
                    delta = cb.get("delta")
                    if not _is_finite_num(bscore):
                        errors.append(f"{cb_prefix}.baseline_score must be a finite number")
                    if not _is_finite_num(cscore):
                        errors.append(f"{cb_prefix}.candidate_score must be a finite number")
                    if not _is_finite_num(delta):
                        errors.append(f"{cb_prefix}.delta must be a finite number")
                    if (
                        _is_finite_num(bscore)
                        and _is_finite_num(cscore)
                        and _is_finite_num(delta)
                        and abs((float(cscore) - float(bscore)) - float(delta)) > 1e-6
                    ):
                        errors.append(
                            f"{cb_prefix}.delta must equal candidate_score - baseline_score"
                        )
                    if "notes" in cb and not _is_non_empty_str(cb["notes"]):
                        errors.append(f"{cb_prefix}.notes must be a non-empty string")
            if "claim_evidence" in attempt:
                ce = attempt["claim_evidence"]
                ce_prefix = f"{a_prefix}.claim_evidence"
                if not isinstance(ce, dict):
                    errors.append(f"{ce_prefix} must be an object")
                else:
                    extra = set(ce.keys()) - {
                        "claims_verified",
                        "unsupported_claims",
                        "evidence_refs",
                    }
                    for key in sorted(extra):
                        errors.append(f"{ce_prefix}.{key} is not an allowed property")
                    if not _is_non_neg_int(ce.get("claims_verified")):
                        errors.append(f"{ce_prefix}.claims_verified must be a non-negative integer")
                    unsupported = ce.get("unsupported_claims")
                    if not _is_non_neg_int(unsupported):
                        errors.append(f"{ce_prefix}.unsupported_claims must be a non-negative integer")
                    elif attempt.get("accepted") is True and unsupported > 0:
                        errors.append(f"{ce_prefix}.unsupported_claims ({unsupported}) must be 0 on accepted attempts")
                    _validate_unique_str_list(ce.get("evidence_refs"), f"{ce_prefix}.evidence_refs", errors)

    for alias_key in aliases:
        if isinstance(alias_key, str) and SIM_PROBLEM_ID_RE.match(alias_key):
            max_num = max(max_num, int(alias_key[1:]))
    if _is_pos_int(next_id) and next_id <= max_num:
        errors.append(f"{SIM_LEDGER_REL}: next_id ({next_id}) must exceed max problem id P{max_num}")
    return errors


def check_sim_ledger(repo_root: Path, files: list[str]) -> list[str]:
    """Validate .omp/sim.json structurally whenever it is modified."""
    normalized_files = {name.replace("\\", "/").removeprefix("./") for name in files}
    if SIM_LEDGER_REL not in normalized_files:
        return []
    target = repo_root / SIM_LEDGER_REL
    if not target.is_file():
        return []
    try:
        raw = json.loads(target.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"{SIM_LEDGER_REL}: invalid JSON: {exc}"]
    return validate_sim_ledger_data(raw)


def run_memory_promotion_check(
    repo_root: Path,
    files: list[str] | None = None,
    strict_promotion: bool = False,
) -> PromotionReport:
    """Run memory-promotion analysis and return a typed report."""
    checked = collect_modified_files(repo_root, files)
    blocking = check_thin_wrappers(repo_root)
    blocking.extend(check_memory_entries(repo_root, checked))
    blocking.extend(check_sim_ledger(repo_root, checked))
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
