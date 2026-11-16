"""Stop-hook continuation runner and validation gates.

Reads a hook JSON payload on stdin (when piped) and runs
``check_completion_gates`` plus ``check_memory_promotion``. Supports
Claude/Codex and Cursor contracts with a bounded one-turn repair
budget (MAX_AUTO_REPAIRS = 1) tracked via payload fields and an
optional state-file fallback keyed by session id.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

try:
    from .check_completion_gates import GateReport, run_completion_gates
    from .check_memory_promotion import PromotionReport, run_memory_promotion_check
except ImportError:  # Running as a bare script file.
    from check_completion_gates import GateReport, run_completion_gates
    from check_memory_promotion import PromotionReport, run_memory_promotion_check

MAX_AUTO_REPAIRS = 1
HALT_STOP_REASON = "Stop-hook validation failed after 1 automatic repair turn"
STATE_ENV_VAR = "STOP_HOOK_STATE_FILE"


def load_payload() -> dict[str, Any]:
    """Load the hook JSON payload from stdin when piped."""
    try:
        is_tty = sys.stdin.isatty()
    except (AttributeError, OSError, ValueError):
        is_tty = True
    if is_tty:
        return {}
    try:
        raw = sys.stdin.read()
    except (OSError, ValueError):
        return {}
    if raw is None:
        return {}
    text = raw.strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return dict(parsed)


def detect_agent(payload: dict[str, Any], requested: str) -> str:
    """Resolve the effective agent mode: "claude" or "cursor"."""
    if requested == "cursor":
        return "cursor"
    if requested in ("claude", "codex"):
        return "claude"
    if "loop_count" in payload or "status" in payload:
        return "cursor"
    if "stop_hook_active" in payload or "hook_event_name" in payload:
        return "claude"
    return "claude"


def payload_repair_exhausted(payload: dict[str, Any]) -> bool:
    """Return True when payload fields mark the repair budget spent."""
    if payload.get("stop_hook_active") is True:
        return True
    loop_count = payload.get("loop_count")
    return isinstance(loop_count, int) and loop_count >= MAX_AUTO_REPAIRS


def state_key(payload: dict[str, Any]) -> str | None:
    """Extract the session identity used for the state-file fallback."""
    for field in ("session_id", "transcript_path", "sessionId", "transcriptPath"):
        value = payload.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def load_state(state_path: Path | None, key: str | None) -> dict[str, Any]:
    """Load repair-attempt state for one session key."""
    if state_path is None or key is None or not state_path.is_file():
        return {}
    try:
        parsed = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    entry = parsed.get(key)
    if isinstance(entry, dict):
        return entry
    if isinstance(entry, int):
        return {"repair_attempts": entry}
    return {}


def state_repair_exhausted(state_path: Path | None, key: str | None) -> bool:
    """Return True when the state file records a spent repair attempt."""
    entry = load_state(state_path, key)
    if not entry:
        return False
    attempts = entry.get("repair_attempts", 0)
    if isinstance(attempts, int) and attempts >= MAX_AUTO_REPAIRS:
        return True
    return entry.get("repair_used") is True


def record_repair_used(state_path: Path | None, key: str | None) -> None:
    """Persist a spent repair attempt for this session key."""
    if state_path is None or key is None:
        return
    data: dict[str, Any] = {}
    if state_path.is_file():
        try:
            parsed = json.loads(state_path.read_text(encoding="utf-8"))
            if isinstance(parsed, dict):
                data = dict(parsed)
        except (OSError, json.JSONDecodeError):
            data = {}
    data[key] = {"repair_attempts": MAX_AUTO_REPAIRS, "repair_used": True}
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except OSError:
        pass


def collect_blocking(
    gate: GateReport, promotion: PromotionReport, strict: bool
) -> list[str]:
    """Collect blocking failure messages from both gate reports."""
    problems: list[str] = []
    problems.extend(gate.errors)
    problems.extend(promotion.errors)
    if strict:
        problems.extend(promotion.advisories)
    elif not promotion.ok:
        problems.append("memory promotion check failed")
    return problems


def first_target(problems: list[str]) -> str:
    """Return the first failing file target for guidance questions."""
    if not problems:
        return "the reported files"
    first = problems[0].split(":", 1)[0].strip()
    if first.endswith(".py") or "/" in first or "\\" in first:
        return first
    return first or "the reported files"


def build_repair_reason(problems: list[str]) -> str:
    """Build diagnostics plus one-turn repair instructions."""
    lines: list[str] = []
    lines.append("Stop-hook validation failed.")
    lines.append("Failing checks:")
    for problem in problems:
        lines.append(f"- {problem}")
    lines.append("")
    lines.append(
        "Repair required: fix each failing check, then continue. "
        "Only one automatic repair turn is granted before halting."
    )
    return "\n".join(lines)


def build_followup_message(problems: list[str]) -> str:
    """Build the Cursor followup prompt for a first failure."""
    lines: list[str] = []
    lines.append("Stop-hook validation failed.")
    lines.append("Failing checks:")
    for problem in problems:
        lines.append(f"- {problem}")
    lines.append("")
    lines.append(
        "Repair within this one granted turn: fix each failing check "
        "and re-run validation before finishing."
    )
    return "\n".join(lines)


def build_halt_message(problems: list[str]) -> str:
    """Build the halt message ending with one concrete guidance question."""
    lines: list[str] = []
    lines.append("Stop-hook validation failed after 1 automatic repair turn.")
    lines.append("Failing checks:")
    for problem in problems:
        lines.append(f"- {problem}")
    lines.append("")
    lines.append(
        "Automatic repair budget is exhausted at 1 attempt so "
        "continuation is halting instead of looping."
    )
    target = first_target(problems)
    lines.append(
        f"Please confirm whether to fix {target} or proceed without changes"
    )
    return "\n".join(lines) + "?"


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI argument parser."""
    parser = argparse.ArgumentParser(description="Run stop-hook checks.")
    parser.add_argument(
        "--agent",
        choices=["auto", "claude", "codex", "cursor"],
        default="auto",
        help="Hook agent contract (default: auto-detect).",
    )
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
        "--strict-promotion",
        action="store_true",
        help="Treat promotion advisories as blocking failures.",
    )
    parser.add_argument(
        "--state-file",
        type=Path,
        default=None,
        help="Optional state file for the repair-budget fallback.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run validation and emit the agent-contract response."""
    args = build_parser().parse_args(argv)
    repo_root = args.repo_root.resolve() if args.repo_root is not None else Path.cwd()
    files = list(args.files) if args.files is not None else None
    payload = load_payload()
    agent = detect_agent(payload, str(args.agent))
    state_path: Path | None = args.state_file
    if state_path is None:
        env_value = os.environ.get(STATE_ENV_VAR, "").strip()
        if env_value:
            state_path = Path(env_value)
    key = state_key(payload)
    gate = run_completion_gates(repo_root, files=files)
    promotion = run_memory_promotion_check(
        repo_root,
        files=files,
        strict_promotion=bool(args.strict_promotion),
    )
    problems = collect_blocking(gate, promotion, bool(args.strict_promotion))
    if not problems:
        if agent == "cursor":
            print("{}")
        else:
            print(json.dumps({"continue": True, "stop_hook_active": False}))
        return 0
    exhausted = payload_repair_exhausted(payload) or state_repair_exhausted(
        state_path, key
    )
    if not exhausted:
        record_repair_used(state_path, key)
        if agent == "cursor":
            status = payload.get("status")
            if "status" in payload and status != "completed":
                print("{}")
                return 0
            followup = build_followup_message(problems)
            print(json.dumps({"followup_message": followup}))
            return 0
        reason = build_repair_reason(problems)
        print(json.dumps({"stop_hook_active": False, "decision": "block", "reason": reason}))
        print(reason, file=sys.stderr)
        return 2
    halt = build_halt_message(problems)
    if agent == "cursor":
        print("{}")
        print(halt, file=sys.stderr)
        return 0
    print(
        json.dumps(
            {
                "continue": False,
                "stop_hook_active": False,
                "stopReason": HALT_STOP_REASON,
                "systemMessage": halt,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
