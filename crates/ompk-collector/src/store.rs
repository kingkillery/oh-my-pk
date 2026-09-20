//! `SQLite` storage for reports. Schema is compatible with the Python
//! reference collector so an existing `collector.db` can be reused.

use std::path::Path;

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::classify::{MAX_REPORT_CHARS, classify, clean_text};

pub const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Default)]
pub struct Envelope<'a> {
	pub source:     &'a str,
	pub platform:   &'a str,
	pub arch:       &'a str,
	pub install_id: &'a str,
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupRow {
	pub group_id:      String,
	pub group_title:   String,
	pub impact:        i64,
	pub report_count:  i64,
	pub tool_count:    i64,
	pub model_count:   i64,
	pub version_count: i64,
	pub first_seen:    String,
	pub last_seen:     String,
	pub issue_number:  Option<i64>,
	pub issue_url:     Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Variant {
	pub report: String,
	pub tool:   String,
	pub count:  i64,
}

pub fn utc_now() -> String {
	// RFC3339 without pulling in chrono: seconds since epoch → civil date.
	let secs = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_or(0, |d| d.as_secs());
	let days = secs / 86_400;
	let rem = secs % 86_400;
	let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
	// Howard Hinnant's civil-from-days.
	let z = days as i64 + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z.rem_euclid(146_097);
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let y = yoe + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let mo = if mp < 10 { mp + 3 } else { mp - 9 };
	let y = if mo <= 2 { y + 1 } else { y };
	format!("{y:04}-{mo:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
}

pub fn open(path: &Path) -> Result<Connection> {
	if let Some(parent) = path.parent() {
		std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
	}
	let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
	conn.busy_timeout(std::time::Duration::from_secs(5))?;
	conn.pragma_update(None, "journal_mode", "WAL")?;
	conn.execute_batch(
		"CREATE TABLE IF NOT EXISTS reports (
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
        );
        CREATE INDEX IF NOT EXISTS idx_reports_group ON reports(group_id, noise);
        CREATE INDEX IF NOT EXISTS idx_reports_issue ON reports(issue_number);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
	)?;
	// Idempotent column migrations for DBs created before platform tracking.
	let cols: Vec<String> = conn
		.prepare("PRAGMA table_info(reports)")?
		.query_map([], |r| r.get::<_, String>(1))?
		.collect::<std::result::Result<_, _>>()?;
	for (col, ddl) in [
		("platform", "ALTER TABLE reports ADD COLUMN platform TEXT NOT NULL DEFAULT ''"),
		("arch", "ALTER TABLE reports ADD COLUMN arch TEXT NOT NULL DEFAULT ''"),
		("install_hash", "ALTER TABLE reports ADD COLUMN install_hash TEXT NOT NULL DEFAULT ''"),
	] {
		if !cols.iter().any(|c| c == col) {
			conn.execute(ddl, [])?;
		}
	}
	conn
		.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?1)", params![
			SCHEMA_VERSION.to_string()
		])?;
	Ok(conn)
}

/// Insert one report. Returns `(id, inserted)`; `inserted == false` means an
/// exact duplicate already existed and its id is returned.
pub fn insert_report(
	conn: &Connection,
	tool: &str,
	report: &str,
	model: &str,
	version: &str,
	env: &Envelope<'_>,
) -> Result<(i64, bool)> {
	let report = clean_text(report, MAX_REPORT_CHARS);
	if report.is_empty() {
		bail!("report is required");
	}
	let tool = clean_text(tool, 80);
	if tool.is_empty() {
		bail!("tool is required");
	}
	let install_hash = if env.install_id.is_empty() {
		String::new()
	} else {
		let mut h = Sha256::new();
		h.update(env.install_id.as_bytes());
		h.finalize()
			.iter()
			.take(8)
			.fold(String::new(), |mut acc, b| {
				use std::fmt::Write as _;
				let _ = write!(acc, "{b:02x}");
				acc
			})
	};
	let c = classify(&report);
	let res = conn.execute(
		"INSERT INTO reports(received_at, source, model, version, tool, report,
            platform, arch, install_hash, group_id, group_title, impact, noise, normalized, \
		 fingerprint)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
		params![
			utc_now(),
			clean_text(env.source, 120),
			clean_text(model, 200),
			clean_text(version, 80),
			tool,
			report,
			clean_text(env.platform, 40),
			clean_text(env.arch, 40),
			install_hash,
			c.group_id,
			c.title,
			c.impact as i64,
			i64::from(c.noise),
			c.normalized,
			c.fingerprint,
		],
	);
	match res {
		Ok(_) => Ok((conn.last_insert_rowid(), true)),
		Err(rusqlite::Error::SqliteFailure(e, _))
			if e.code == rusqlite::ErrorCode::ConstraintViolation =>
		{
			let id: i64 = conn
				.query_row(
					"SELECT id FROM reports WHERE fingerprint = ?1",
					params![c.fingerprint],
					|r| r.get(0),
				)
				.context("lookup duplicate")?;
			Ok((id, false))
		},
		Err(e) => Err(e.into()),
	}
}

pub fn group_id_of(conn: &Connection, id: i64) -> Result<Option<String>> {
	Ok(conn
		.query_row("SELECT group_id FROM reports WHERE id = ?1", params![id], |r| r.get(0))
		.optional()?)
}

const GROUP_SELECT: &str = "SELECT group_id, group_title, MAX(impact), COUNT(*), COUNT(DISTINCT \
                            tool),
    COUNT(DISTINCT model), COUNT(DISTINCT version), MIN(received_at), MAX(received_at),
    MAX(issue_number), MAX(issue_url) FROM reports WHERE noise = 0";

