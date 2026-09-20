//! Report classification: symptom families, impact scores, normalization.
//!
//! Ordered from most to least specific. The first family whose patterns
//! match is the primary group; the normalized text + group form the
//! dedup fingerprint so exact repeats collapse while wording variants stay
//! visible as separate rows in the same group.

use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};
use sha2::{Digest, Sha256};

pub const MAX_REPORT_CHARS: usize = 4000;
pub const UNCATEGORIZED: &str = "uncategorized";

/// (`group_id`, title, impact, patterns)
const GROUP_DEFS: &[(&str, &str, u32, &[&str])] = &[
	("history-selector", "history URI selectors are parsed as part of the agent identifier", 54, &[
		r"history://[^\s]*:(?:raw|\d)",
		r"Unknown agent.*:(?:raw|\d)",
		r"selector.*(?:agent|history)",
	]),
	("result-attribution", "concurrent tool results are attributed to the wrong request", 100, &[
		r"wrong (?:file|artifact|result|output|content)",
		r"swapped.*(?:result|output|content)",
		r"cross-agent.*(?:artifact|result)",
		r"concurrent.*(?:wrong|swap|mismatch)",
		r"artifact.*wrong",
	]),
	(
		"edit-anchor-safety",
		"edit accepts stale or unseen anchors and can target unintended code",
		98,
		&[
			r"stale.*anchor",
			r"unseen.*anchor",
			r"nonexistent.*(?:path|target).*substitut",
			r"wrong (?:file|path|construct).*edit",
			r"edit.*(?:shifted|displaced|unintended)",
		],
	),
	(
		"edit-syntax-persistence",
		"edit persists patch-control syntax or rendered snapshot text",
		96,
		&[
			r"INS\.(?:POST|TAIL|PRE|BLK)",
			r"\[[^\]]+#(?:[0-9a-f]{4}|tag)\].*(?:written|persist|source)",
			r"numbered.*(?:lines|rows).*(?:written|persist|source)",
			r"patch.*(?:syntax|header).*(?:source|file)",
		],
	),
	(
		"edit-block-resolution",
		"fresh edit anchors are rejected or Rust attributes do not resolve with blocks",
		80,
		&[
			r"fresh.*anchor.*reject",
			r"anchor.*reject.*fresh",
			r"#\[test\].*(?:SWAP\.BLK|block|attribute)",
			r"attribute.*(?:block|function).*resolv",
		],
	),
	(
		"task-terminal-state",
		"successful task completion is reopened or reported as cancelled",
		86,
		&[
			r"Result submitted.*(?:incomplete|continuation|reopen)",
			r"success.*(?:cancelled|canceled|aborted)",
			r"completed.*(?:reopen|incomplete)",
			r"terminal.*(?:state|submission).*task",
		],
	),
	("handle-recovery", "returned agent, history, and job handles cannot recover results", 84, &[
		r"(?:agent|history|job) handle.*(?:missing|unresolvable|fail)",
		r"handle.*recover.*(?:result|output)",
		r"nested.*agent.*(?:missing|recover)",
		r"image placeholder.*(?:agent|result|output)",
	]),
	(
		"capability-advertising",
		"advertised agents, tools, or model capabilities differ from runtime availability",
		76,
		&[
			r"advertis.*(?:agent|tool|capabilit).*(?:unavailable|reject|missing)",
			r"only explore allowed",
			r"activated.*(?:grep|irc|tool).*(?:unavailable|missing)",
			r"unsupported.*thinking.*(?:spawn|model|role)",
		],
	),
	(
		"irc-delivery",
		"IRC wake, completion addressing, and follow-up delivery disagree with peer state",
		68,
		&[
			r"irc.*(?:wake|parked|complete|recipient|deliver)",
			r"peer.*(?:wake|parked|complete|deliver)",
			r"report-only.*wake",
		],
	),
	("todo-state", "concurrent or bridged todo updates lose parent task state", 70, &[
		r"todo.*(?:concurrent|append|bridg|eval|lost|revert)",
		r"task state.*(?:lost|revert)",
	]),
	(
		"ix-browser-state",
		"IX Bridge lane leases and navigation target stale or wrong browser state",
		72,
		&[
			r"ix_bridge.*(?:lane|lease|tab|window|navigation|stale|wrong)",
			r"browser.*(?:lease|lane|stale|wrong).*(?:tab|window|url)",
		],
	),
	(
		"browser-fill",
		"browser fill and displayed extraction results do not match documented behavior",
		66,
		&[
			r"browser.*(?:fill|contenteditable|input event|extraction|snapshot)",
			r"fill.*(?:empty|placeholder|input event)",
		],
	),
	(
		"eval-js-bindings",
		"JavaScript top-level bindings disappear between successful eval cells",
		88,
		&[
			r"javascript.*(?:binding|top-level|var|let|function).*(?:disappear|ReferenceError|missing)",
			r"eval.*js.*(?:binding|state|ReferenceError)",
		],
	),
	(
		"eval-shared-reset",
		"shared Python resets invalidate another agent's persistent state",
		78,
		&[
			r"python.*(?:reset|state).*(?:agent|peer|shared)",
			r"shared.*kernel.*reset",
			r"peer reset.*kernel",
		],
	),
	(
		"eval-hang",
		"lightweight Python cells and subprocess calls hang until watchdog termination",
		90,
		&[
			r"eval.*(?:hang|watchdog|timeout|stale.*runner)",
			r"python.*(?:hang|watchdog|subprocess.*hang)",
			r"runner.*(?:stale|accumulat)",
		],
	),
	("eval-module-write", "eval module loading and write helpers violate runtime contracts", 64, &[
		r"__dirname|CommonJS|workspace import|synthetic.*root",
		r"write helper.*(?:argument|return|template|corrupt)",
		r"subprocess.*stdout.*None",
	]),
	("selector-contract", "explicit read and grep selectors expand or are ignored", 82, &[
		r"line selector.*(?:ignored|expand|summary)",
		r"read.*(?:range|selector).*(?:ignored|expand|omit)",
		r"grep.*selector.*(?:entire|ignored|expand)",
		r"disjoint.*range.*expand",
	]),
	(
		"windows-path-identity",
		"Windows path identity and cached content disagree across tools",
		74,
		&[
			r"windows.*path.*(?:case|identity|cache|basename)",
			r"same-basename|mixed-case.*path",
			r"read.*grep.*edit.*(?:disagree|stale)",
		],
	),
	("ast-glob-contract", "AST and glob query scope produce false matches or false absence", 63, &[
		r"ast_grep|ast grep|glob.*(?:empty|scope|root|false|missing)",
		r"identifier.*(?:miss|false match)",
	]),
	(
		"bash-contract",
		"bash cwd, timeout limits, and failure artifacts differ from the contract",
		62,
		&[
			r"bash.*(?:cwd|timeout|artifact|capture|env|literal)",
			r"silent.*clamp.*timeout",
			r"wrong.*(?:checkout|cwd)",
		],
	),
	("exception-exposure", "exception rendering can expose captured subprocess output", 94, &[
		r"TimeoutExpired.*(?:stdout|stderr|captured)",
		r"exception.*(?:expose|leak|render).*captured",
	]),
	(
		"adapter-representation",
		"URL and document adapters return stale or wrong resource representations",
		60,
		&[
			r"url.*(?:stale|metadata|raw source|cache)",
			r"xlsb|png.*text|sqlite.*handle|pagination.*long line",
			r"hugging ?face.*(?:metadata|source)",
		],
	),
	(
		"resource-resolution",
		"advertised vault and skill resources are not reliably resolvable",
		58,
		&[
			r"skill.*(?:file|resource).*(?:missing|unresolvable|read)",
			r"vault.*(?:search|active|resolve|unsupported|exit 255)",
		],
	),
	(
		"startup-preflight",
		"tool startup needs capability-aware model and sandbox validation",
		56,
		&[
			r"model.*(?:inaccessible|unresolved|credential|guardrail|thinking)",
			r"sandbox.*(?:helper|binary|windows).*missing",
			r"startup.*(?:model|credential|sandbox)",
		],
	),
];

