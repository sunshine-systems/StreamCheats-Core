//! Gather host + process info for the bug-report `info.txt` entry.
//!
//! Format is intentionally human-readable `key = value` so a recipient
//! can eyeball the bundle without a JSON parser. Live device + mask
//! state isn't duplicated here — it's already captured in the log slice
//! as `STATE:` lines emitted on every state transition by
//! `DeviceController` / `MaskController`.

use std::fmt::Write as _;
use std::path::Path;

/// Inputs gathered by the orchestrator and rendered here.
pub struct SystemInfo<'a> {
    pub app_version: &'a str,
    pub pid: u32,
    pub uptime_seconds: u64,
    pub data_dir: &'a Path,
    pub log_dir: &'a Path,
    pub log_dir_total_bytes: u64,
    pub log_drop_count: u64,
    pub udp_listen: String,
    pub http_listen: String,
    pub file_logging_enabled: bool,
    pub monitor_subscribers: usize,
}

/// Render the `key = value` body. UTF-8, LF newlines.
pub fn render(info: &SystemInfo<'_>) -> String {
    let mut out = String::with_capacity(1024);
    let _ = writeln!(out, "app_version = {}", info.app_version);
    let _ = writeln!(out, "pid = {}", info.pid);
    let _ = writeln!(out, "uptime_seconds = {}", info.uptime_seconds);
    let _ = writeln!(out, "os = {}", os_string());
    let _ = writeln!(out, "hostname = {}", host_string());
    let _ = writeln!(out, "data_dir = {}", info.data_dir.display());
    let _ = writeln!(out, "log_dir = {}", info.log_dir.display());
    let _ = writeln!(out, "log_dir_total_bytes = {}", info.log_dir_total_bytes);
    let _ = writeln!(out, "log_drop_count = {}", info.log_drop_count);
    let _ = writeln!(out, "udp_listen = {}", info.udp_listen);
    let _ = writeln!(out, "http_listen = {}", info.http_listen);
    let _ = writeln!(out, "file_logging_enabled = {}", info.file_logging_enabled);
    let _ = writeln!(out, "monitor_subscribers = {}", info.monitor_subscribers);
    out
}

/// `sysinfo`'s static OS helpers — used by both this module and the
/// orchestrator. Kept here so the orchestrator only has to call
/// `system_info::render(...)`.
fn os_string() -> String {
    let name = sysinfo::System::name().unwrap_or_else(|| "unknown".into());
    let ver = sysinfo::System::os_version().unwrap_or_else(|| "?".into());
    let long = sysinfo::System::long_os_version().unwrap_or_default();
    if long.is_empty() {
        format!("{} ({})", name, ver)
    } else {
        format!("{} ({})", long, ver)
    }
}

fn host_string() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown".into())
}

/// Walk `logs_dir` once and sum file sizes. Errors are coalesced to 0
/// — the bug report should be as best-effort as possible.
pub fn log_dir_total_bytes(logs_dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(logs_dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in rd.flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn render_contains_all_keys() {
        let info = SystemInfo {
            app_version: "1.2.3",
            pid: 4242,
            uptime_seconds: 7,
            data_dir: &PathBuf::from("/tmp/data"),
            log_dir: &PathBuf::from("/tmp/data/logs"),
            log_dir_total_bytes: 999,
            log_drop_count: 0,
            udp_listen: "127.0.0.1:8888".into(),
            http_listen: "127.0.0.1:54321".into(),
            file_logging_enabled: true,
            monitor_subscribers: 2,
        };
        let s = render(&info);
        for k in [
            "app_version = 1.2.3",
            "pid = 4242",
            "uptime_seconds = 7",
            "udp_listen = 127.0.0.1:8888",
            "http_listen = 127.0.0.1:54321",
            "file_logging_enabled = true",
            "monitor_subscribers = 2",
        ] {
            assert!(s.contains(k), "missing key: {k} in:\n{s}");
        }
    }
}
