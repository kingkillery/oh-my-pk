"""Explicitly gated OMPK Harness2 pilot."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .adapter import OmpkBenchmarkAdapter


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=("check", "run"))
    p.add_argument("--output", type=Path, default=Path("runs/harness2-ompk"))
    p.add_argument("--binary", default="omp")
    p.add_argument("--solver-model", default="")
    p.add_argument("--improver-model", default="")
    p.add_argument("--execute", action="store_true")
    p.add_argument("--unsafe-upstream-proposer-ack", action="store_true")
    args = p.parse_args(argv)
    if args.action == "run":
        if not args.execute or os.environ.get("OMPK_HARNESS2_ENABLED") != "1":
            p.error("run requires --execute and OMPK_HARNESS2_ENABLED=1")
        if not args.unsafe_upstream_proposer_ack:
            p.error("Upstream proposer may have network/shell access; explicit --unsafe-upstream-proposer-ack required after external containment")
        if not args.solver_model or not args.improver_model:
            p.error("run requires --solver-model and --improver-model")
    adapter = OmpkBenchmarkAdapter(
        args.output, binary=args.binary, solver_model=args.solver_model,
        improver_model=args.improver_model or "local/deterministic",
        allow_execution=args.action == "run" and args.execute,
    )
    if args.action == "check":
        print(json.dumps({
            "enabled": False, "upstream_protocol": True,
            "tasks": adapter.tasks(), "editable": [
                "systemprompt.md", "tool_descriptions/tool_guidance.md"
            ], "base_harness": str(adapter.base_harness()),
        }, indent=2))
        return 0

    from harness2.core.proposer import Proposer
    from harness2.core.schedule import run_domain

    proposer = Proposer(adapter.spec.channels["proposer"])
    result = run_domain(
        "agent-operations", adapter.tasks("train")[:1], 1,
        adapter=adapter, prop=proposer, runs_root=adapter.spec.runs_root,
        library_root=adapter.root / "library", modes=("agg",),
    )
    print(json.dumps(result, indent=2, default=str))
    return int(result.get("failed", 0) > 0)


if __name__ == "__main__":
    raise SystemExit(main())
