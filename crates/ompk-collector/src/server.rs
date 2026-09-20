//! HTTP surface. Wire-compatible with the Python reference collector and the
//! OMPK `report_tool_issue` push envelope:
//!
//! ```json
//! { "agent": {...}, "installId": "...", "platform": "win32", "arch": "x64",
//!   "targetRepo": "owner/name", "entries": [{ "tool", "report", "model", "version" }] }
//! ```

use std::{
	collections::BTreeSet,
	io::Read,
	net::SocketAddr,
	sync::{Arc, Mutex},
	thread,
	time::Duration,
};

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde_json::{Value, json};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::{
	classify::clean_text,
	store::{self, Envelope},
	triage::{self, TriageConfig},
};

pub const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_ENTRIES: usize = 500;

#[derive(Clone)]
pub struct ServerConfig {
	pub bind:            SocketAddr,
	pub token:           String,
	pub triage:          TriageConfig,
	pub triage_interval: Duration,
}

struct State {
	conn: Mutex<Connection>,
	cfg:  ServerConfig,
}

fn ct_eq(a: &str, b: &str) -> bool {
	if a.len() != b.len() {
		return false;
	}
	a.bytes()
		.zip(b.bytes())
		.fold(0u8, |acc, (x, y)| acc | (x ^ y))
		== 0
}

fn authorized(req: &Request, token: &str) -> bool {
	req.headers()
		.iter()
		.find(|h| h.field.equiv("Authorization"))
		.is_some_and(|h| ct_eq(h.value.as_str(), &format!("Bearer {token}")))
}

fn json_response(status: u16, body: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
	let data = serde_json::to_vec(body).unwrap_or_default();
	Response::from_data(data)
		.with_status_code(StatusCode(status))
		.with_header(Header::from_bytes("Content-Type", "application/json").expect("header"))
}

fn read_json(req: &mut Request) -> Result<Value> {
	let len = req.body_length().unwrap_or(0);
	if len == 0 || len > MAX_BODY_BYTES {
		anyhow::bail!("invalid content length");
	}
	let mut buf = Vec::with_capacity(len);
	req.as_reader().take(len as u64).read_to_end(&mut buf)?;
	let v: Value = serde_json::from_slice(&buf).context("JSON body")?;
	if !v.is_object() {
		anyhow::bail!("JSON object required");
	}
	Ok(v)
}

