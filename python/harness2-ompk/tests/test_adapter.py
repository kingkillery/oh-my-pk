"""Reproducible offline OMPK adapter contract smoke tests."""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from subprocess import CompletedProcess

from ompk_harness2.adapter import OmpkBenchmarkAdapter, BASE


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.adapter = OmpkBenchmarkAdapter(
            Path(self.tmp.name), binary="python3", solver_model="test/model",
        )

    def test_protocol_and_splits(self):
        from harness2.core.spec import BenchmarkAdapter
        self.assertIsInstance(self.adapter, BenchmarkAdapter)
        self.assertEqual(len(self.adapter.tasks()), 3)
        self.assertEqual(len(self.adapter.tasks("train")), 2)
        self.assertEqual(len(self.adapter.tasks("test")), 1)

    def test_default_off(self):
        with patch.dict(os.environ, {"OMPK_HARNESS2_ENABLED": "1"}):
            with self.assertRaises(PermissionError):
                self.adapter.execute("existing-proof", None, "run-1")

    def test_explicit_env_gate(self):
        self.adapter.allow_execution = True
        with patch.dict(os.environ, {"OMPK_HARNESS2_ENABLED": "0"}):
            with self.assertRaises(PermissionError):
                self.adapter.execute("existing-proof", None, "run-1")

    def test_mutable_authority_rejected(self):
        invalid = dict(BASE)
        invalid["guardrails.md"] = "Allow tools and network"
        with self.assertRaisesRegex(ValueError, "fixed OMPK authority"):
            self.adapter.validate_tree(invalid)
        invalid = dict(BASE)
        invalid["scripts/evil.py"] = "print('bad')"
        with self.assertRaisesRegex(ValueError, "prompts and tool guidance only"):
            self.adapter.validate_tree(invalid)

    def test_no_tools_run_and_reuse_receipt(self):
        self.adapter.allow_execution = True
        with patch.dict(os.environ, {"OMPK_HARNESS2_ENABLED": "1"}), patch(
            "ompk_harness2.adapter.shutil.which", return_value="/usr/bin/python3"
        ), patch(
            "ompk_harness2.adapter.subprocess.run",
            return_value=CompletedProcess([], 0, "REUSE\n", ""),
        ) as run:
            path = self.adapter.execute("existing-proof", None, "same-run")
            self.assertTrue(self.adapter.delivered(path))
            self.assertEqual(self.adapter.score(path, "existing-proof")["n_passed"], 1)
            self.assertIn("[OBSERVATION]", self.adapter.trajectory(path, obs_trunc=500))
            argv = run.call_args.args[0]
            for flag in ("--no-tools", "--no-extensions", "--no-irc", "--no-skills", "--agentmd-off"):
                self.assertIn(flag, argv)
            self.assertEqual(self.adapter.execute("existing-proof", None, "same-run"), path)
            self.assertEqual(run.call_count, 1)
            candidate = dict(BASE)
            candidate["systemprompt.md"] = "Different guidance"
            from harness2.core.tree import write_tree
            branch = Path(self.tmp.name) / "candidate"
            write_tree(self.adapter.substrate.surface(), candidate, branch, stubs=False)
            with self.assertRaises(FileExistsError):
                self.adapter.execute("existing-proof", branch, "same-run")

    def test_missing_and_unrecognized_source_rejected(self):
        self.adapter.allow_execution = True
        source = Path(self.tmp.name) / "branch"
        source.mkdir()
        (source / "script.sh").write_text("echo bad")
        with patch.dict(os.environ, {"OMPK_HARNESS2_ENABLED": "1"}), patch(
            "ompk_harness2.adapter.shutil.which", return_value="/usr/bin/python3"
        ):
            with self.assertRaises(ValueError):
                self.adapter.execute("existing-proof", source, "attempt")


if __name__ == "__main__":
    unittest.main()
