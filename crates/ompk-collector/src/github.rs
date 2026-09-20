//! GitHub REST client: token resolution, issue listing, issue creation.

use std::{collections::HashMap, process::Command};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

const API: &str = "https://api.github.com";
pub const TITLE_PREFIX: &str = "Tool report: ";

/// Env first (`GH_TOKEN`, `GITHUB_TOKEN`), then `gh auth token`.
pub fn resolve_token() -> Result<String> {
	for name in ["GH_TOKEN", "GITHUB_TOKEN"] {
		if let Ok(v) = std::env::var(name) {
			let v = v.trim().to_string();
			if !v.is_empty() {
				return Ok(v);
			}
		}
	}
	if let Ok(out) = Command::new("gh").args(["auth", "token"]).output()
		&& out.status.success()
	{
		let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
		if !t.is_empty() {
			return Ok(t);
		}
	}
	bail!("no GitHub token: set GH_TOKEN/GITHUB_TOKEN or run `gh auth login`")
}

fn agent() -> ureq::Agent {
	ureq::AgentBuilder::new()
		.timeout(std::time::Duration::from_secs(30))
		.user_agent("ompk-collector")
		.build()
}

fn request(method: &str, path: &str, body: Option<Value>) -> Result<Value> {
	let token = resolve_token()?;
	let req = agent()
		.request(method, &format!("{API}{path}"))
		.set("Authorization", &format!("Bearer {token}"))
		.set("Accept", "application/vnd.github+json")
		.set("X-GitHub-Api-Version", "2022-11-28");
	let resp = match body {
		Some(b) => req.send_json(b),
		None => req.call(),
	};
	match resp {
		Ok(r) => r.into_json::<Value>().context("decode GitHub response"),
		Err(ureq::Error::Status(code, r)) => {
			let text = r.into_string().unwrap_or_default();
			bail!("GitHub {method} {path} → {code}: {}", text.chars().take(300).collect::<String>())
		},
		Err(e) => Err(e).context("GitHub transport"),
	}
}

/// Map lowercased group title → issue URL for every collector-created issue
/// (title prefixed with [`TITLE_PREFIX`]) in `repo`.
pub fn existing_issue_map(repo: &str) -> Result<HashMap<String, String>> {
	let mut out = HashMap::new();
	for page in 1..=5 {
		let items =
			request("GET", &format!("/repos/{repo}/issues?state=all&per_page=100&page={page}"), None)?;
		let arr = items.as_array().cloned().unwrap_or_default();
		if arr.is_empty() {
			break;
		}
		for item in &arr {
			let title = item.get("title").and_then(Value::as_str).unwrap_or("");
			if let Some(rest) = title.strip_prefix(TITLE_PREFIX)
				&& let Some(url) = item.get("html_url").and_then(Value::as_str)
			{
				out.insert(rest.to_lowercase(), url.to_string());
			}
		}
		if arr.len() < 100 {
			break;
		}
	}
	Ok(out)
}

pub struct CreatedIssue {
	pub url:    String,
	pub number: i64,
}

pub fn create_issue(repo: &str, title: &str, body: &str) -> Result<CreatedIssue> {
	let v = request(
		"POST",
		&format!("/repos/{repo}/issues"),
		Some(json!({ "title": title, "body": body })),
	)?;
	let url = v
		.get("html_url")
		.and_then(Value::as_str)
		.context("missing html_url")?
		.to_string();
	let number = v
		.get("number")
		.and_then(Value::as_i64)
		.context("missing number")?;
	Ok(CreatedIssue { url, number })
}

/// Extract `/issues/N` from an issue URL.
pub fn issue_number(url: &str) -> Option<i64> {
	url.rsplit("/issues/").next().and_then(|n| n.parse().ok())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_issue_number_from_url() {
		assert_eq!(issue_number("https://github.com/a/b/issues/65"), Some(65));
		assert_eq!(issue_number("https://github.com/a/b/pull/65"), None);
		assert_eq!(issue_number("dry-run:x"), None);
	}
}