fn str_of(v: &Value, key: &str) -> String {
	v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn insert_from(conn: &Connection, item: &Value, env: &Envelope<'_>) -> Result<(i64, bool)> {
	store::insert_report(
		conn,
		&str_of(item, "tool"),
		&str_of(item, "report"),
		&str_of(item, "model"),
		&str_of(item, "version"),
		env,
	)
}

fn status_payload(state: &State) -> Result<Value> {
	let conn = state.conn.lock().expect("db lock");
	let (total, noise) = store::counts(&conn)?;
	let groups = store::group_rows(&conn)?;
	let top: Vec<Value> = groups
		.iter()
		.take(state.cfg.triage.issue_limit)
		.map(|g| {
			json!({
				 "group_id": g.group_id, "title": g.group_title, "impact": g.impact,
				 "reports": g.report_count, "issue_url": g.issue_url,
			})
		})
		.collect();
	Ok(json!({
		 "ok": true, "reports": total, "noise": noise, "groups": groups.len(),
		 "issue_limit": state.cfg.triage.issue_limit, "github_repo": state.cfg.triage.github_repo,
		 "top_groups": top,
	}))
}

fn auto_file(state: Arc<State>, repo: String, groups: BTreeSet<String>) {
	for g in groups {
		let conn = state.conn.lock().expect("db lock");
		if let Err(e) = triage::ensure_repo_issue(&conn, &state.cfg.triage, &repo, &g) {
			eprintln!(
				"{}",
				json!({ "auto_file": "error", "repo": repo, "group": g, "error": clean_text(&e.to_string(), 300) })
			);
		}
	}
}

fn handle(state: &Arc<State>, mut req: Request) {
	let path = req.url().split('?').next().unwrap_or("/").to_string();
	let method = req.method().clone();
	let peer = req
		.remote_addr()
		.map(|a| a.ip().to_string())
		.unwrap_or_default();

	if method == Method::Get && path == "/health" {
		let _ = req.respond(json_response(200, &json!({ "ok": true })));
		return;
	}
	if !authorized(&req, &state.cfg.token) {
		let _ = req.respond(json_response(401, &json!({ "ok": false, "error": "unauthorized" })));
		return;
	}

	match (method, path.as_str()) {
		(Method::Get, "/status") => {
			let resp = match status_payload(state) {
				Ok(v) => json_response(200, &v),
				Err(e) => {
					json_response(500, &json!({ "ok": false, "error": clean_text(&e.to_string(), 300) }))
				},
			};
			let _ = req.respond(resp);
		},
		(Method::Get, "/triage") => {
			let result = {
				let conn = state.conn.lock().expect("db lock");
				triage::triage(&conn, &state.cfg.triage)
			};
			let resp = match result {
				Ok(sel) => json_response(200, &json!({ "ok": true, "selected": sel })),
				Err(e) => {
					json_response(502, &json!({ "ok": false, "error": clean_text(&e.to_string(), 300) }))
				},
			};
			let _ = req.respond(resp);
		},
		(Method::Post, "/v1/report") => {
			let payload = match read_json(&mut req) {
				Ok(v) => v,
				Err(e) => {
					let _ = req.respond(json_response(
						400,
						&json!({ "ok": false, "error": clean_text(&e.to_string(), 200) }),
					));
					return;
				},
			};
			let env = Envelope { source: &peer, ..Default::default() };
			let result = {
				let conn = state.conn.lock().expect("db lock");
				insert_from(&conn, &payload, &env)
			};
			let resp = match result {
				Ok((id, inserted)) => {
					json_response(202, &json!({ "ok": true, "id": id, "inserted": inserted }))
				},
				Err(e) => json_response(400, &json!({ "ok": false, "error": e.to_string() })),
			};
			let _ = req.respond(resp);
		},
		(Method::Post, "/v1/reports" | "/v1/grievances" | "/") => {
			let payload = match read_json(&mut req) {
				Ok(v) => v,
				Err(e) => {
					let _ = req.respond(json_response(
						400,
						&json!({ "ok": false, "error": clean_text(&e.to_string(), 200) }),
					));
					return;
				},
			};
			let items = payload
				.get("entries")
				.or_else(|| payload.get("reports"))
				.and_then(Value::as_array);
			let Some(items) = items else {
				let _ = req.respond(json_response(
					400,
					&json!({ "ok": false, "error": "entries array required" }),
				));
				return;
			};
			let platform = str_of(&payload, "platform");
			let arch = str_of(&payload, "arch");
			let install_id = str_of(&payload, "installId");
			let target_repo = clean_text(&str_of(&payload, "targetRepo"), 120);
			let env = Envelope {
				source:     &peer,
				platform:   &platform,
				arch:       &arch,
				install_id: &install_id,
			};

			let mut results = Vec::with_capacity(items.len().min(MAX_ENTRIES));
			let mut new_groups = BTreeSet::new();
			{
				let conn = state.conn.lock().expect("db lock");
				for item in items.iter().take(MAX_ENTRIES) {
					if !item.is_object() {
						results.push(json!({ "ok": false, "error": "object required" }));
						continue;
					}
					match insert_from(&conn, item, &env) {
						Ok((id, inserted)) => {
							results.push(json!({ "ok": true, "id": id, "inserted": inserted }));
							if inserted && let Ok(Some(g)) = store::group_id_of(&conn, id) {
								new_groups.insert(g);
							}
						},
						Err(e) => results.push(json!({ "ok": false, "error": e.to_string() })),
					}
				}
			}
			if !target_repo.is_empty() && !new_groups.is_empty() {
				let st = Arc::clone(state);
				thread::Builder::new()
					.name("auto-file".into())
					.spawn(move || auto_file(st, target_repo, new_groups))
					.ok();
			}
			let _ = req.respond(json_response(202, &json!({ "ok": true, "results": results })));
		},
		_ => {
			let _ = req.respond(json_response(404, &json!({ "ok": false, "error": "not found" })));
		},
	}
}

/// Bind and serve forever. Returns the bound address once listening so
/// callers (tests, the `serve` command) can print pairing info.
pub fn run(conn: Connection, cfg: ServerConfig, on_ready: impl FnOnce(SocketAddr)) -> Result<()> {
	let server = Server::http(cfg.bind).map_err(|e| anyhow::anyhow!("bind {}: {e}", cfg.bind))?;
	let bound = server.server_addr().to_ip().context("tcp bind")?;
	let state = Arc::new(State { conn: Mutex::new(conn), cfg });
	on_ready(bound);

	if !state.cfg.triage_interval.is_zero() {
		let st = Arc::clone(&state);
		thread::Builder::new()
			.name("auto-triage".into())
			.spawn(move || {
				loop {
					thread::sleep(st.cfg.triage_interval);
					let result = {
						let conn = st.conn.lock().expect("db lock");
						triage::triage(&conn, &st.cfg.triage)
					};
					match result {
						Ok(sel) => println!("{}", json!({ "triage": "ok", "selected": sel.len() })),
						Err(e) => eprintln!(
							"{}",
							json!({ "triage": "error", "error": clean_text(&e.to_string(), 300) })
						),
					}
				}
			})
			.ok();
	}

	for req in server.incoming_requests() {
		let st = Arc::clone(&state);
		thread::spawn(move || handle(&st, req));
	}
	Ok(())
}
