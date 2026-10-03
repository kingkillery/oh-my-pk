"""On-demand SQLite issue search, with bounded reconciliation and API fallback.

No webhook ingestion or background worker: a search refreshes the current repo
at most once per five minutes. Only a complete reconcile makes the index usable.
Large initial backfills that exceed the page budget use GitHub search instead.
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
    def __init__(self, *, db: Database, github: GitHubBackend) -> None:
        self._db = db
        self._github = github

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
        for page in range(1, _MAX_PAGES_PER_SEARCH + 1):
            batch = await self._github.list_issue_index_entries(repo, since=since, page=page, per_page=_PAGE_SIZE)
            for entry in batch:
                if entry.repo != repo:
                    raise ValueError("Issue index backend returned a different repository")
                self._db.upsert_issue_index(entry)
            if len(batch) < _PAGE_SIZE:
                self._db.set_issue_index_watermark(repo, started.strftime("%Y-%m-%dT%H:%M:%SZ"))
                return True
        # Never advance a watermark on partial pagination: equal timestamps can
        # span pages, and an advanced timestamp would permanently skip records.
        return False
