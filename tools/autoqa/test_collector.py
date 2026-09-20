#!/usr/bin/env python3
"""Focused tests for the OMPK autoqa collector.

Run: python3 tools/autoqa/test_collector.py
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import collector  # noqa: E402


def test_classification_groups_related_reports() -> None:
    a = collector.classify(
        "read returned the wrong file contents for concurrent requests; results were swapped"
    )
    b = collector.classify(
        "concurrent artifact reads produced wrong output attributed to another request"
    )
    assert a.group_id == "result-attribution", a
    assert b.group_id == "result-attribution", b
    assert a.fingerprint != b.fingerprint  # different wording → different variants, same group


def test_noise_is_filtered() -> None:
    assert collector.classify("test smoke test ignore").noise
    assert not collector.classify("read returned wrong file contents for concurrent requests").noise


def test_dedup_exact_repeat() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        conn = collector.connect(Path(tmp) / "c.db")
        try:
            payload = {"tool": "read", "report": "read returned wrong file contents for concurrent requests", "model": "m", "version": "1.0.0"}
            id1, ins1 = collector.insert_report(conn, payload, "test")
            id2, ins2 = collector.insert_report(conn, payload, "test")
            assert ins1 and not ins2 and id1 == id2
            assert conn.execute("SELECT COUNT(*) c FROM reports").fetchone()["c"] == 1
        finally:
            conn.close()


def test_triage_ranks_impact_and_publishes_top_n() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        conn = collector.connect(tmp_path / "c.db")
        try:
            # Seed one high-impact and one low-impact group.
            collector.insert_report(conn, {"tool": "edit", "report": "edit accepts stale anchor and modifies unintended shifted code"}, "t")
            collector.insert_report(conn, {"tool": "read", "report": "vault search fails unsupported on Windows"}, "t")
            config = collector.CollectorConfig(
                bind="127.0.0.1", port=0, db_path=tmp_path / "c.db",
                state_path=tmp_path / "s.json", token_file=tmp_path / "tok",
                published_path=tmp_path / "pub.json", github_repo="x/y",
                issue_limit=1, dry_run=True,
            )
            selected = collector.triage(conn, config)
            assert len(selected) == 1
            assert selected[0]["group_id"] == "edit-anchor-safety"
            assert selected[0]["issue_url"].startswith("dry-run:")
        finally:
            conn.close()


def test_http_intake_and_status() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        token_file = tmp_path / "tok"
        token_file.write_text("secret-token\n")
        config = collector.CollectorConfig(
            bind="127.0.0.1", port=0, db_path=tmp_path / "c.db",
            state_path=tmp_path / "s.json", token_file=token_file,
            published_path=tmp_path / "pub.json", github_repo="x/y",
            issue_limit=10, dry_run=True,
        )
        server = collector.CollectorServer(("127.0.0.1", 0), config)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{port}"
            # Unauthorized rejected.
            req = urllib.request.Request(f"{base}/status")
            try:
                urllib.request.urlopen(req, timeout=5)
                raise AssertionError("expected 401")
            except urllib.error.HTTPError as e:
                assert e.code == 401
            # Authorized report intake.
            body = json.dumps({"tool": "read", "report": "read returned wrong file contents for concurrent requests", "model": "m", "version": "1"}).encode()
            req = urllib.request.Request(
                f"{base}/v1/report", data=body,
                headers={"Authorization": "Bearer secret-token", "Content-Type": "application/json"},
            )
            resp = json.loads(urllib.request.urlopen(req, timeout=5).read())
            assert resp["ok"] and resp["inserted"]
            # Status reflects the report.
            req = urllib.request.Request(f"{base}/status", headers={"Authorization": "Bearer secret-token"})
            status = json.loads(urllib.request.urlopen(req, timeout=5).read())
            assert status["reports"] == 1
            assert status["top_groups"][0]["group_id"] == "result-attribution"
        finally:
            server.shutdown()
            server.conn.close()


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"PASS {t.__name__}")
    print(f"{len(tests)} tests passed")
