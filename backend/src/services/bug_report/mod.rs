//! Bug-report bundle orchestrator.
//!
//! Composes the log slicer, config snapshot, system-info renderer,
//! and zip builder into a single [`build_bundle`] entry point. Returns
//! either the in-memory zip bytes ready for the HTTP layer to stream
//! back, or a typed [`BugReportError`] the route handler can map to
//! the right HTTP code.
//!
//! Device state lives INSIDE the main log file as `STATE:` lines
//! emitted by `DeviceController` / `MaskController` on every state
//! transition — there is intentionally no separate `device_state.json`
//! entry. The log slice captures the same data with full chronology
//! and source code locations.

pub mod config_snapshot;
pub mod error;
pub mod log_slicer;
pub mod system_info;
pub mod zip_builder;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Local, Utc};
use serde::Serialize;

pub use error::BugReportError;

use crate::http::state::AppState;

/// What `build_bundle` returns: the zip bytes plus the filename the
/// HTTP handler should suggest via `Content-Disposition`.
#[derive(Debug)]
pub struct Bundle {
    pub bytes: Vec<u8>,
    pub filename: String,
    pub entry_count: usize,
}

/// Build the bug-report bundle from the live daemon state. Returns
/// [`BugReportError::FileLoggingDisabled`] without doing any work if
/// the user has opted out of file logging — the route handler turns
/// that into a 400.
pub fn build_bundle(state: &AppState) -> Result<Bundle, BugReportError> {
    if !state.file_logging_enabled {
        return Err(BugReportError::FileLoggingDisabled);
    }

    let now_instant = Instant::now();
    let now_wall: DateTime<Utc> = Utc::now();
    let now_local: DateTime<Local> = now_wall.with_timezone(&Local);

    // --- Slice the recent log lines ---
    // tracing-appender's rolling appender names files + emits per-line
    // timestamps in UTC; the slicer therefore operates in UTC too.
    let log_bytes = log_slicer::slice_last_window(&state.log_dir, now_wall)?;

    // --- Config snapshot ---
    let config_bytes = config_snapshot::read_config(&state.cwd)?;

    // Monitor peer count is still surfaced in info.txt; pulled straight
    // from the registry now that device_state_snapshot is gone.
    let monitor_subscribers = state.peer_registry.list_peers().len();

    // --- info.txt ---
    let uptime_seconds = now_instant
        .saturating_duration_since(state.started_at)
        .as_secs();
    let log_dir_total_bytes = system_info::log_dir_total_bytes(&state.log_dir);
    let log_drop_count = state.file_log_drops.load(Ordering::Relaxed);
    let info_text = system_info::render(&system_info::SystemInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        pid: std::process::id(),
        uptime_seconds,
        data_dir: &state.data_dir,
        log_dir: &state.log_dir,
        log_dir_total_bytes,
        log_drop_count,
        udp_listen: state.udp_listen.to_string(),
        http_listen: state.http_listen.to_string(),
        file_logging_enabled: state.file_logging_enabled,
        monitor_subscribers,
    });

    // Log-slice filename is derived from the crate's package name so a
    // future rename of the package (Cargo.toml `name = ...`) flows
    // through to the bundle entry without a code change.
    let log_slice_name: String = format!("{}_logs_last5min.log", env!("CARGO_PKG_NAME"));

    // --- Manifest ---
    let entries_meta = vec![
        ManifestEntry {
            name: log_slice_name.clone(),
            bytes: log_bytes.len() as u64,
        },
        ManifestEntry {
            name: "config.json".into(),
            bytes: config_bytes.len() as u64,
        },
        ManifestEntry {
            name: "info.txt".into(),
            bytes: info_text.len() as u64,
        },
    ];
    let manifest = Manifest {
        generated_at: now_wall.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        app_version: env!("CARGO_PKG_VERSION").into(),
        entries: entries_meta,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| BugReportError::IoError(std::io::Error::other(e)))?;

    let entries = vec![
        zip_builder::Entry {
            name: log_slice_name.as_str(),
            bytes: &log_bytes,
        },
        zip_builder::Entry {
            name: "config.json",
            bytes: &config_bytes,
        },
        zip_builder::Entry {
            name: "info.txt",
            bytes: info_text.as_bytes(),
        },
        zip_builder::Entry {
            name: "manifest.json",
            bytes: &manifest_bytes,
        },
    ];
    let entry_count = entries.len();
    let bytes = zip_builder::build(&entries)?;
    let filename = format!(
        "streamcheats_bug_report_{}.zip",
        now_local.format("%Y-%m-%d_%H%M")
    );
    Ok(Bundle {
        bytes,
        filename,
        entry_count,
    })
}

