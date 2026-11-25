#!/usr/bin/env python3
"""Deterministic repository-state grader for ACP Tier 3 evaluations."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


def _env_path(name: str, default: str | Path) -> Path:
    return Path(os.environ.get(name, str(default)))


def _git(repo: Path, *args: str) -> tuple[int, str]:
    proc = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=False)
    return proc.returncode, (proc.stdout or "").strip()


def _find_work_repo(workspace: Path) -> Path | None:
    direct = [
        workspace / "work-repo",
        workspace / "input" / "work-repo",
        Path("/workspace/work-repo"),
        Path("/workspace/input/work-repo"),
    ]
    for candidate in direct:
        if (candidate / ".git").exists():
            return candidate
    if workspace.is_dir():
        for hit in workspace.rglob("work-repo"):
            if (hit / ".git").exists():
                return hit
    return None


def _grade_case_001(workspace: Path) -> tuple[float, dict[str, object]]:
    work_repo = _find_work_repo(workspace)
    if work_repo is None:
        return 0.0, {"passed": False, "reason": "work-repo was not initialized"}
    remote_repo = Path(f"{work_repo}-origin.git")
    if not remote_repo.exists():
        return 0.0, {"passed": False, "reason": "bare remote work-repo-origin.git missing"}

    rc_cnt, cnt_str = _git(remote_repo, "rev-list", "--count", "main")
    commit_count = int(cnt_str) if rc_cnt == 0 and cnt_str.isdigit() else 0
    _, tree_files = _git(remote_repo, "ls-tree", "-r", "--name-only", "main")
    _, parser_blob = _git(remote_repo, "show", "main:src/parser.py")
    _, subject = _git(remote_repo, "log", "-1", "--format=%s", "main")
    _, status_out = _git(work_repo, "status", "--porcelain", "-uall")

    pushed_new_commit = commit_count >= 2
    parser_updated = "part.strip()" in parser_blob
    scratch_not_pushed = "scratch/debug.txt" not in tree_files.splitlines()
    scratch_preserved = (work_repo / "scratch" / "debug.txt").is_file() and any(
        "scratch/debug.txt" in line and line.startswith("??") for line in status_out.splitlines()
    )

    checks = [pushed_new_commit, parser_updated, scratch_not_pushed, scratch_preserved]
    score = round(sum(1 for ok in checks if ok) / len(checks), 4)
    return score, {
        "passed": all(checks),
        "remote_commit_count": commit_count,
        "latest_subject": subject,
        "parser_updated_on_origin": parser_updated,
        "scratch_excluded_from_origin": scratch_not_pushed,
        "scratch_untracked_in_worktree": scratch_preserved,
    }


def main() -> None:
    tests_dir = _env_path("HARBOR_TESTS_DIR", "/tests")
    logs_dir = _env_path("HARBOR_LOGS_DIR", "/logs")
    verifier_dir = _env_path("HARBOR_VERIFIER_DIR", logs_dir / "verifier")
    reward_json = _env_path("HARBOR_REWARD_JSON", verifier_dir / "reward.json")
    reward_txt = _env_path("HARBOR_REWARD_TXT", verifier_dir / "reward.txt")
    workspace = _env_path("HARBOR_WORKSPACE_DIR", "/workspace")

    entry_path = tests_dir / "entry.json"
    entry = json.loads(entry_path.read_text(encoding="utf-8")) if entry_path.is_file() else {}
    entry_id = str(entry.get("id", ""))

    verifier_dir.mkdir(parents=True, exist_ok=True)

    if entry_id == "acp-001-explicit-slash":
        git_score, git_details = _grade_case_001(workspace)
        payload: dict[str, object] = {
            "custom_metrics": {"git_remote_state": git_score},
            "details": {"git_remote_state": git_details},
        }
        reward_json.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        reward_txt.write_text(f"{git_score}\n", encoding="utf-8")
    else:
        # Omit custom metric on non-fixture cases so unverified cases never inflate averages.
        reward_json.write_text(json.dumps({"custom_metrics": {}}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