fn map_group(r: &rusqlite::Row<'_>) -> rusqlite::Result<GroupRow> {
	Ok(GroupRow {
		group_id:      r.get(0)?,
		group_title:   r.get(1)?,
		impact:        r.get(2)?,
		report_count:  r.get(3)?,
		tool_count:    r.get(4)?,
		model_count:   r.get(5)?,
		version_count: r.get(6)?,
		first_seen:    r.get(7)?,
		last_seen:     r.get(8)?,
		issue_number:  r.get(9)?,
		issue_url:     r.get(10)?,
	})
}

/// All non-noise groups ranked by impact, then volume, then breadth.
pub fn group_rows(conn: &Connection) -> Result<Vec<GroupRow>> {
	let sql = format!("{GROUP_SELECT} GROUP BY group_id ORDER BY 3 DESC, 4 DESC, 5 DESC, 9 DESC");
	let mut st = conn.prepare(&sql)?;
	let rows = st
		.query_map([], map_group)?
		.collect::<std::result::Result<Vec<_>, _>>()?;
	Ok(rows)
}

pub fn group_row(conn: &Connection, group_id: &str) -> Result<Option<GroupRow>> {
	let sql = format!("{GROUP_SELECT} AND group_id = ?1 GROUP BY group_id");
	Ok(conn
		.query_row(&sql, params![group_id], map_group)
		.optional()?)
}

pub fn variants(conn: &Connection, group_id: &str, limit: i64) -> Result<Vec<Variant>> {
	let mut st = conn.prepare(
		"SELECT report, tool, COUNT(*) AS c FROM reports WHERE group_id = ?1 AND noise = 0
         GROUP BY normalized ORDER BY c DESC, MAX(received_at) DESC LIMIT ?2",
	)?;
	let rows = st
		.query_map(params![group_id, limit], |r| {
			Ok(Variant { report: r.get(0)?, tool: r.get(1)?, count: r.get(2)? })
		})?
		.collect::<std::result::Result<Vec<_>, _>>()?;
	Ok(rows)
}

pub fn link_group(conn: &Connection, group_id: &str, url: &str, number: Option<i64>) -> Result<()> {
	conn.execute(
		"UPDATE reports SET issue_url = ?1, issue_number = ?2 WHERE group_id = ?3",
		params![url, number, group_id],
	)?;
	Ok(())
}

pub fn counts(conn: &Connection) -> Result<(i64, i64)> {
	let total: i64 = conn.query_row("SELECT COUNT(*) FROM reports", [], |r| r.get(0))?;
	let noise: i64 =
		conn.query_row("SELECT COUNT(*) FROM reports WHERE noise = 1", [], |r| r.get(0))?;
	Ok((total, noise))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn mem() -> Connection {
		let c = Connection::open_in_memory().unwrap();
		// Reuse schema path via a temp file would need fs; replicate via open on
		// ":memory:" is not supported by `open`, so run the DDL directly.
		c.execute_batch(
			"CREATE TABLE reports (id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL,
             source TEXT NOT NULL, model TEXT NOT NULL, version TEXT NOT NULL, tool TEXT NOT NULL,
             report TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '', arch TEXT NOT NULL DEFAULT \
			 '',
             install_hash TEXT NOT NULL DEFAULT '', group_id TEXT NOT NULL, group_title TEXT NOT \
			 NULL,
             impact INTEGER NOT NULL, noise INTEGER NOT NULL, normalized TEXT NOT NULL,
             fingerprint TEXT NOT NULL UNIQUE, issue_url TEXT, issue_number INTEGER);",
		)
		.unwrap();
		c
	}

	#[test]
	fn exact_duplicate_collapses() {
		let c = mem();
		let env = Envelope { source: "t", ..Default::default() };
		let (id1, ins1) = insert_report(
			&c,
			"read",
			"read returned wrong file contents for concurrent requests",
			"m",
			"1",
			&env,
		)
		.unwrap();
		let (id2, ins2) = insert_report(
			&c,
			"read",
			"read returned wrong file contents for concurrent requests",
			"m",
			"1",
			&env,
		)
		.unwrap();
		assert!(ins1 && !ins2);
		assert_eq!(id1, id2);
		assert_eq!(counts(&c).unwrap().0, 1);
	}

	#[test]
	fn install_id_is_hashed_not_stored() {
		let c = mem();
		let env =
			Envelope { source: "t", install_id: "very-secret-install-id", ..Default::default() };
		insert_report(&c, "read", "some report about wrong file", "m", "1", &env).unwrap();
		let stored: String = c
			.query_row("SELECT install_hash FROM reports", [], |r| r.get(0))
			.unwrap();
		assert_eq!(stored.len(), 16);
		assert_ne!(stored, "very-secret-install-id");
	}

	#[test]
	fn rejects_empty_fields() {
		let c = mem();
		let env = Envelope::default();
		assert!(insert_report(&c, "read", "   ", "m", "1", &env).is_err());
		assert!(insert_report(&c, "", "report", "m", "1", &env).is_err());
	}

	#[test]
	fn groups_rank_by_impact() {
		let c = mem();
		let env = Envelope::default();
		insert_report(
			&c,
			"edit",
			"edit accepts stale anchor and modifies unintended shifted code",
			"m",
			"1",
			&env,
		)
		.unwrap();
		insert_report(&c, "read", "vault search fails unsupported on Windows", "m", "1", &env)
			.unwrap();
		let g = group_rows(&c).unwrap();
		assert_eq!(g[0].group_id, "edit-anchor-safety");
	}

	#[test]
	fn utc_now_is_rfc3339_shape() {
		let s = utc_now();
		assert_eq!(s.len(), 20);
		assert!(s.ends_with('Z'));
		assert_eq!(&s[4..5], "-");
		assert_eq!(&s[10..11], "T");
	}
}