#[derive(Serialize)]
struct Manifest {
    generated_at: String,
    app_version: String,
    entries: Vec<ManifestEntry>,
}

#[derive(Serialize)]
struct ManifestEntry {
    name: String,
    bytes: u64,
}

/// Cheap helper used by the route to construct an AppState-like input
/// without circular dependencies in tests. Kept here (not in tests
/// alone) because it documents which fields are load-bearing.
#[allow(dead_code)]
pub(crate) fn _doc_inputs() -> (&'static str, &'static str) {
    (
        "AppState built in main.rs::run()",
        "see http::state::AppState",
    )
}

/// Helper kept private to satisfy the unused-import lint if a future
/// refactor drops `Arc<...>` usage.
#[allow(dead_code)]
fn _hold(_a: Arc<()>, _p: PathBuf, _: &Path, _: SocketAddr) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::state::{AppState, LogDropCounter};
    use crate::kmbox_net::monitor::PeerRegistry;
    use crate::streamcheats::{DeviceController, EventBus, MaskController};
    use crate::util::translator::{SerialTxHolder, Translator};
    use std::io::Cursor;
    use std::sync::{Arc, Mutex};
    use zip::ZipArchive;

    fn make_state(file_logging: bool, tmp_root: PathBuf) -> AppState {
        let holder: SerialTxHolder = Arc::new(Mutex::new(None));
        let device = Arc::new(DeviceController::new(holder, EventBus::new(), false));
        let cwd = tmp_root.clone();
        std::fs::create_dir_all(&cwd).unwrap();
        let log_dir = tmp_root.join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        let running = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let peer_registry = PeerRegistry::new();
        let mask_controller = Arc::new(MaskController::new(device.clone(), running.clone()));
        let translator = Arc::new(Translator::new(
            0x01FBC068,
            false,
            device.clone(),
            peer_registry.clone(),
            mask_controller,
        ));
        let experimental = crate::experimental::Manager::new(
            crate::experimental::KMBOX_NET_ID.to_string(),
            false,
            translator,
            "127.0.0.1".parse().unwrap(),
            0,
            running.clone(),
            cwd.clone(),
        );
        AppState {
            device,
            peer_registry,
            file_logging_enabled: file_logging,
            data_dir: tmp_root.clone(),
            log_dir,
            cwd,
            udp_listen: "127.0.0.1:8888".parse().unwrap(),
            http_listen: "127.0.0.1:54321".parse().unwrap(),
            file_log_drops: LogDropCounter::zero(),
            started_at: Instant::now(),
            log_stream: None,
            updater: Arc::new(crate::updater::Updater::new(false)),
            firmware: Arc::new(crate::firmware::FirmwareUpdater::new(
                crate::firmware::DEFAULT_REPO.to_string(),
                true,
                false,
                crate::firmware::device::LastHeartbeat::new(),
                tmp_root.clone(),
                String::new(),
                String::new(),
            )),
            experimental,
            running,
        }
    }

    #[test]
    fn file_logging_disabled_returns_400_error() {
        let dir = std::env::temp_dir().join(format!(
            "streamcheats_bug_disabled_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let state = make_state(false, dir);
        let err = build_bundle(&state).unwrap_err();
        assert!(matches!(err, BugReportError::FileLoggingDisabled));
    }

    #[test]
    fn produces_zip_with_expected_entries() {
        let dir = std::env::temp_dir().join(format!(
            "streamcheats_bug_ok_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let state = make_state(true, dir);
        let bundle = build_bundle(&state).expect("bundle ok");
        assert!(bundle.filename.starts_with("streamcheats_bug_report_"));
        assert!(bundle.filename.ends_with(".zip"));
        let mut zr = ZipArchive::new(Cursor::new(bundle.bytes)).unwrap();
        let names: Vec<String> = (0..zr.len())
            .map(|i| zr.by_index(i).unwrap().name().to_string())
            .collect();
        let expected_slice = format!("{}_logs_last5min.log", env!("CARGO_PKG_NAME"));
        assert_eq!(
            names,
            vec![
                expected_slice.as_str(),
                "config.json",
                "info.txt",
                "manifest.json",
            ]
        );
    }
}
