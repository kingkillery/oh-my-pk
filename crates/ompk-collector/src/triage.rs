//! Issue publishing and ranking: published-map dedup, per-repo filing,
//! top-N triage. GitHub receives sanitized summaries only.

use std::{
	collections::HashMap,
	path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::{
	classify::clean_text,
	github::{self, TITLE_PREFIX},
	store::{self, GroupRow},
};

#[derive(Debug, Clone)]
pub struct TriageConfig {
	pub github_repo:    String,
	pub issue_limit:    usize,
	pub published_path: PathBuf,
	pub dry_run:        bool,
}

/// `repo#group_id` → issue URL. Legacy bare `group_id` keys are read as the
/// default repo so an existing Python-era map keeps working.
pub struct Published {
	path: PathBuf,
	map:  Map<String, Value>,
}

impl Published {
	pub fn load(path: &Path) -> Self {
		let map = std::fs::read_to_string(path)
			.ok()
			.and_then(|s| serde_json::from_str::<Value>(&s).ok())
			.and_then(|v| v.as_object().cloned())
			.unwrap_or_default();
		Self { path: path.to_path_buf(), map }
	}

	pub fn get(&self, repo: &str, default_repo: &str, group_id: &str) -> Option<String> {
		let scoped = format!("{repo}#{group_id}");
		if let Some(v) = self.map.get(&scoped).and_then(Value::as_str) {
			return Some(v.to_string());
		}
		if repo == default_repo
			&& let Some(v) = self.map.get(group_id).and_then(Value::as_str)
		{
			return Some(v.to_string());
		}
		None
	}

	pub fn set(&mut self, repo: &str, group_id: &str, url: &str) {
		self
			.map
			.insert(format!("{repo}#{group_id}"), Value::String(url.to_string()));
	}

	pub fn save(&self) -> Result<()> {
		if let Some(p) = self.path.parent() {
			std::fs::create_dir_all(p)?;
		}
		let tmp = self.path.with_extension("json.tmp");
		std::fs::write(&tmp, serde_json::to_string_pretty(&Value::Object(self.map.clone()))?)?;
		std::fs::rename(&tmp, &self.path)?;
		Ok(())
	}
}

pub fn issue_title(row: &GroupRow) -> String {
	let mut chars = row.group_title.chars();
	let title = match chars.next() {
		Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
		None => String::new(),
	};
	format!("{TITLE_PREFIX}{title}")
}

pub fn issue_body(conn: &Connection, row: &GroupRow, issue_limit: usize) -> Result<String> {
	let variants = store::variants(conn, &row.group_id, 8)?;
	let mut lines: Vec<String> = variants
		.iter()
		.map(|v| format!("- `{}` ×{} — {}", v.tool, v.count, clean_text(&v.report, 260)))
		.collect();
	if lines.is_empty() {
		lines.push("- No sanitized variant summary available.".into());
	}
	Ok(format!(
		"## Collector triage

This issue was selected by the OMPK QA collector as one of the top {issue_limit} impact-ranked \
		 report groups. It is a **sanitized aggregate of agent-reported symptoms**, not proof that \
		 the defect still exists on current `main`.

- Group: `{}`
- Reports: {}
- Tools represented: {}
- Models represented: {}
- Versions represented: {}
- First seen: {}
- Last seen: {}

## Reported variants

{}

## Investigation / acceptance

Reproduce on current `main` with synthetic fixtures before changing behavior. Add focused \
		 regression coverage for confirmed failures. If the group contains materially different \
		 root causes, split it into narrower issues during investigation and link them here.

## Privacy

Raw reports, installation identifiers, private paths, credentials, and transcript contents remain \
		 in the private collector database. This issue intentionally contains only sanitized \
		 summaries.
",
		row.group_id,
		row.report_count,
		row.tool_count,
		row.model_count,
		row.version_count,
		row.first_seen,
		row.last_seen,
		lines.join("\n"),
	))
}

fn publish(conn: &Connection, cfg: &TriageConfig, repo: &str, row: &GroupRow) -> Result<String> {
	if cfg.dry_run {
		return Ok(format!("dry-run:{}", row.group_id));
	}
	let created =
		github::create_issue(repo, &issue_title(row), &issue_body(conn, row, cfg.issue_limit)?)?;
	store::link_group(conn, &row.group_id, &created.url, Some(created.number))?;
	Ok(created.url)
}

/// Ensure `group_id` has a deduplicated issue in `repo`. Dedup order:
/// published map → existing GitHub titles → create.
pub fn ensure_repo_issue(
	conn: &Connection,
	cfg: &TriageConfig,
	repo: &str,
	group_id: &str,
) -> Result<Option<String>> {
	let mut published = Published::load(&cfg.published_path);
	if let Some(url) = published.get(repo, &cfg.github_repo, group_id) {
		return Ok(Some(url));
	}
	let Some(row) = store::group_row(conn, group_id)? else {
		return Ok(None);
	};
	let title_key = row.group_title.to_lowercase();
	let existing = if cfg.dry_run {
		HashMap::new()
	} else {
		github::existing_issue_map(repo)?
	};
	let url = match existing.get(&title_key) {
		Some(u) => u.clone(),
		None => publish(conn, cfg, repo, &row)?,
	};
	published.set(repo, group_id, &url);
	published.save().context("save published map")?;
	Ok(Some(url))
}

#[derive(Debug, Serialize)]
pub struct Selected {
	pub group_id:   String,
	pub title:      String,
	pub impact:     i64,
	pub reports:    i64,
	pub tools:      i64,
	pub models:     i64,
	pub versions:   i64,
	pub first_seen: String,
	pub last_seen:  String,
	pub issue_url:  String,
}

/// Rank groups and ensure the top `issue_limit` each have an issue in the
/// default repo. Reused URLs are backfilled onto the rows.
pub fn triage(conn: &Connection, cfg: &TriageConfig) -> Result<Vec<Selected>> {
	let rows = store::group_rows(conn)?;
	let mut published = Published::load(&cfg.published_path);
	let existing = if cfg.dry_run {
		HashMap::new()
	} else {
		github::existing_issue_map(&cfg.github_repo)?
	};
	let mut out = Vec::new();
	for row in rows.into_iter().take(cfg.issue_limit) {
		let title_key = row.group_title.to_lowercase();
		let found = published
			.get(&cfg.github_repo, &cfg.github_repo, &row.group_id)
			.or_else(|| row.issue_url.clone())
			.or_else(|| existing.get(&title_key).cloned());
		let url = match found {
			Some(u) => {
				if row.issue_url.is_none() {
					store::link_group(conn, &row.group_id, &u, github::issue_number(&u))?;
				}
				u
			},
			None => publish(conn, cfg, &cfg.github_repo, &row)?,
		};
		published.set(&cfg.github_repo, &row.group_id, &url);
		out.push(Selected {
			group_id:   row.group_id,
			title:      row.group_title,
			impact:     row.impact,
			reports:    row.report_count,
			tools:      row.tool_count,
			models:     row.model_count,
			versions:   row.version_count,
			first_seen: row.first_seen,
			last_seen:  row.last_seen,
			issue_url:  url,
		});
	}
	published.save().context("save published map")?;
	Ok(out)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::store::{Envelope, insert_report};

	fn tmp(name: &str) -> PathBuf {
		let mut p = std::env::temp_dir();
		p.push(format!("ompk-collector-test-{}-{name}", std::process::id()));
		let _ = std::fs::remove_dir_all(&p);
		std::fs::create_dir_all(&p).unwrap();
		p
	}

	#[test]
	fn published_map_reads_legacy_bare_keys_as_default_repo() {
		let dir = tmp("published");
		let path = dir.join("pub.json");
		std::fs::write(
			&path,
			r#"{"bash-contract":"https://x/issues/65","o/r#g":"https://x/issues/1"}"#,
		)
		.unwrap();
		let p = Published::load(&path);
		assert_eq!(
			p.get("default/repo", "default/repo", "bash-contract")
				.as_deref(),
			Some("https://x/issues/65")
		);
		assert_eq!(p.get("other/repo", "default/repo", "bash-contract"), None);
		assert_eq!(p.get("o/r", "default/repo", "g").as_deref(), Some("https://x/issues/1"));
	}

	#[test]
	fn dry_run_triage_ranks_and_limits() {
		let dir = tmp("triage");
		let conn = store::open(&dir.join("c.db")).unwrap();
		let env = Envelope::default();
		insert_report(
			&conn,
			"edit",
			"edit accepts stale anchor and modifies unintended shifted code",
			"m",
			"1",
			&env,
		)
		.unwrap();
		insert_report(&conn, "read", "vault search fails unsupported on Windows", "m", "1", &env)
			.unwrap();
		let cfg = TriageConfig {
			github_repo:    "x/y".into(),
			issue_limit:    1,
			published_path: dir.join("pub.json"),
			dry_run:        true,
		};
		let sel = triage(&conn, &cfg).unwrap();
		assert_eq!(sel.len(), 1);
		assert_eq!(sel[0].group_id, "edit-anchor-safety");
		assert!(sel[0].issue_url.starts_with("dry-run:"));
		// Second run reuses the published map — no new publish.
		let again = triage(&conn, &cfg).unwrap();
		assert_eq!(again[0].issue_url, sel[0].issue_url);
	}

	#[test]
	fn ensure_repo_issue_dedups_per_repo() {
		let dir = tmp("ensure");
		let conn = store::open(&dir.join("c.db")).unwrap();
		insert_report(
			&conn,
			"bash",
			"bash cwd resolved against wrong checkout",
			"m",
			"1",
			&Envelope::default(),
		)
		.unwrap();
		let cfg = TriageConfig {
			github_repo:    "x/y".into(),
			issue_limit:    10,
			published_path: dir.join("pub.json"),
			dry_run:        true,
		};
		let a = ensure_repo_issue(&conn, &cfg, "org/proj", "bash-contract").unwrap();
		let b = ensure_repo_issue(&conn, &cfg, "org/proj", "bash-contract").unwrap();
		assert_eq!(a, b);
		assert!(a.is_some());
		assert_eq!(ensure_repo_issue(&conn, &cfg, "org/proj", "nonexistent-group").unwrap(), None);
	}

	#[test]
	fn issue_body_is_sanitized_and_titled() {
		let dir = tmp("body");
		let conn = store::open(&dir.join("c.db")).unwrap();
		insert_report(
			&conn,
			"read",
			r"read returned wrong file C:\Users\me\private\x.txt for concurrent requests",
			"m",
			"1",
			&Envelope::default(),
		)
		.unwrap();
		let row = store::group_row(&conn, "result-attribution")
			.unwrap()
			.unwrap();
		let body = issue_body(&conn, &row, 10).unwrap();
		assert!(!body.contains(r"Users\me"), "path must be stripped from issue body");
		assert!(body.contains("<resource>"));
		assert!(issue_title(&row).starts_with("Tool report: C"));
	}
}
