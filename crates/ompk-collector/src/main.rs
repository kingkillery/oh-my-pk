//! `ompk-collector` — standalone OMPK tool-issue collector.
//!
//! One binary, three roles:
//! - **local extension**: spawned by OMPK when `dev.autoqa.collector.mode = local`
//! - **standalone helper**: installed on a server you control; prints the
//!   URL + token to paste into OMPK's remote-collector settings
//! - **reference implementation** for the ingest/dedup/triage contract

mod classify;
mod github;
mod server;
mod service;
mod store;
mod triage;

use anyhow::{Context, Result, bail};
use base64::Engine;
use clap::{Parser, Subcommand};
use rand::RngCore;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::time::Duration;

const DEFAULT_PORT: u16 = 8791;
const DEFAULT_REPO: &str = "kingkillery/oh-my-pk";
const DEFAULT_TRIAGE_SECS: u64 = 21_600;

#[derive(Parser)]
#[command(name = "ompk-collector", version, about = "OMPK tool-issue collector: ingest, dedupe, rank, file GitHub issues")]
struct Cli {
    /// Data directory (defaults to ~/.ompk)
    #[arg(long, env = "OMPK_COLLECTOR_DIR", global = true)]
    dir: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

fn data_dir(explicit: Option<PathBuf>) -> PathBuf {
    explicit.unwrap_or_else(|| {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE")).map_or_else(|| PathBuf::from("."), PathBuf::from);
        home.join(".ompk")
    })
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the collector HTTP service
    Serve {
        /// Bind address (0.0.0.0 to accept LAN/tailnet clients, 127.0.0.1 for local-only)
        #[arg(long, default_value = "0.0.0.0", env = "OMPK_COLLECTOR_BIND")]
        bind: IpAddr,
        #[arg(long, default_value_t = DEFAULT_PORT, env = "OMPK_COLLECTOR_PORT")]
        port: u16,
        /// Repo that receives top-N triage issues
        #[arg(long, default_value = DEFAULT_REPO, env = "OMPK_COLLECTOR_GITHUB_REPO")]
        github_repo: String,
        /// How many top-ranked groups get issues
        #[arg(long, default_value_t = 10, env = "OMPK_COLLECTOR_ISSUE_LIMIT")]
        issue_limit: usize,
        /// Seconds between automatic triage runs; 0 disables
        #[arg(long, default_value_t = DEFAULT_TRIAGE_SECS, env = "OMPK_COLLECTOR_TRIAGE_INTERVAL")]
        triage_interval: u64,
        /// Host/IP to advertise in the pairing block (auto-detected if omitted)
        #[arg(long, env = "OMPK_COLLECTOR_ADVERTISE")]
        advertise: Option<String>,
        /// Never touch GitHub
        #[arg(long)]
        dry_run: bool,
    },
    /// Print (or generate) the bearer token
    Token,
    /// Print the pairing block (URL + token + paste-ready OMPK command) without serving
    PairInfo {
        #[arg(long, default_value_t = DEFAULT_PORT)]
        port: u16,
        #[arg(long)]
        advertise: Option<String>,
    },
    /// Summarize the local database
    Status,
    /// Run one triage pass against the local database
    Triage {
        #[arg(long, default_value = DEFAULT_REPO)]
        github_repo: String,
        #[arg(long, default_value_t = 10)]
        issue_limit: usize,
        #[arg(long)]
        dry_run: bool,
    },
    /// Install (or reinstall) the restart-on-boot service
    Install {
        #[arg(long, default_value = "0.0.0.0")]
        bind: IpAddr,
        #[arg(long, default_value_t = DEFAULT_PORT)]
        port: u16,
        #[arg(long, default_value = DEFAULT_REPO)]
        github_repo: String,
        #[arg(long, default_value_t = 10)]
        issue_limit: u32,
        /// Print the service definition instead of installing it
        #[arg(long)]
        print: bool,
    },
    /// Remove the restart-on-boot service
    Uninstall,
    /// Report whether the service is installed
    ServiceStatus,
}
fn resolve_token(dir: &std::path::Path) -> Result<String> {
    if let Ok(t) = std::env::var("OMPK_COLLECTOR_TOKEN") {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    let path = dir.join("collector-token");
    if let Ok(t) = std::fs::read_to_string(&path) {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    std::fs::create_dir_all(dir)?;
    std::fs::write(&path, format!("{token}\n")).with_context(|| format!("write {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(token)
}

/// Best-effort reachable addresses: tailscale IPv4 if present, then the
/// primary LAN IPv4 (UDP connect trick — no packets are sent).
fn detect_hosts() -> Vec<String> {
    let mut hosts = Vec::new();
    if let Ok(out) = std::process::Command::new("tailscale").args(["ip", "-4"]).output()
        && out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let l = line.trim();
                if !l.is_empty() {
                    hosts.push(l.to_string());
                }
            }
        }
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0")
        && sock.connect("1.1.1.1:80").is_ok()
            && let Ok(local) = sock.local_addr() {
                let ip = local.ip().to_string();
                if !hosts.contains(&ip) {
                    hosts.push(ip);
                }
            }
    if hosts.is_empty() {
        hosts.push("127.0.0.1".into());
    }
    hosts
}

fn print_pairing(port: u16, token: &str, advertise: Option<&str>) {
    let hosts: Vec<String> = advertise.map_or_else(detect_hosts, |h| vec![h.to_string()]);
    println!("── OMPK remote issue collector ─────────────────────────────");
    for h in &hosts {
        println!("  URL:    http://{h}:{port}/v1/grievances");
    }
    println!("  Token:  {token}");
    println!();
    println!("  Pair an OMPK instance with this collector:");
    let primary = &hosts[0];
    println!("    omp collector pair http://{primary}:{port}/v1/grievances {token}");
    println!();
    println!("  Or in OMPK settings → Tools → Developer:");
    println!("    Collector mode: remote");
    println!("    Remote collector URL:   http://{primary}:{port}/v1/grievances");
    println!("    Remote collector token: (paste token)");
    println!("────────────────────────────────────────────────────────────");
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let dir = data_dir(cli.dir);
    let db_path = dir.join("collector.db");
    let published_path = dir.join("collector-published.json");

    match cli.cmd {
        Cmd::Serve { bind, port, github_repo, issue_limit, triage_interval, advertise, dry_run } => {
            let token = resolve_token(&dir)?;
            let conn = store::open(&db_path)?;
            let cfg = server::ServerConfig {
                bind: SocketAddr::new(bind, port),
                token: token.clone(),
                triage: triage::TriageConfig { github_repo: github_repo.clone(), issue_limit, published_path, dry_run },
                triage_interval: Duration::from_secs(triage_interval),
            };
            server::run(conn, cfg, |bound| {
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": true, "bind": bound.to_string(), "db": db_path.display().to_string(),
                        "repo": github_repo, "issue_limit": issue_limit, "triage_interval_s": triage_interval,
                    })
                );
                print_pairing(bound.port(), &token, advertise.as_deref());
            })
        }
        Cmd::Token => {
            println!("{}", resolve_token(&dir)?);
            Ok(())
        }
        Cmd::PairInfo { port, advertise } => {
            print_pairing(port, &resolve_token(&dir)?, advertise.as_deref());
            Ok(())
        }
        Cmd::Status => {
            let conn = store::open(&db_path)?;
            let (total, noise) = store::counts(&conn)?;
            let groups = store::group_rows(&conn)?;
            println!("reports: {total}  noise: {noise}  groups: {}", groups.len());
            for g in groups.iter().take(15) {
                println!(
                    "  {:>3} impact  {:>4} reports  {:<26} {}",
                    g.impact,
                    g.report_count,
                    g.group_id,
                    g.issue_url.as_deref().unwrap_or("-")
                );
            }
            Ok(())
        }
        Cmd::Triage { github_repo, issue_limit, dry_run } => {
            let conn = store::open(&db_path)?;
            let cfg = triage::TriageConfig { github_repo, issue_limit, published_path, dry_run };
            let sel = triage::triage(&conn, &cfg)?;
            for s in &sel {
                println!("{:<26} {:>4} reports  {}", s.group_id, s.reports, s.issue_url);
            }
            Ok(())
        }
        Cmd::Install { bind, port, github_repo, issue_limit, print } => {
            let spec = service::ServiceSpec {
                binary: std::env::current_exe().map_or_else(|_| "ompk-collector".into(), |p| p.display().to_string()),
                data_dir: dir.display().to_string(),
                bind: bind.to_string(),
                port,
                github_repo,
                issue_limit,
            };
            if print {
                match std::env::consts::OS {
                    "macos" => println!("{}", service::launchd_plist(&spec)),
                    "linux" => print!("{}", service::systemd_unit(&spec)),
                    "windows" => println!(
                        "RunKey: HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\nValueName: {}\nValue: {}",
                        service::RUN_KEY_VALUE,
                        service::windows_run_value(&spec)
                    ),
                    other => bail!("service installation is not supported on {other}"),
                }
                return Ok(());
            }
            let summary = service::install(&spec)?;
            println!("{summary}");
            let token = resolve_token(&dir)?;
            println!("  Token: {token}");
            println!("  Pair:  omp collector pair http://127.0.0.1:{port}/v1/grievances {token}");
            Ok(())
        }
        Cmd::Uninstall => {
            println!("{}", service::uninstall()?);
            Ok(())
        }
        Cmd::ServiceStatus => {
            if service::installed_marker() {
                println!("installed");
            } else {
                println!("not installed");
                std::process::exit(1);
            }
            Ok(())
        }
    }
}
