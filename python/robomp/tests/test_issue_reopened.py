"""Reopen routing, admission attribution, and finalized-workspace lifecycle."""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest

from robomp import tasks
from robomp.github_client import GitHubClient
from robomp.github_events import route

from .test_queue_dispatch import _make_pool, _pr_row


def test_reopen_is_submitter_attributable_and_repo_scoped() -> None:
    payload = {
        "action": "reopened",
        "repository": {"full_name": "octo/widget"},
        "issue": {"number": 4, "user": {"login": "alice"}, "author_association": "CONTRIBUTOR"},
    }
    kwargs = {"allowlist": frozenset({"octo/widget"}), "bot_login": "robomp-bot"}
    decision = route("issues", payload, **kwargs)
    assert decision.should_queue and decision.task == "triage_issue"
    assert decision.submitter == "alice" and decision.association == "CONTRIBUTOR"
    assert not decision.directive_authorizes_impl
    assert not route("issues", payload, **(kwargs | {"allowlist": frozenset()})).should_queue
    payload["issue"]["pull_request"] = {}
    assert not route("issues", payload, **kwargs).should_queue


async def test_dispatch_reopened_issue_runs_triage(settings, db, monkeypatch) -> None:
    seen = []

    async def record(**kwargs):
        seen.append(kwargs["payload"]["action"])

    monkeypatch.setattr(tasks, "triage_issue", record)
    row = replace(_pr_row("reopened"), event_type="issues", payload={"action": "reopened", "issue": {"number": 7}})
    await _make_pool(settings, db)._dispatch(row)
    assert seen == ["reopened"]


@pytest.mark.parametrize("state", ["closed", "merged", "abandoned", "opened", "reproducing"])
async def test_reopen_discards_only_finalized_workspace_state(settings, db, tmp_path, monkeypatch, state) -> None:
    key = "octo/widget#4"
    db.upsert_issue(key=key, repo="octo/widget", number=4, state=state, pr_number=99, branch="old", session_dir="old")
    db.set_issue_classification(key, "enhancement")
    calls = []

    def remove(**kwargs):
        calls.append("remove")

    def ensure(**kwargs):
        calls.append("ensure")
        return SimpleNamespace(branch="new", session_dir=tmp_path / "session")

    async def run(**kwargs):
        calls.append("run")
        assert kwargs["task_kind"] == "triage_issue"

    monkeypatch.setattr(tasks, "run_task", run)

    def unexpected(request):
        raise AssertionError(f"unexpected GitHub request: {request.url}")

    payload = {
        "action": "reopened",
        "repository": {
            "full_name": "octo/widget",
            "default_branch": "main",
            "clone_url": "https://example.invalid/repo.git",
        },
        "issue": {"number": 4, "title": "bug", "body": "report", "state": "open", "user": {"login": "alice"}},
    }
    await tasks.triage_issue(
        settings=settings,
        db=db,
        github=GitHubClient("fake", transport=httpx.MockTransport(unexpected)),
        sandbox=SimpleNamespace(remove_workspace=remove, ensure_workspace=ensure, natives_cache=None),
        git_transport=SimpleNamespace(),
        payload=payload,
        delivery_id="reopened",
    )
    row = db.get_issue(key)
    assert row.state == "reproducing" and row.branch == "new"
    if state in ("closed", "merged", "abandoned"):
        assert calls == ["remove", "ensure", "run"]
        assert row.pr_number is None and row.classification is None
        assert db.find_issue_by_pr("octo/widget", 99) is None
    else:
        assert calls == ["ensure", "run"]
        assert row.pr_number == 99 and row.classification == "enhancement"
