//! Restart-on-boot service installation for the collector.
//!
//! Per platform:
//! - macOS: launchd `LaunchAgent` (`launchctl load -w` at login)
//! - Linux: systemd user unit (`systemctl --user enable --now`)
//! - Windows: scheduled task at logon (`schtasks /SC ONLOGON`, no admin needed)
//!
//! Generators are pure functions so they are unit-testable; install/uninstall
//! shell out to the platform tool and surface its exit status.

use anyhow::{Context, Result, bail};

pub const SERVICE_LABEL: &str = "com.ompk.collector";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceSpec {
    pub binary: String,
    pub data_dir: String,
    pub bind: String,
    pub port: u16,
    pub github_repo: String,
    pub issue_limit: u32,
}

fn serve_args(spec: &ServiceSpec) -> Vec<String> {
    vec![
        spec.binary.clone(),
        "--dir".into(),
        spec.data_dir.clone(),
        "serve".into(),
        "--bind".into(),
        spec.bind.clone(),
        "--port".into(),
        spec.port.to_string(),
        "--github-repo".into(),
        spec.github_repo.clone(),
        "--issue-limit".into(),
        spec.issue_limit.to_string(),
    ]
}

/// macOS launchd plist XML for the collector `LaunchAgent`.
pub fn launchd_plist(spec: &ServiceSpec) -> String {
    let args = serve_args(spec);
    let args_xml = args
        .iter()
        .map(|a| format!("\t\t<string>{a}</string>"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{args_xml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{}/collector-service.log</string>
  <key>StandardErrorPath</key>
  <string>{}/collector-service.err.log</string>
</dict>
</plist>
"#,
        spec.data_dir, spec.data_dir
    )
}

/// systemd user unit for the collector.
pub fn systemd_unit(spec: &ServiceSpec) -> String {
    let args = serve_args(spec)
        .iter()
        .map(|a| format!("\"{a}\""))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r"[Unit]
Description=OMPK tool-issue collector
After=network-online.target
Wants=network-online.target

[Service]
ExecStart={args}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
"
    )
}

/// HKCU Run-key value for the collector: the command line Explorer executes
/// at user logon. No admin rights required (unlike schtasks ONLOGON).
pub fn windows_run_value(spec: &ServiceSpec) -> String {
    serve_args(spec)
        .iter()
        .map(|a| format!("\"{a}\""))
        .collect::<Vec<_>>()
        .join(" ")
}

pub const RUN_KEY_PATH: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
pub const RUN_KEY_VALUE: &str = "OMPK Collector";

fn run(cmd: &mut std::process::Command) -> Result<()> {
    let out = cmd.output().context("spawn platform service tool")?;
    if !out.status.success() {
        bail!(
            "{} failed ({}): {}",
            cmd.get_program().to_string_lossy(),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

fn home() -> Result<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .context("HOME/USERPROFILE not set")
}

/// Install the restart-on-boot service. Returns a human summary.
pub fn install(spec: &ServiceSpec) -> Result<String> {
    match std::env::consts::OS {
        "macos" => {
            let dir = format!("{}/Library/LaunchAgents", home()?);
            std::fs::create_dir_all(&dir)?;
            let path = format!("{dir}/{SERVICE_LABEL}.plist");
            std::fs::write(&path, launchd_plist(spec))?;
            // Legacy load/unload works from any user session (bootout/bootstrap
            // needs a GUI domain that SSH sessions don't have). Ignore unload
            // failure — a first install has nothing loaded yet.
            let _ = std::process::Command::new("launchctl").args(["unload", "-w", &path]).output();
            run(std::process::Command::new("launchctl").args(["load", "-w", &path]))?;
            Ok(format!("Installed LaunchAgent {path} (loads at login, kept alive)"))
        }
        "linux" => {
            let dir = format!("{}/.config/systemd/user", home()?);
            std::fs::create_dir_all(&dir)?;
            let path = format!("{dir}/{SERVICE_LABEL}.service");
            std::fs::write(&path, systemd_unit(spec))?;
            run(std::process::Command::new("systemctl").args(["--user", "daemon-reload"]))?;
            run(std::process::Command::new("systemctl").args(["--user", "enable", "--now", format!("{SERVICE_LABEL}.service").as_str()]))?;
            Ok(format!(
                "Installed systemd user unit {path} (enabled now and at boot). \
                 If the service stops when you log out, run `loginctl enable-linger $USER` once."
            ))
        }
        "windows" => {
            let value = windows_run_value(spec);
            run(std::process::Command::new("reg").args([
                "add",
                RUN_KEY_PATH,
                "/v",
                RUN_KEY_VALUE,
                "/t",
                "REG_SZ",
                "/d",
                &value,
                "/f",
            ]))?;
            Ok(format!("Installed HKCU Run-key \"{RUN_KEY_VALUE}\" (starts at user logon)"))
        }
        other => bail!("service installation is not supported on {other}"),
    }
}


/// Remove the restart-on-boot service. Returns a human summary.
pub fn uninstall() -> Result<String> {
    match std::env::consts::OS {
        "macos" => {
            let path = format!("{}/Library/LaunchAgents/{SERVICE_LABEL}.plist", home()?);
            let _ = std::process::Command::new("launchctl").args(["unload", "-w", &path]).output();
            match std::fs::remove_file(&path) {
                Ok(()) => Ok(format!("Removed {path}")),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("Service was not installed".into()),
                Err(e) => Err(e).context("remove LaunchAgent"),
            }
        }
        "linux" => {
            let path = format!("{}/.config/systemd/user/{SERVICE_LABEL}.service", home()?);
            let _ = std::process::Command::new("systemctl")
                .args(["--user", "disable", "--now", format!("{SERVICE_LABEL}.service").as_str()])
                .output();
            match std::fs::remove_file(&path) {
                Ok(()) => Ok(format!("Removed {path}")),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("Service was not installed".into()),
                Err(e) => Err(e).context("remove systemd unit"),
            }
        }
        "windows" => {
            let out = std::process::Command::new("reg")
                .args(["delete", RUN_KEY_PATH, "/v", RUN_KEY_VALUE, "/f"])
                .output();
            match out {
                Ok(o) if o.status.success() => Ok(format!("Removed HKCU Run-key \"{RUN_KEY_VALUE}\"")),
                Ok(o) if String::from_utf8_lossy(&o.stderr).contains("unable to find") => {
                    Ok("Service was not installed".into())
                }
                Ok(o) => bail!(
                    "reg delete failed: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                ),
                Err(e) => Err(e).context("reg delete"),
            }
        }
        other => bail!("service installation is not supported on {other}"),
    }
}

/// Best-effort "is it installed" for `service status`.
pub fn installed_marker() -> bool {
    match std::env::consts::OS {
        "macos" => home()
            .is_ok_and(|h| std::path::Path::new(&h).join(format!("Library/LaunchAgents/{SERVICE_LABEL}.plist")).exists()),
        "linux" => home()
            .is_ok_and(|h| std::path::Path::new(&h).join(format!(".config/systemd/user/{SERVICE_LABEL}.service")).exists()),
        "windows" => std::process::Command::new("reg")
            .args(["query", RUN_KEY_PATH, "/v", RUN_KEY_VALUE])
            .output()
            .is_ok_and(|o| o.status.success()),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ServiceSpec {
        ServiceSpec {
            binary: "/usr/local/bin/ompk-collector".into(),
            data_dir: "/Users/k/.ompk".into(),
            bind: "0.0.0.0".into(),
            port: 8791,
            github_repo: "kingkillery/oh-my-pk".into(),
            issue_limit: 10,
        }
    }

    #[test]
    fn plist_carries_serve_arguments_and_logs() {
        let p = launchd_plist(&spec());
        assert!(p.contains(&format!("<string>{SERVICE_LABEL}</string>")));
        assert!(p.contains("<string>serve</string>"));
        assert!(p.contains("<string>8791</string>"));
        assert!(p.contains("<string>kingkillery/oh-my-pk</string>"));
        assert!(p.contains("<key>KeepAlive</key>"));
        assert!(p.contains("/Users/k/.ompk/collector-service.log"));
        // Every argument is wrapped exactly once.
        assert_eq!(p.matches("<string>/usr/local/bin/ompk-collector</string>").count(), 1);
    }

    #[test]
    fn systemd_unit_quotes_exec_start() {
        let u = systemd_unit(&spec());
        assert!(u.contains("ExecStart=\"/usr/local/bin/ompk-collector\" \"--dir\" \"/Users/k/.ompk\" \"serve\""));
        assert!(u.contains("Restart=on-failure"));
        assert!(u.contains("WantedBy=default.target"));
    }

    #[test]
    fn windows_run_value_quotes_each_arg() {
        let v = windows_run_value(&spec());
        assert!(v.starts_with('"') && v.ends_with('"'));
        assert!(v.contains("\"serve\""));
        assert!(v.contains("8791"));
        // No outer double-wrapping: the Run key takes a plain command line.
        assert!(!v.starts_with("\"\""));
    }
    #[test]
    fn serve_args_are_complete() {
        let a = serve_args(&spec());
        assert_eq!(a.len(), 12);
        assert_eq!(a[1], "--dir");
        assert_eq!(a[3], "serve");
        assert_eq!(a[6], "--port");
        assert_eq!(a[7], "8791");
    }
}