const NOISE_PATTERNS: &[&str] = &[
	r"^test(?:ing)?\b",
	r"^smoke test\b",
	r"^no issue\b",
	r"^not a bug\b",
	r"^withdrawn\b",
	r"^ignore\b",
];

struct Group {
	id:       &'static str,
	title:    &'static str,
	impact:   u32,
	patterns: Vec<Regex>,
}

fn ci(pattern: &str) -> Regex {
	RegexBuilder::new(pattern)
		.case_insensitive(true)
		.build()
		.unwrap_or_else(|e| panic!("bad classifier regex {pattern:?}: {e}"))
}

static GROUPS: LazyLock<Vec<Group>> = LazyLock::new(|| {
	GROUP_DEFS
		.iter()
		.map(|(id, title, impact, patterns)| Group {
			id,
			title,
			impact: *impact,
			patterns: patterns.iter().map(|p| ci(p)).collect(),
		})
		.collect()
});

static NOISE: LazyLock<Vec<Regex>> =
	LazyLock::new(|| NOISE_PATTERNS.iter().map(|p| ci(p)).collect());
static IDENTIFIER_RE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"(?:[A-Za-z]:\\[^\s]+|/(?:[^\s/]+/)+[^\s]+|agent://\S+|artifact://\S+|history://\S+|local://\S+)")
        .expect("identifier regex")
});
static WS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("ws regex"));
static VERSION_RE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"\b(?:v?\d+\.\d+\.\d+|#[0-9a-f]{4,}|id\s*\d+)\b").expect("version regex")
});
static NON_ALNUM_RE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[^a-z0-9_]+").expect("alnum regex"));

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classification {
	pub group_id:    String,
	pub title:       String,
	pub impact:      u32,
	pub noise:       bool,
	pub normalized:  String,
	pub fingerprint: String,
}

