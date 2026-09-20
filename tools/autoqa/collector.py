#!/usr/bin/env python3
"""Private OMPK tool-issue collector.

Receives report_tool_issue payloads, stores them in SQLite, groups related
reports, and publishes the highest-impact groups to GitHub. Raw reports stay in
the collector database; GitHub receives sanitized summaries only.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import secrets
import sqlite3
import subprocess
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import urlparse

SCHEMA_VERSION = 1
MAX_BODY_BYTES = 64 * 1024
MAX_REPORT_CHARS = 4000
DEFAULT_LIMIT = 10
DEFAULT_REPO = "kingkillery/oh-my-pk"
DEFAULT_BIND = "0.0.0.0"
DEFAULT_PORT = 8787
DEFAULT_DB = Path.home() / ".ompk" / "collector.db"
DEFAULT_STATE = Path.home() / ".ompk" / "collector-state.json"
DEFAULT_TOKEN_FILE = Path.home() / ".ompk" / "collector-token"
DEFAULT_PUBLISHED = Path.home() / ".ompk" / "collector-published.json"

# Ordered from most to least specific. Each entry is a durable symptom family;
# reports can carry several families, but the first match is the primary group.
GROUP_PATTERNS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    (
        "history-selector",
        "history URI selectors are parsed as part of the agent identifier",
        (
            r"history://[^\s]*:(?:raw|\d)",
            r"Unknown agent.*:(?:raw|\d)",
            r"selector.*(?:agent|history)",
        ),
    ),
    (
        "result-attribution",
        "concurrent tool results are attributed to the wrong request",
        (
            r"wrong (?:file|artifact|result|output|content)",
            r"swapped.*(?:result|output|content)",
            r"cross-agent.*(?:artifact|result)",
            r"concurrent.*(?:wrong|swap|mismatch)",
            r"artifact.*wrong",
        ),
    ),
    (
        "edit-anchor-safety",
        "edit accepts stale or unseen anchors and can target unintended code",
        (
            r"stale.*anchor",
            r"unseen.*anchor",
            r"nonexistent.*(?:path|target).*substitut",
            r"wrong (?:file|path|construct).*edit",
            r"edit.*(?:shifted|displaced|unintended)",
        ),
    ),
    (
        "edit-syntax-persistence",
        "edit persists patch-control syntax or rendered snapshot text",
        (
            r"INS\.(?:POST|TAIL|PRE|BLK)",
            r"\[[^\]]+#(?:[0-9a-f]{4}|tag)\].*(?:written|persist|source)",
            r"numbered.*(?:lines|rows).*(?:written|persist|source)",
            r"patch.*(?:syntax|header).*(?:source|file)",
        ),
    ),
    (
        "edit-block-resolution",
        "fresh edit anchors are rejected or Rust attributes do not resolve with blocks",
        (
            r"fresh.*anchor.*reject",
            r"anchor.*reject.*fresh",
            r"#\[test\].*(?:SWAP\.BLK|block|attribute)",
            r"attribute.*(?:block|function).*resolv",
        ),
    ),
    (
        "task-terminal-state",
        "successful task completion is reopened or reported as cancelled",
        (
            r"Result submitted.*(?:incomplete|continuation|reopen)",
            r"success.*(?:cancelled|canceled|aborted)",
            r"completed.*(?:reopen|incomplete)",
            r"terminal.*(?:state|submission).*task",
        ),
    ),
    (
        "handle-recovery",
        "returned agent, history, and job handles cannot recover results",
        (
            r"(?:agent|history|job) handle.*(?:missing|unresolvable|fail)",
            r"handle.*recover.*(?:result|output)",
            r"nested.*agent.*(?:missing|recover)",
            r"image placeholder.*(?:agent|result|output)",
        ),
    ),
    (
        "capability-advertising",
        "advertised agents, tools, or model capabilities differ from runtime availability",
        (
            r"advertis.*(?:agent|tool|capabilit).*(?:unavailable|reject|missing)",
            r"only explore allowed",
            r"activated.*(?:grep|irc|tool).*(?:unavailable|missing)",
            r"unsupported.*thinking.*(?:spawn|model|role)",
        ),
    ),
    (
        "irc-delivery",
        "IRC wake, completion addressing, and follow-up delivery disagree with peer state",
        (
            r"irc.*(?:wake|parked|complete|recipient|deliver)",
            r"peer.*(?:wake|parked|complete|deliver)",
            r"report-only.*wake",
        ),
    ),
    (
        "todo-state",
        "concurrent or bridged todo updates lose parent task state",
        (
            r"todo.*(?:concurrent|append|bridg|eval|lost|revert)",
            r"task state.*(?:lost|revert)",
        ),
    ),
    (
        "ix-browser-state",
        "IX Bridge lane leases and navigation target stale or wrong browser state",
        (
            r"ix_bridge.*(?:lane|lease|tab|window|navigation|stale|wrong)",
            r"browser.*(?:lease|lane|stale|wrong).*(?:tab|window|url)",
        ),
    ),
    (
        "browser-fill",
        "browser fill and displayed extraction results do not match documented behavior",
        (
            r"browser.*(?:fill|contenteditable|input event|extraction|snapshot)",
            r"fill.*(?:empty|placeholder|input event)",
        ),
    ),
    (
        "eval-js-bindings",
        "JavaScript top-level bindings disappear between successful eval cells",
        (
            r"javascript.*(?:binding|top-level|var|let|function).*(?:disappear|ReferenceError|missing)",
            r"eval.*js.*(?:binding|state|ReferenceError)",
        ),
    ),
    (
        "eval-shared-reset",
        "shared Python resets invalidate another agent's persistent state",
        (
            r"python.*(?:reset|state).*(?:agent|peer|shared)",
            r"shared.*kernel.*reset",
            r"peer reset.*kernel",
        ),
    ),
    (
        "eval-hang",
        "lightweight Python cells and subprocess calls hang until watchdog termination",
        (
            r"eval.*(?:hang|watchdog|timeout|stale.*runner)",
            r"python.*(?:hang|watchdog|subprocess.*hang)",
            r"runner.*(?:stale|accumulat)",
        ),
    ),
    (
        "eval-module-write",
        "eval module loading and write helpers violate runtime contracts",
        (
            r"__dirname|CommonJS|workspace import|synthetic.*root",
            r"write helper.*(?:argument|return|template|corrupt)",
            r"subprocess.*stdout.*None",
        ),
    ),
    (
        "selector-contract",
        "explicit read and grep selectors expand or are ignored",
        (
            r"line selector.*(?:ignored|expand|summary)",
            r"read.*(?:range|selector).*(?:ignored|expand|omit)",
            r"grep.*selector.*(?:entire|ignored|expand)",
            r"disjoint.*range.*expand",
        ),
    ),
    (
        "windows-path-identity",
        "Windows path identity and cached content disagree across tools",
        (
            r"windows.*path.*(?:case|identity|cache|basename)",
            r"same-basename|mixed-case.*path",
            r"read.*grep.*edit.*(?:disagree|stale)",
        ),
    ),
    (
        "ast-glob-contract",
        "AST and glob query scope produce false matches or false absence",
        (
            r"ast_grep|ast grep|glob.*(?:empty|scope|root|false|missing)",
            r"identifier.*(?:miss|false match)",
        ),
    ),
    (
        "bash-contract",
        "bash cwd, timeout limits, and failure artifacts differ from the contract",
        (
            r"bash.*(?:cwd|timeout|artifact|capture|env|literal)",
            r"silent.*clamp.*timeout",
            r"wrong.*(?:checkout|cwd)",
        ),
    ),
    (
        "exception-exposure",
        "exception rendering can expose captured subprocess output",
        (
            r"TimeoutExpired.*(?:stdout|stderr|captured)",
            r"exception.*(?:expose|leak|render).*captured",
        ),
    ),
    (
        "adapter-representation",
        "URL and document adapters return stale or wrong resource representations",
        (
            r"url.*(?:stale|metadata|raw source|cache)",
            r"xlsb|png.*text|sqlite.*handle|pagination.*long line",
            r"hugging ?face.*(?:metadata|source)",
        ),
    ),
    (
        "resource-resolution",
        "advertised vault and skill resources are not reliably resolvable",
        (
            r"skill.*(?:file|resource).*(?:missing|unresolvable|read)",
            r"vault.*(?:search|active|resolve|unsupported|exit 255)",
        ),
    ),
    (
        "startup-preflight",
        "tool startup needs capability-aware model and sandbox validation",
        (
            r"model.*(?:inaccessible|unresolved|credential|guardrail|thinking)",
            r"sandbox.*(?:helper|binary|windows).*missing",
            r"startup.*(?:model|credential|sandbox)",
        ),
    ),
)

IMPACT_SCORES = {
    "result-attribution": 100,
    "edit-anchor-safety": 98,
    "edit-syntax-persistence": 96,
    "exception-exposure": 94,
    "eval-hang": 90,
    "eval-js-bindings": 88,
    "task-terminal-state": 86,
    "handle-recovery": 84,
    "selector-contract": 82,
    "edit-block-resolution": 80,
    "eval-shared-reset": 78,
    "capability-advertising": 76,
    "windows-path-identity": 74,
    "ix-browser-state": 72,
    "todo-state": 70,
    "irc-delivery": 68,
    "browser-fill": 66,
    "eval-module-write": 64,
    "ast-glob-contract": 63,
    "bash-contract": 62,
    "adapter-representation": 60,
    "resource-resolution": 58,
    "startup-preflight": 56,
    "history-selector": 54,
    "uncategorized": 20,
}

NOISE_PATTERNS = (
    r"^test(?:ing)?\b",
    r"^smoke test\b",
    r"^no issue\b",
    r"^not a bug\b",
    r"^withdrawn\b",
    r"^ignore\b",
)

TOKEN_RE = re.compile(r"[a-z0-9_]{3,}")
WS_RE = re.compile(r"\s+")
IDENTIFIER_RE = re.compile(
    r"(?:[A-Za-z]:\\[^\s]+|/(?:[^\s/]+/)+[^\s]+|agent://\S+|artifact://\S+|history://\S+|local://\S+)"
)


@dataclass(frozen=True)
class CollectorConfig:
    bind: str
    port: int
    db_path: Path
    state_path: Path
    token_file: Path
    published_path: Path
    github_repo: str
    issue_limit: int
    dry_run: bool
    triage_interval_s: int = 0


@dataclass(frozen=True)
class Classification:
    group_id: str
    title: str
    impact: int
    noise: bool
    normalized: str
    fingerprint: str


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def clean_text(value: Any, limit: int = MAX_REPORT_CHARS) -> str:
    text = str(value or "")
    text = IDENTIFIER_RE.sub("<resource>", text)
    text = WS_RE.sub(" ", text).strip()
    return text[:limit]


def normalize_report(report: str) -> str:
    lowered = clean_text(report).lower()
    lowered = re.sub(r"<resource>", " ", lowered)
    lowered = re.sub(r"\b(?:v?\d+\.\d+\.\d+|#[0-9a-f]{4,}|id\s*\d+)\b", " ", lowered)
    lowered = re.sub(r"[^a-z0-9_]+", " ", lowered)
    return WS_RE.sub(" ", lowered).strip()


def classify(report: str) -> Classification:
    normalized = normalize_report(report)
    compact = clean_text(report, 1200)
    noise = any(re.search(pattern, compact, re.IGNORECASE) for pattern in NOISE_PATTERNS)
    for group_id, title, patterns in GROUP_PATTERNS:
        if any(re.search(pattern, compact, re.IGNORECASE) for pattern in patterns):
            fingerprint = hashlib.sha256(f"{group_id}:{normalized}".encode()).hexdigest()
            return Classification(group_id, title, IMPACT_SCORES[group_id], noise, normalized, fingerprint)
    fingerprint = hashlib.sha256(f"uncategorized:{normalized}".encode()).hexdigest()
    return Classification("uncategorized", "uncategorized tool report", IMPACT_SCORES["uncategorized"], noise, normalized, fingerprint)


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            received_at TEXT NOT NULL,
            source TEXT NOT NULL,
            model TEXT NOT NULL,
            version TEXT NOT NULL,
            tool TEXT NOT NULL,
            report TEXT NOT NULL,
            platform TEXT NOT NULL DEFAULT '',
            arch TEXT NOT NULL DEFAULT '',
            install_hash TEXT NOT NULL DEFAULT '',
            group_id TEXT NOT NULL,
            group_title TEXT NOT NULL,
            impact INTEGER NOT NULL,
            noise INTEGER NOT NULL,
            normalized TEXT NOT NULL,
            fingerprint TEXT NOT NULL UNIQUE,
            issue_url TEXT,
            issue_number INTEGER
        )
        """
    )
    # Idempotent column migrations for databases created before platform
    # tracking existed.
    existing_cols = {row["name"] for row in conn.execute("PRAGMA table_info(reports)")}
    for col, ddl in (
        ("platform", "ALTER TABLE reports ADD COLUMN platform TEXT NOT NULL DEFAULT ''"),
        ("arch", "ALTER TABLE reports ADD COLUMN arch TEXT NOT NULL DEFAULT ''"),
        ("install_hash", "ALTER TABLE reports ADD COLUMN install_hash TEXT NOT NULL DEFAULT ''"),
    ):
        if col not in existing_cols:
            conn.execute(ddl)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reports_group ON reports(group_id, noise)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reports_issue ON reports(issue_number)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)",
        (str(SCHEMA_VERSION),),
    )
    conn.commit()
    return conn


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def save_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def bearer_token(config: CollectorConfig) -> str:
    token = os.environ.get("OMPK_COLLECTOR_TOKEN", "").strip()
    if token:
        return token
    try:
        token = config.token_file.read_text(encoding="utf-8").strip()
    except OSError:
        token = ""
    if token:
        return token
    token = secrets.token_urlsafe(32)
    config.token_file.parent.mkdir(parents=True, exist_ok=True)
    config.token_file.write_text(token + "\n", encoding="utf-8")
    try:
        os.chmod(config.token_file, 0o600)
    except OSError:
        pass
    return token


