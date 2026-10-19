"""Harness2 BenchmarkAdapter with OMPK text-only, no-tool isolated rollouts.

The upstream proposer is NOT sandboxed here. Never run a real recursive
optimization without containing the upstream OpenCode/Claude editor separately.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from harness2.core.spec import BenchPrompts, BenchSpec, ChannelSpec
from harness2.core.tree import read_tree, write_tree
from harness2.substrate.opencode import OpencodeSubstrate

# Fixed small pilot: grader labels are never placed in task prompts or copied
# into the proposal context. Values are available only to score(), after selection.
TASKS = {
    "existing-proof": (
        "A previous session recorded a successful endpoint fix; a current health "
        "probe and the exact artifact hash agree. Choose REUSE, INVESTIGATE, "
        "or IMPLEMENT. Reply with one action only.",
        "REUSE",
    ),
    "stale-proof": (
        "An earlier agent said the endpoint was repaired, but the current probe "
        "fails and there is no deployment receipt. Choose REUSE, INVESTIGATE, "
        "or IMPLEMENT. Reply with one action only.",
        "INVESTIGATE",
    ),
    "missing-feature": (
        "The requested webhook does not exist in the code or deployment, and "
        "a new webhook is explicitly requested. Choose REUSE, INVESTIGATE, "
        "or IMPLEMENT. Reply with one action only.",
        "IMPLEMENT",
    ),
}
EDITABLE = frozenset({"systemprompt.md", "tool_descriptions/tool_guidance.md"})
FIXED = frozenset({"guardrails.md", "LongTermMEMORY.md"})
BASE = {
    "systemprompt.md": (
        "You are a bounded OMPK evidence router. Choose a single uppercase "
        "action: REUSE, INVESTIGATE, or IMPLEMENT. Prefer verified current "
        "evidence over past claims. Produce only the action.\n"
    ),
    "guardrails.md": "Read-only reasoning only. No execution, network, or delegation.\n",
    "LongTermMEMORY.md": "",
    "tool_descriptions/tool_guidance.md": "There are no tools in this rollout.\n",
}
ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def _digest(data: object) -> str:
    return hashlib.sha256(
        json.dumps(data, sort_keys=True, ensure_ascii=True).encode("utf-8")
    ).hexdigest()


class OmpkBenchmarkAdapter:
    """Upstream BenchmarkAdapter implementation, with no mutable authority."""

    def __init__(
        self,
        root: Path,
        *,
        binary: str = "omp",
        solver_model: str = "",
        improver_model: str = "local/deterministic",
        allow_execution: bool = False,
    ) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.binary = binary
        self.solver_model = solver_model
        self.allow_execution = allow_execution
        self.substrate = OpencodeSubstrate()  # Reuse Google's canonical tree validator.
        channel = ChannelSpec("opencode", improver_model)
        self.spec = BenchSpec(
            name="ompk",
            runs_root=self.root / "runs",
            install_mode="workspace_config",
            prompts=BenchPrompts(
                work="Choose the next safe action from the available operational evidence.",
                domain_word="operation",
                inv_levers="Separate verified receipts from guesses and missing evidence.",
                dom_levers="Give each operational state one unambiguous action.",
                yardstick="Prefer current evidence and avoid unnecessary duplicate work.",
            ),
            channels={"proposer": channel, "selector": channel},
            allow_subagents=False,
            leak_globs=("answers.json", "answer-key.json"),
        )
        base = self.base_harness()
        if not base.exists():
            write_tree(self.substrate.surface(), dict(BASE), base, stubs=False)
        self.validate_tree(read_tree(self.substrate.surface(), base))

    def tasks(self, split: str = "all") -> list[str]:
        if split == "all":
            return list(TASKS)
        if split == "train":
            return list(TASKS)[:2]
        if split == "test":
            return list(TASKS)[2:]
        raise ValueError("split must be all, train, or test")

    def domain_of(self, task_id: str) -> str:
        self.task_prompt(task_id)
        return "agent-operations"

    def task_prompt(self, task_id: str) -> str:
        if task_id not in TASKS:
            raise ValueError("unknown pilot task")
        return TASKS[task_id][0]

    def task_files(self, task_id: str) -> None:
        self.task_prompt(task_id)
        return None

    def base_harness(self) -> Path:
        return self.root / "base"

    def validate_tree(self, tree: dict[str, str]) -> None:
        problems = []
        for name in sorted(set(tree) - EDITABLE - FIXED):
            problems.append(f"{name}: pilot permits prompts and tool guidance only")
        for name in FIXED:
            if tree.get(name) != BASE[name]:
                problems.append(f"{name}: fixed OMPK authority text cannot be edited")
        for name in EDITABLE:
            value = tree.get(name)
            if not isinstance(value, str) or not value.strip():
                problems.append(f"{name}: nonempty text is required")
            elif len(value) > 12000:
                problems.append(f"{name}: exceeds 12000 characters")
        if problems:
            raise ValueError("; ".join(problems))

    def _read_candidate(self, directory: Path) -> dict[str, str]:
        source = directory.resolve(strict=True)
        if not source.is_dir():
            raise ValueError("harness is not a directory")
        allowed = set(EDITABLE | FIXED)
        stubs = dict(self.substrate.surface().stubs)
        # Upstream materialises documented README stubs by default. Accept
        # only their untouched canonical contents; never execute or load them.
        for entry in source.rglob("*"):
            if entry.is_symlink():
                raise ValueError("symlinks are forbidden in probe harnesses")
            if not entry.is_file():
                continue
            rel = entry.relative_to(source).as_posix()
            if rel in stubs:
                if entry.read_text(encoding="utf-8") != stubs[rel]:
                    raise ValueError(f"modified harness stub: {rel}")
            elif rel not in allowed:
                raise ValueError(f"unrecognized harness file: {rel}")
        tree = read_tree(self.substrate.surface(), source)
        self.validate_tree(tree)
        return tree

    def execute(
        self, task_id: str, harness_dir: Path | None, run_id: str, *,
        timeout: int | None = None,
    ) -> Path:
        self.task_prompt(task_id)
        if not self.allow_execution or os.environ.get("OMPK_HARNESS2_ENABLED") != "1":
            raise PermissionError("OMPK Harness2 disabled; set OMPK_HARNESS2_ENABLED=1 and opt into execution")
        if not self.solver_model.strip():
            raise ValueError("explicit solver_model required")
        if not self.binary.strip() or not shutil.which(self.binary):
            raise FileNotFoundError(f"OMPK binary not found: {self.binary}")
        source = Path(harness_dir) if harness_dir is not None else self.base_harness()
        tree = self._read_candidate(source)
        identity = {
            "run_id": run_id, "task_id": task_id, "model": self.solver_model,
            "harness_sha256": _digest(tree),
        }
        token = _digest({"run_id": run_id})[:24]
        run_dir = self.root / "executions" / token
        if run_dir.exists():
            receipt = run_dir / "receipt.json"
            if receipt.is_file() and json.loads(receipt.read_text()) == identity and (run_dir / "trajectory.md").is_file():
                return run_dir
            raise FileExistsError("Existing run has an incomplete or mismatched receipt; refusing replay")
        run_dir.mkdir(parents=True, exist_ok=False)
        workspace = run_dir / "workspace"
        workspace.mkdir()
        prompt_file = workspace / "pilot-harness.md"
        prompt_file.write_text("\n\n".join(tree[key] for key in self.substrate.surface().always_on), encoding="utf-8")
        wall = max(1, min(int(timeout or 90), 120))
        argv = [
            self.binary, "--print", "--mode=text", "--no-session", "--no-tools",
            "--no-lsp", "--no-pty", "--no-extensions", "--no-irc",
            "--no-skills", "--no-rules", "--agentmd-off", "--no-title",
            f"--profile=harness2-{token}", f"--cwd={workspace}",
            f"--append-system-prompt={prompt_file}", f"--model={self.solver_model}",
            f"--max-time={wall}", self.task_prompt(task_id),
        ]
        result_text = ""
        error = ""
        try:
            result = subprocess.run(
                argv, cwd=workspace, capture_output=True, text=True,
                timeout=wall + 10, check=False,
            )
            result_text = result.stdout.strip()[:64000]
            if result.returncode:
                error = f"OMPK exited {result.returncode}: {result.stderr[-2000:]}"
        except subprocess.TimeoutExpired:
            error = "OMPK rollout timed out"
        if result_text and not error:
            (run_dir / "answer.txt").write_text(result_text + "\n", encoding="utf-8")
        observation = result_text[:10000] if result_text else "(empty)"
        trace = "[ACTION] OMPK no-tools prompt rollout\n[OBSERVATION]\n" + observation
        if error:
            trace += "\n[ERROR]\n" + error[:2500]
        (run_dir / "trajectory.md").write_text(trace + "\n", encoding="utf-8")
        (run_dir / "receipt.json").write_text(json.dumps(identity, sort_keys=True), encoding="utf-8")
        return run_dir

    def delivered(self, run_dir: Path) -> bool:
        return (Path(run_dir) / "answer.txt").is_file()

    def trajectory(self, run_dir: Path, *, obs_trunc: int) -> str:
        return (Path(run_dir) / "trajectory.md").read_text(encoding="utf-8")[:obs_trunc]

    def deliverable_text(self, run_dir: Path) -> str:
        path = Path(run_dir) / "answer.txt"
        return path.read_text(encoding="utf-8") if path.is_file() else ""

    def deliverable_files(self, run_dir: Path) -> dict[str, str]:
        text = self.deliverable_text(run_dir)
        return {"answer.txt": text} if text else {}

    def score(self, run_dir: Path, task_id: str) -> dict:
        expected = TASKS[task_id][1]
        correct = self.deliverable_text(run_dir).strip() == expected
        return {"n_passed": int(correct), "n_criteria": 1, "all_pass": correct}
