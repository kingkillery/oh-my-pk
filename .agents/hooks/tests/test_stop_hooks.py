"""Automated unit and integration tests for stop hooks."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
HOOKS_DIR = REPO_ROOT / ".agents" / "hooks"
POLYGLOT_REL_POSIX = ".agents/scripts/run_packman_python.cmd"
POLYGLOT_REL_WIN = r".agents\scripts\run_packman_python.cmd"
TOKF_PATH = REPO_ROOT / ".tokf"

if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

from check_completion_gates import run_completion_gates
from check_memory_promotion import run_memory_promotion_check


def _run_bash_polyglot(extra_args: list[str]) -> subprocess.CompletedProcess[str]:
    """Run the polyglot shim through bash with args."""
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash not available")
    return subprocess.run(
        [bash, POLYGLOT_REL_POSIX, *extra_args],
        check=False, cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=60,
    )


def _run_cmd_polyglot(extra_args: list[str]) -> subprocess.CompletedProcess[str]:
    """Run the polyglot shim through cmd.exe with args."""
    cmd = shutil.which("cmd.exe") or shutil.which("cmd")
    if cmd is None:
        pytest.skip("cmd.exe not available")
    return subprocess.run(
        [cmd, "/c", POLYGLOT_REL_WIN, *extra_args],
        check=False, cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=60,
    )


def _run_stop_checks(
    repo_root: Path,
    files: list[str],
    payload: dict[str, object],
    extra_args: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Invoke run_stop_checks.py with a JSON payload on stdin."""
    command = [
        sys.executable,
        str(HOOKS_DIR / "run_stop_checks.py"),
        "--repo-root",
        str(repo_root),
        "--files",
        *files,
    ]
    if extra_args:
        command.extend(extra_args)
    return subprocess.run(
        command,
        check=False, input=json.dumps(payload),
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_polyglot_bash_prints_version() -> None:
    """bash polyglot must print the Python version tuple and exit 0."""
    proc = _run_bash_polyglot(["-c", "import sys; print(sys.version_info[:2])"])
    assert proc.returncode == 0, proc.stderr
    assert "(3," in proc.stdout


def test_polyglot_bash_propagates_nonzero_exit() -> None:
    """bash polyglot must preserve non-zero exit codes."""
    proc = _run_bash_polyglot(["-c", "import sys; sys.exit(7)"])
    assert proc.returncode == 7


def test_polyglot_sh_prints_version() -> None:
    """sh polyglot must print the Python version tuple."""
    sh = shutil.which("sh")
    if sh is None:
        pytest.skip("sh not available")
    proc = subprocess.run(
        [sh, POLYGLOT_REL_POSIX, "-c", "import sys; print(sys.version_info[:2])"],
        check=False, cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert "(3," in proc.stdout


def test_polyglot_cmd_prints_version() -> None:
    """cmd.exe polyglot must print the Python version tuple and exit 0."""
    proc = _run_cmd_polyglot(["-c", "import sys; print(sys.version_info[:2])"])
    assert proc.returncode == 0, proc.stderr
    assert "(3," in proc.stdout


def test_polyglot_cmd_propagates_nonzero_exit() -> None:
    """cmd.exe polyglot must preserve non-zero exit codes."""
    proc = _run_cmd_polyglot(["-c", "import sys; sys.exit(7)"])
    assert proc.returncode == 7


def test_completion_gates_valid_python_passes(tmp_path: Path) -> None:
    """A syntactically valid file must pass completion gates."""
    good = tmp_path / "good.py"
    good.write_text("VALUE = 1\n", encoding="utf-8")
    report = run_completion_gates(tmp_path, files=["good.py"])
    assert report.ok is True
    assert report.errors == ()


def test_completion_gates_syntax_error_reports_line(tmp_path: Path) -> None:
    """A broken file must fail with the exact file and line anchor."""
    bad = tmp_path / "bad.py"
    bad.write_text("def broken(:\n    pass\n", encoding="utf-8")
    report = run_completion_gates(tmp_path, files=["bad.py"])
    assert report.ok is False
    assert any("bad.py" in error for error in report.errors)
    assert any("SyntaxError" in error for error in report.errors)
    joined = "\n".join(report.errors)
    assert "bad.py:1:" in joined or "bad.py:2:" in joined


def test_completion_gates_conflict_marker_fails(tmp_path: Path) -> None:
    """Trailing conflict markers must fail completion gates."""
    bad = tmp_path / "conflict.py"
    bad.write_text("VALUE = 1\n<<<<<<< HEAD\nOTHER = 2\n", encoding="utf-8")
    report = run_completion_gates(tmp_path, files=["conflict.py"])
    assert report.ok is False
    assert any("conflict.py" in error for error in report.errors)


def test_completion_gates_windsurf_budget_fails(tmp_path: Path) -> None:
    """A Windsurf rule file over 6000 chars must fail."""
    rule_dir = tmp_path / ".windsurf" / "rules"
    rule_dir.mkdir(parents=True, exist_ok=True)
    (rule_dir / "project.md").write_text("x" * 6001, encoding="utf-8")
    good = tmp_path / "good.py"
    good.write_text("VALUE = 1\n", encoding="utf-8")
    report = run_completion_gates(tmp_path, files=["good.py"])
    assert report.ok is False
    assert any("6000" in error for error in report.errors)


def test_completion_gates_windsurf_within_budget_passes(tmp_path: Path) -> None:
    """A Windsurf rule file within budget must pass."""
    rule_dir = tmp_path / ".windsurf" / "rules"
    rule_dir.mkdir(parents=True, exist_ok=True)
    (rule_dir / "project.md").write_text("x" * 5000, encoding="utf-8")
    good = tmp_path / "good.py"
    good.write_text("VALUE = 1\n", encoding="utf-8")
    report = run_completion_gates(tmp_path, files=["good.py"])
    assert report.ok is True


def test_memory_valid_thin_claude_passes(tmp_path: Path) -> None:
    """A thin CLAUDE.md with the canonical ref must pass."""
    claude = tmp_path / "CLAUDE.md"
    claude.write_text("# Claude\n\nSee .agents/instructions.md\n", encoding="utf-8")
    report = run_memory_promotion_check(tmp_path, files=["CLAUDE.md"])
    assert report.ok is True
    assert report.errors == ()


def test_memory_broken_claude_missing_ref_fails(tmp_path: Path) -> None:
    """A CLAUDE.md without the canonical ref must fail."""
    claude = tmp_path / "CLAUDE.md"
    claude.write_text("# Claude\n\nNo reference here.\n", encoding="utf-8")
    report = run_memory_promotion_check(tmp_path, files=["CLAUDE.md"])
    assert report.ok is False
    assert any("CLAUDE.md" in error for error in report.errors)


def test_memory_thin_wrapper_size_cap_fails(tmp_path: Path) -> None:
    """A wrapper over the size cap must fail."""
    gemini = tmp_path / "GEMINI.md"
    gemini.write_text(".agents/instructions.md\n" + "x" * 3000, encoding="utf-8")
    report = run_memory_promotion_check(tmp_path, files=["GEMINI.md"])
    assert report.ok is False
    assert any("GEMINI.md" in error for error in report.errors)


def test_memory_arch_change_emits_advisory(tmp_path: Path) -> None:
    """An architectural change without promotion emits an advisory."""
    report = run_memory_promotion_check(
        tmp_path, files=["packages/coding-agent/src/foo.py"]
    )
    assert report.ok is True
    assert len(report.advisories) > 0


def test_memory_arch_change_blocks_when_strict(tmp_path: Path) -> None:
    """Strict promotion turns advisories into blocking failures."""
    report = run_memory_promotion_check(
        tmp_path,
        files=["packages/coding-agent/src/foo.py"],
        strict_promotion=True,
    )
    assert report.ok is False


def test_memory_promotion_satisfied_by_context_update(tmp_path: Path) -> None:
    """A context update satisfies the promotion check."""
    report = run_memory_promotion_check(
        tmp_path,
        files=["packages/coding-agent/src/foo.py", ".agents/context/foo.md"],
    )
    assert report.advisories == ()
    assert report.ok is True


def test_stop_checks_claude_first_failure_repairs(tmp_path: Path) -> None:
    """First Claude failure must exit 2 and emit a block repair payload."""
    bad = tmp_path / "bad.py"
    bad.write_text("def broken(:\n    pass\n", encoding="utf-8")
    proc = _run_stop_checks(
        tmp_path,
        ["bad.py"],
        {"stop_hook_active": False, "hook_event_name": "Stop"},
    )
    assert proc.returncode == 2, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    data = json.loads(proc.stdout)
    assert data["stop_hook_active"] is False
    assert data["decision"] == "block"
    assert isinstance(data["reason"], str) and data["reason"].strip() != ""
    assert "bad.py" in data["reason"]
    assert proc.stderr.strip() != ""


def test_stop_checks_claude_second_failure_halts(tmp_path: Path) -> None:
    """Second Claude failure must halt with one guidance question."""
    bad = tmp_path / "bad.py"
    bad.write_text("def broken(:\n    pass\n", encoding="utf-8")
    proc = _run_stop_checks(
        tmp_path,
        ["bad.py"],
        {"stop_hook_active": True, "hook_event_name": "Stop"},
    )
    assert proc.returncode == 0, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    data = json.loads(proc.stdout)
    assert data["continue"] is False
    assert data["stop_hook_active"] is False
    assert data["stopReason"] == "Stop-hook validation failed after 1 automatic repair turn"
    message = str(data["systemMessage"])
    assert "bad.py" in message
    assert message.strip().endswith("?")
    assert message.count("?") == 1


def test_stop_checks_cursor_first_failure_followup(tmp_path: Path) -> None:
    """First Cursor failure must emit a non-empty followup message."""
    bad = tmp_path / "bad.py"
    bad.write_text("def broken(:\n    pass\n", encoding="utf-8")
    proc = _run_stop_checks(
        tmp_path,
        ["bad.py"],
        {"loop_count": 0, "status": "completed"},
    )
    assert proc.returncode == 0, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    data = json.loads(proc.stdout)
    assert "followup_message" in data
    followup = str(data["followup_message"])
    assert followup.strip() != ""
    assert "bad.py" in followup


def test_stop_checks_cursor_second_failure_halts(tmp_path: Path) -> None:
    """Second Cursor failure must emit {} plus diagnostics on stderr."""
    bad = tmp_path / "bad.py"
    bad.write_text("def broken(:\n    pass\n", encoding="utf-8")
    proc = _run_stop_checks(
        tmp_path,
        ["bad.py"],
        {"loop_count": 1, "status": "completed"},
    )
    assert proc.returncode == 0, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    data = json.loads(proc.stdout)
    assert data == {}
    assert "bad.py" in proc.stderr
    assert proc.stderr.strip().endswith("?")
    assert proc.stderr.strip().count("?") == 1


def test_stop_checks_pass_claude(tmp_path: Path) -> None:
    """All passing checks must emit the Claude clean-pass payload."""
    good = tmp_path / "good.py"
    good.write_text("VALUE = 1\n", encoding="utf-8")
    proc = _run_stop_checks(
        tmp_path,
        ["good.py"],
        {"stop_hook_active": False, "hook_event_name": "Stop"},
    )
    assert proc.returncode == 0, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    data = json.loads(proc.stdout)
    assert data["continue"] is True
    assert data["stop_hook_active"] is False


def test_stop_checks_pass_cursor(tmp_path: Path) -> None:
    """All passing checks must emit {} for Cursor."""
    good = tmp_path / "good.py"
    good.write_text("VALUE = 1\n", encoding="utf-8")
    proc = _run_stop_checks(
        tmp_path,
        ["good.py"],
        {"loop_count": 0, "status": "completed"},
    )
    assert proc.returncode == 0, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    data = json.loads(proc.stdout)
    assert data == {}


def test_tokf_parses_and_covers_targets() -> None:
    """The .tokf file must parse and cover all required targets."""
    assert TOKF_PATH.is_file(), ".tokf must exist at repo root"
    text = TOKF_PATH.read_text(encoding="utf-8")
    parsed = tomllib.loads(text)
    assert isinstance(parsed, dict)
    required = [
        "make",
        "build.bat",
        "build_docs.bat",
        "format_code.bat",
        "lint_code.bat",
        "repo.bat",
        "repo.bat build",
        "repo.bat test",
        "repo.bat lint",
        "repo.bat format",
        "repo.bat docs",
        "bun test",
        "bun check",
        "cargo test",
        "pytest",
        "tokf raw last",
    ]
    for entry in required:
        assert entry in text, f".tokf missing required target {entry!r}"
    lowered = text.lower()
    assert "kit" in lowered, ".tokf missing Kit tests target"
    assert "toolkit" in lowered, ".tokf missing Toolkit app BAT target"
    serialized = json.dumps(parsed).lower()
    for token in ("bearer", "api", "token", "password", "user", "secret"):
        assert token in serialized or token in lowered, (
            f".tokf missing credential scrubbing for {token!r}"
        )
    assert "user:pass@" in text, ".tokf missing user:pass@ scrubbing rule"
