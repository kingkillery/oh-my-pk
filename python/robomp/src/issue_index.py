"""On-demand SQLite issue search, with bounded reconciliation and API fallback.

No webhook ingestion or background worker: a search refreshes the current repo
at most once per five minutes. Only a complete reconcile makes the index usable.
A reconcile that exceeds the page budget records how far it got and uses GitHub
search for now; the next refresh resumes there, so large repos converge.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from robomp.db import Database
from robomp.github_backend import GitHubBackend

_PAGE_SIZE = 100
_MAX_PAGES_PER_SEARCH = 30
_FRESH_SECONDS = 300


@dataclass(slots=True, frozen=True)
class ParsedSearchQuery:
    keywords: tuple[str, ...]
    is_pr: bool | None = None
    state: str | None = None
    merged: bool | None = None
    label: str | None = None
    author: str | None = None


def parse_search_query(query: str) -> ParsedSearchQuery | None:
    """Parse the supported subset; never silently discard GitHub qualifiers.

    Phrases, boolean syntax, exclusions, repeated filters and advanced qualifiers
    use the GitHub API so the local cache cannot broaden their meaning.
    """
    keywords: list[str] = []
    filters: dict[str, object] = {}
    for token in query.split():
        if token.startswith("-") or any(c in token for c in '"()') or token.upper() in {"OR", "AND", "NOT"}:
            return None
        key, sep, value = token.partition(":")
        if not sep:
            keywords.append(token)
            continue
        if key == "is" and value in ("pr", "issue"):
            name, parsed = "is_pr", value == "pr"
        elif key == "is" and value in ("open", "closed"):
            name, parsed = "state", value
        elif key == "is" and value == "merged":
            name, parsed = "merged", True
        elif key in ("label", "author") and value:
            name, parsed = key, value.lstrip("@") if key == "author" else value
        else:
            return None
        if name in filters:
            return None
        filters[name] = parsed
    return ParsedSearchQuery(keywords=tuple(keywords), **filters)


class IssueIndexSync:
    def __init__(self, *, db: Database, github: GitHubBackend, max_pages: int = _MAX_PAGES_PER_SEARCH) -> None:
        self._db = db
        self._github = github
        self._max_pages = max_pages

    async def ensure_fresh(self, repo: str) -> bool:
        """Return whether the repo has a complete, fresh index after this call."""
        watermark = self._db.issue_index_watermark(repo)
        if watermark:
            age = (datetime.now(UTC) - datetime.fromisoformat(watermark)).total_seconds()
            if 0 <= age < _FRESH_SECONDS:
                return True
        async with asyncio.timeout(60):
            return await self.sync_repo(repo)

    async def sync_repo(self, repo: str) -> bool:
        started = datetime.now(UTC)
        watermark = self._db.issue_index_watermark(repo)
        since = None
        if watermark:
            since = (datetime.fromisoformat(watermark) - timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        # Pages come back in ascending `updated_at`, so everything before the
        # recorded resume point is already ingested. `since` is inclusive, so
        # records sharing that timestamp are re-read rather than skipped.
        resume = self._db.issue_index_resume_since(repo)
        if resume and (since is None or resume > since):
            since = resume
        page = 1
        for _ in range(self._max_pages):
            batch = await self._github.list_issue_index_entries(repo, since=since, page=page, per_page=_PAGE_SIZE)
            if any(entry.repo != repo for entry in batch):
                raise ValueError("Issue index backend returned a different repository")
            progress = max((entry.updated_at for entry in batch if entry.updated_at), default=None)
            # One transaction per page, off the event loop that serves webhooks.
            await asyncio.to_thread(self._db.record_issue_index_page, repo, batch, resume_since=progress)
            if len(batch) < _PAGE_SIZE:
                await asyncio.to_thread(
                    self._db.set_issue_index_watermark, repo, started.strftime("%Y-%m-%dT%H:%M:%SZ")
                )
                return True
            # Keyset pagination: restart page 1 from the newest timestamp seen.
            # Page offsets shift when an item is updated mid-sync, which would
            # skip a record whose old `updated_at` the watermark then excludes
            # for good. Only a page that is all one timestamp steps by offset.
            if progress and progress != since:
                since, page = progress, 1
            else:
                page += 1
        # Never advance the watermark on partial pagination: only the resume
        # point moves, and the index stays unusable until a reconcile finishes.
        return False