/// Strip machine identifiers, collapse whitespace, cap length.
pub fn clean_text(value: &str, limit: usize) -> String {
	let stripped = IDENTIFIER_RE.replace_all(value, "<resource>");
	let collapsed = WS_RE.replace_all(stripped.trim(), " ");
	let mut s = collapsed.into_owned();
	if s.chars().count() > limit {
		s = s.chars().take(limit).collect();
	}
	s
}

pub fn normalize_report(report: &str) -> String {
	let lowered = clean_text(report, MAX_REPORT_CHARS).to_lowercase();
	let no_res = lowered.replace("<resource>", " ");
	let no_ver = VERSION_RE.replace_all(&no_res, " ");
	let alnum = NON_ALNUM_RE.replace_all(&no_ver, " ");
	WS_RE.replace_all(alnum.trim(), " ").into_owned()
}

fn fingerprint(group_id: &str, normalized: &str) -> String {
	let mut h = Sha256::new();
	h.update(group_id.as_bytes());
	h.update(b":");
	h.update(normalized.as_bytes());
	let out = h.finalize();
	let mut hex = String::with_capacity(out.len() * 2);
	for b in out {
		use std::fmt::Write as _;
		let _ = write!(hex, "{b:02x}");
	}
	hex
}

pub fn classify(report: &str) -> Classification {
	let normalized = normalize_report(report);
	let compact = clean_text(report, 1200);
	let noise = NOISE.iter().any(|re| re.is_match(&compact));
	for g in GROUPS.iter() {
		if g.patterns.iter().any(|re| re.is_match(&compact)) {
			return Classification {
				group_id: g.id.to_string(),
				title: g.title.to_string(),
				impact: g.impact,
				noise,
				fingerprint: fingerprint(g.id, &normalized),
				normalized,
			};
		}
	}
	Classification {
		group_id: UNCATEGORIZED.to_string(),
		title: "uncategorized tool report".to_string(),
		impact: 20,
		noise,
		fingerprint: fingerprint(UNCATEGORIZED, &normalized),
		normalized,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn groups_related_wording_but_keeps_distinct_fingerprints() {
		let a = classify(
			"read returned the wrong file contents for concurrent requests; results were swapped",
		);
		let b =
			classify("concurrent artifact reads produced wrong output attributed to another request");
		assert_eq!(a.group_id, "result-attribution");
		assert_eq!(b.group_id, "result-attribution");
		assert_ne!(a.fingerprint, b.fingerprint);
	}

	#[test]
	fn exact_repeats_share_fingerprint() {
		let a = classify("edit accepts stale anchor and modifies unintended shifted code");
		let b = classify("edit accepts stale anchor and modifies unintended   shifted code");
		assert_eq!(a.fingerprint, b.fingerprint);
	}

	#[test]
	fn noise_detection() {
		assert!(classify("test smoke test ignore").noise);
		assert!(!classify("read returned wrong file contents for concurrent requests").noise);
	}

	#[test]
	fn strips_paths_and_uris() {
		let c = clean_text(r"see C:\Users\me\secret\file.txt and artifact://abc123", 500);
		assert!(!c.contains("secret"));
		assert!(c.contains("<resource>"));
	}

	#[test]
	fn every_group_has_positive_impact() {
		for g in GROUPS.iter() {
			assert!(g.impact > 20, "{} must outrank uncategorized", g.id);
		}
	}
}