def insert_report(
    conn: sqlite3.Connection,
    payload: Mapping[str, Any],
    source: str,
    *,
    platform: str = "",
    arch: str = "",
    install_id: str = "",
) -> tuple[int, bool]:
    report = clean_text(payload.get("report"))
    if not report:
        raise ValueError("report is required")
    model = clean_text(payload.get("model"), 200)
    version = clean_text(payload.get("version"), 80)
    tool_name = clean_text(payload.get("tool"), 80)
    if not tool_name:
        raise ValueError("tool is required")
    # Hash the install id so per-install correlation is possible without
    # storing the raw identifier.
    install_hash = hashlib.sha256(install_id.encode()).hexdigest()[:16] if install_id else ""
    classification = classify(report)
    try:
        cursor = conn.execute(
            """
            INSERT INTO reports(
                received_at, source, model, version, tool, report,
                platform, arch, install_hash,
                group_id, group_title, impact, noise, normalized, fingerprint
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                utc_now(),
                clean_text(source, 120),
                model,
                version,
                tool_name,
                report,
                clean_text(platform, 40),
                clean_text(arch, 40),
                install_hash,
                classification.group_id,
                classification.title,
                classification.impact,
                int(classification.noise),
                classification.normalized,
                classification.fingerprint,
            ),
        )
        conn.commit()
        return int(cursor.lastrowid), True
    except sqlite3.IntegrityError:
        row = conn.execute("SELECT id FROM reports WHERE fingerprint = ?", (classification.fingerprint,)).fetchone()
        return int(row["id"]), False

def group_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return list(
        conn.execute(
            """
            SELECT
                group_id,
                group_title,
                MAX(impact) AS impact,
                COUNT(*) AS report_count,
                COUNT(DISTINCT tool) AS tool_count,
                COUNT(DISTINCT model) AS model_count,
                COUNT(DISTINCT version) AS version_count,
                MIN(received_at) AS first_seen,
                MAX(received_at) AS last_seen,
                MAX(issue_number) AS issue_number,
                MAX(issue_url) AS issue_url
            FROM reports
            WHERE noise = 0
            GROUP BY group_id
            ORDER BY impact DESC, report_count DESC, tool_count DESC, last_seen DESC
            """
        )
    )


def variants_for_group(conn: sqlite3.Connection, group_id: str, limit: int = 8) -> list[sqlite3.Row]:
    return list(
        conn.execute(
            """
            SELECT report, tool, model, version, COUNT(*) AS count
            FROM reports
            WHERE group_id = ? AND noise = 0
            GROUP BY normalized
            ORDER BY count DESC, MAX(received_at) DESC
            LIMIT ?
            """,
            (group_id, limit),
        )
    )


def issue_title(row: sqlite3.Row) -> str:
    title = row["group_title"]
    return f"Tool report: {title[0].upper()}{title[1:]}"


def issue_body(conn: sqlite3.Connection, row: sqlite3.Row) -> str:
    variants = variants_for_group(conn, row["group_id"])
    variant_lines = []
    for variant in variants:
        summary = clean_text(variant["report"], 260)
        variant_lines.append(
            f"- `{variant['tool']}` ×{variant['count']} — {summary}"
        )
    if not variant_lines:
        variant_lines.append("- No sanitized variant summary available.")
    issue_url = row["issue_url"] or "not yet published"
    return f"""## Collector triage

This issue was selected by the private OMPK QA collector as one of the top {DEFAULT_LIMIT} impact-ranked report groups. It is a **sanitized aggregate of agent-reported symptoms**, not proof that the defect still exists on current `main`.

- Group: `{row['group_id']}`
- Reports: {row['report_count']}
- Tools represented: {row['tool_count']}
- Models represented: {row['model_count']}
- Versions represented: {row['version_count']}
- First seen: {row['first_seen']}
- Last seen: {row['last_seen']}
- Collector issue: {issue_url}

## Reported variants

{chr(10).join(variant_lines)}

## Investigation / acceptance

Reproduce on current `main` with synthetic fixtures before changing behavior. Add focused regression coverage for confirmed failures. If the group contains materially different root causes, split it into narrower issues during investigation and link them here.

## Privacy

Raw reports, installation identifiers, private paths, credentials, and transcript contents remain in the private collector database. This issue intentionally contains only sanitized summaries.
"""


def github_token() -> str:
    """Resolve a GitHub token: env first, then `gh auth token` as a fallback."""
    for name in ("GH_TOKEN", "GITHUB_TOKEN"):
        token = os.environ.get(name, "").strip()
        if token:
            return token
    try:
        proc = subprocess.run(
            ["gh", "auth", "token"], check=False, capture_output=True, text=True, timeout=15,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    raise RuntimeError("no GitHub token: set GH_TOKEN/GITHUB_TOKEN or authenticate gh")


def github_api(method: str, path: str, body: Mapping[str, Any] | None = None) -> Any:
    import urllib.request

    req = urllib.request.Request(
        f"https://api.github.com{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {github_token()}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def existing_issue_map(repo: str) -> dict[str, str]:
    """Map collector issue titles → URLs for dedup across restarts."""
    result: dict[str, str] = {}
    page = 1
    while page <= 5:
        items = github_api("GET", f"/repos/{repo}/issues?state=all&per_page=100&page={page}")
        if not items:
            break
        for item in items:
            title = str(item.get("title", ""))
            match = re.match(r"Tool report: (.+)$", title)
            if match:
                result[match.group(1).lower()] = str(item["html_url"])
        if len(items) < 100:
            break
        page += 1
    return result


def publish_group(conn: sqlite3.Connection, repo: str, row: sqlite3.Row, dry_run: bool) -> str:
    title = issue_title(row)
    body = issue_body(conn, row)
    if dry_run:
        return f"dry-run:{row['group_id']}"
    issue = github_api("POST", f"/repos/{repo}/issues", {"title": title, "body": body})
    url = str(issue["html_url"])
    issue_number = int(issue["number"])
    conn.execute(
        "UPDATE reports SET issue_url = ?, issue_number = ? WHERE group_id = ?",
        (url, issue_number, row["group_id"]),
    )
    conn.commit()
    return url


def ensure_repo_issue(conn: sqlite3.Connection, config: CollectorConfig, repo: str, group_id: str) -> str | None:
    """Ensure the group has a deduplicated issue in `repo`; return its URL.

    Dedup order: published map (repo#group key, with legacy bare-group keys
    treated as the default repo) → existing GitHub issue titles → create.
    """
    published = load_json(config.published_path, {})
    key = f"{repo}#{group_id}"
    legacy_key = group_id if repo == config.github_repo else None
    url = published.get(key) or (published.get(legacy_key) if legacy_key else None)
    if url:
        return url
    row = conn.execute(
        """
        SELECT group_id, group_title, MAX(impact) AS impact, COUNT(*) AS report_count,
               COUNT(DISTINCT tool) AS tool_count, COUNT(DISTINCT model) AS model_count,
               COUNT(DISTINCT version) AS version_count,
               MIN(received_at) AS first_seen, MAX(received_at) AS last_seen,
               MAX(issue_number) AS issue_number, MAX(issue_url) AS issue_url
        FROM reports WHERE group_id = ? AND noise = 0 GROUP BY group_id
        """,
        (group_id,),
    ).fetchone()
    if not row:
        return None
    title_key = row["group_title"].lower()
    url = existing_issue_map(repo).get(title_key)
    if not url:
        url = publish_group(conn, repo, row, config.dry_run)
    published[key] = url
    save_json(config.published_path, published)
    return url


def triage(conn: sqlite3.Connection, config: CollectorConfig) -> list[dict[str, Any]]:
    rows = group_rows(conn)
    published = load_json(config.published_path, {})
    existing = {} if config.dry_run else existing_issue_map(config.github_repo)
    selected: list[dict[str, Any]] = []
    for row in rows:
        if len(selected) >= config.issue_limit:
            break
        group_id = row["group_id"]
        title_key = row["group_title"].lower()
        # Accept both the legacy bare-group key and the repo-scoped key.
        url = (
            published.get(f"{config.github_repo}#{group_id}")
            or published.get(group_id)
            or row["issue_url"]
            or existing.get(title_key)
        )
        if not url:
            url = publish_group(conn, config.github_repo, row, config.dry_run)
            published[f"{config.github_repo}#{group_id}"] = url
        elif not row["issue_url"]:
            # Resolved via the published map or an existing GitHub issue —
            # backfill the rows so /status and the DB reflect the link.
            match = re.search(r"/issues/(\d+)$", url)
            conn.execute(
                "UPDATE reports SET issue_url = ?, issue_number = ? WHERE group_id = ?",
                (url, int(match.group(1)) if match else None, group_id),
            )
            conn.commit()
        selected.append(
            {
                "group_id": group_id,
                "title": row["group_title"],
                "impact": row["impact"],
                "reports": row["report_count"],
                "tools": row["tool_count"],
                "models": row["model_count"],
                "versions": row["version_count"],
                "first_seen": row["first_seen"],
                "last_seen": row["last_seen"],
                "issue_url": url,
            }
        )
    save_json(config.published_path, published)
    return selected


def status_payload(conn: sqlite3.Connection, config: CollectorConfig) -> dict[str, Any]:
    total = conn.execute("SELECT COUNT(*) AS c FROM reports").fetchone()["c"]
    noise = conn.execute("SELECT COUNT(*) AS c FROM reports WHERE noise = 1").fetchone()["c"]
    groups = group_rows(conn)
    return {
        "ok": True,
        "reports": total,
        "noise": noise,
        "groups": len(groups),
        "issue_limit": config.issue_limit,
        "github_repo": config.github_repo,
        "top_groups": [
            {
                "group_id": row["group_id"],
                "title": row["group_title"],
                "impact": row["impact"],
                "reports": row["report_count"],
                "issue_url": row["issue_url"],
            }
            for row in groups[: config.issue_limit]
        ],
    }


class CollectorHandler(BaseHTTPRequestHandler):
    server_version = "OMPKAutoQACollector/1.0"

    @property
    def config(self) -> CollectorConfig:
        return self.server.config  # type: ignore[attr-defined]

    @property
    def conn(self) -> sqlite3.Connection:
        return self.server.conn  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def _send(self, status: int, payload: Mapping[str, Any]) -> None:
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        expected = bearer_token(self.config)
        auth = self.headers.get("Authorization", "")
        return bool(expected) and secrets.compare_digest(auth, f"Bearer {expected}")

    def _read_json(self) -> Mapping[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("invalid content length")
        raw = self.rfile.read(length)
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, Mapping):
            raise ValueError("JSON object required")
        return value

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        path = urlparse(self.path).path
        if path == "/health":
            self._send(HTTPStatus.OK, {"ok": True})
            return
        if not self._authorized():
            self._send(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "unauthorized"})
            return
        if path == "/status":
            with self.server.db_lock:  # type: ignore[attr-defined]
                payload = status_payload(self.conn, self.config)
            self._send(HTTPStatus.OK, payload)
            return
        if path == "/triage":
            try:
                with self.server.db_lock:  # type: ignore[attr-defined]
                    selected = triage(self.conn, self.config)
            except Exception as exc:  # keep service alive; report sanitized failure
                self._send(HTTPStatus.BAD_GATEWAY, {"ok": False, "error": clean_text(exc, 300)})
                return
            self._send(HTTPStatus.OK, {"ok": True, "selected": selected})
            return
        self._send(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        path = urlparse(self.path).path
        if not self._authorized():
            self._send(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "unauthorized"})
            return
        try:
            payload = self._read_json()
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(HTTPStatus.BAD_REQUEST, {"ok": False, "error": clean_text(exc, 200)})
            return
        if path == "/v1/report":
            try:
                with self.server.db_lock:  # type: ignore[attr-defined]
                    report_id, inserted = insert_report(self.conn, payload, self.client_address[0])
            except ValueError as exc:
                self._send(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
                return
            self._send(HTTPStatus.ACCEPTED, {"ok": True, "id": report_id, "inserted": inserted})
            return
        if path in ("/v1/reports", "/v1/grievances", "/"):
            # OMPK pushes {agent, installId, platform, arch, entries:[...]};
            # the batch API also accepts {reports:[...]} for manual imports.
            items = payload.get("entries")
            if items is None:
                items = payload.get("reports")
            if not isinstance(items, Sequence) or isinstance(items, (str, bytes)):
                self._send(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "entries array required"})
                return
            platform = clean_text(payload.get("platform"), 40)
            arch = clean_text(payload.get("arch"), 40)
            install_id = str(payload.get("installId") or "")
            # When the reporting session enabled auto-filing and sits inside a
            # GitHub repo, the envelope carries targetRepo — file the group
            # issue there (deduplicated) in the background so the POST stays
            # fast.
            target_repo = clean_text(payload.get("targetRepo"), 120)
            results = []
            new_groups: set[str] = set()
            for item in items[:500]:
                if not isinstance(item, Mapping):
                    results.append({"ok": False, "error": "object required"})
                    continue
                try:
                    with self.server.db_lock:  # type: ignore[attr-defined]
                        report_id, inserted = insert_report(
                            self.conn, item, self.client_address[0],
                            platform=platform, arch=arch, install_id=install_id,
                        )
                    results.append({"ok": True, "id": report_id, "inserted": inserted})
                    if inserted:
                        row = self.conn.execute("SELECT group_id FROM reports WHERE id = ?", (report_id,)).fetchone()
                        if row:
                            new_groups.add(row["group_id"])
                except ValueError as exc:
                    results.append({"ok": False, "error": str(exc)})
            if target_repo and new_groups:
                threading.Thread(
                    target=self._auto_file_groups,
                    args=(target_repo, sorted(new_groups)),
                    daemon=True,
                    name="auto-file",
                ).start()
            self._send(HTTPStatus.ACCEPTED, {"ok": True, "results": results})
            return
        self._send(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})

    def _auto_file_groups(self, repo: str, group_ids: list[str]) -> None:
        """Background: ensure each newly-seen group has an issue in `repo`."""
        for group_id in group_ids:
            try:
                with self.server.db_lock:  # type: ignore[attr-defined]
                    ensure_repo_issue(self.conn, self.config, repo, group_id)
            except Exception as exc:
                print(json.dumps({"auto_file": "error", "repo": repo, "group": group_id, "error": clean_text(exc, 300)}), flush=True)


class CollectorServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], config: CollectorConfig):
        self.config = config
        self.conn = connect(config.db_path)
        self.db_lock = threading.Lock()
        super().__init__(address, CollectorHandler)


def parse_args(argv: Sequence[str] | None = None) -> CollectorConfig:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default=os.environ.get("OMPK_COLLECTOR_BIND", DEFAULT_BIND))
    parser.add_argument("--port", type=int, default=int(os.environ.get("OMPK_COLLECTOR_PORT", DEFAULT_PORT)))
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("OMPK_COLLECTOR_DB", DEFAULT_DB)))
    parser.add_argument("--state", type=Path, default=Path(os.environ.get("OMPK_COLLECTOR_STATE", DEFAULT_STATE)))
    parser.add_argument("--token-file", type=Path, default=Path(os.environ.get("OMPK_COLLECTOR_TOKEN_FILE", DEFAULT_TOKEN_FILE)))
    parser.add_argument("--published", type=Path, default=Path(os.environ.get("OMPK_COLLECTOR_PUBLISHED", DEFAULT_PUBLISHED)))
    parser.add_argument("--github-repo", default=os.environ.get("OMPK_COLLECTOR_GITHUB_REPO", DEFAULT_REPO))
    parser.add_argument("--issue-limit", type=int, default=int(os.environ.get("OMPK_COLLECTOR_ISSUE_LIMIT", DEFAULT_LIMIT)))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--triage-interval",
        type=int,
        default=int(os.environ.get("OMPK_COLLECTOR_TRIAGE_INTERVAL", "21600")),
        help="seconds between automatic triage runs; 0 disables (default 21600 = 6h)",
    )
    args = parser.parse_args(argv)
    return CollectorConfig(
        bind=args.bind,
        port=args.port,
        db_path=args.db,
        state_path=args.state,
        token_file=args.token_file,
        published_path=args.published,
        github_repo=args.github_repo,
        issue_limit=args.issue_limit,
        dry_run=args.dry_run,
        triage_interval_s=args.triage_interval,
    )


def main(argv: Sequence[str] | None = None) -> int:
    config = parse_args(argv)
    server = CollectorServer((config.bind, config.port), config)
    print(
        json.dumps(
            {
                "ok": True,
                "bind": config.bind,
                "port": config.port,
                "db": str(config.db_path),
                "repo": config.github_repo,
                "issue_limit": config.issue_limit,
                "triage_interval_s": config.triage_interval_s,
            },
            sort_keys=True,
        ),
        flush=True,
    )
    if config.triage_interval_s > 0:
        def _triage_loop() -> None:
            while True:
                time.sleep(config.triage_interval_s)
                try:
                    with server.db_lock:
                        selected = triage(server.conn, config)
                    print(json.dumps({"triage": "ok", "selected": len(selected)}), flush=True)
                except Exception as exc:  # keep the loop alive across transient failures
                    print(json.dumps({"triage": "error", "error": clean_text(exc, 300)}), flush=True)

        threading.Thread(target=_triage_loop, daemon=True, name="auto-triage").start()
    try:
        server.serve_forever()
    finally:
        server.conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
