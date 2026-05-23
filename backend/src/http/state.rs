//! Shared state passed to every axum handler. Built once in
//! `main.rs::run()` and cloned per request via `axum::extract::State`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use crate::firmware::FirmwareUpdater;
use crate::kmbox_net::monitor::PeerRegistry;
use crate::services::log_stream::LogStreamHandles;
use crate::streamcheats::DeviceController;
use crate::updater::Updater;

/// Adapter so the HTTP layer can read the file-logger drop counter
/// without depending on `tracing-appender`'s `ErrorCounter` type. Built
/// in `main.rs` either as a wrapper around the live `ErrorCounter`
/// (when file logging is on) or as a permanent zero (when it's off).
#[derive(Clone)]
pub struct LogDropCounter(Arc<dyn Fn() -> u64 + Send + Sync>);

impl LogDropCounter {
    /// Build from any closure that returns the current cumulative drop
    /// count. Cheap to clone — the closure lives behind an `Arc`.
    pub fn new<F>(f: F) -> Self
    where
        F: Fn() -> u64 + Send + Sync + 'static,
    {
        Self(Arc::new(f))
    }

    /// Build a permanent-zero counter for the file-logging-disabled
    /// path so the `info.txt` line is always present.
    pub fn zero() -> Self {
        Self::new(|| 0)
    }

    /// Sample the current drop count.
    pub fn load(&self, _ord: Ordering) -> u64 {
        (self.0)()
    }
}

/// Handle to every piece of process state the HTTP routes care about.
/// Cheap to clone — every field is either `Copy`, an `Arc<...>`, or a
/// small POD.
#[derive(Clone)]
pub struct AppState {
    /// Authoritative device-state owner. State transitions emit
    /// `STATE:` log lines which are captured in the `/bug-report`
    /// log slice (no separate JSON snapshot — see
    /// `services::bug_report` module docs). Currently unread by HTTP
    /// routes; kept on AppState so future endpoints (e.g. a future
    /// `/state` read API) can wire in without re-plumbing AppState.
    #[allow(dead_code)]
    pub device: Arc<DeviceController>,
    /// Currently-subscribed monitor peers. Used by `/bug-report` to
    /// surface `monitor_subscribers = N` in `info.txt`; subscribe /
    /// unsubscribe events are also captured as `MONITOR:` log lines.
    pub peer_registry: PeerRegistry,
    /// Mirror of `Settings.enable_file_logging`. Determines whether
    /// `/bug-report` returns 200 (zip) or 400 (`file_logging_disabled`).
    pub file_logging_enabled: bool,
    /// Resolved data dir (typically `%LOCALAPPDATA%\StreamCheats Core`).
    pub data_dir: PathBuf,
    /// Resolved logs dir. Hardcoded today to `<data_dir>/logs` but
    /// kept independent so a future split (e.g. logs on a different
    /// volume) doesn't have to touch the handler signatures.
    pub log_dir: PathBuf,
    /// Working directory the daemon started in — used to read the
    /// active `config.json`.
    pub cwd: PathBuf,
    /// What the UDP listener bound to. Surfaced in `info.txt`.
    pub udp_listen: SocketAddr,
    /// What the HTTP server bound to. Surfaced in `info.txt`.
    pub http_listen: SocketAddr,
    /// Snapshot of the file appender's drop counter. Each call to
    /// [`LogDropCounter::load`] returns the live value.
    pub file_log_drops: LogDropCounter,
    /// `Instant` the daemon began running. Used to compute
    /// `uptime_seconds` for `info.txt`.
    pub started_at: Instant,
    /// Ring + broadcast pair fed by the tracing log-stream layer.
    /// Consumed by `GET /logs/stream` to dump recent history then
    /// stream live events. `None` when log streaming wasn't wired up
    /// (currently only possible in tests).
    pub log_stream: Option<LogStreamHandles>,
    /// In-app updater state. Polled in the background by a tokio task
    /// spawned alongside the HTTP server; exposed to the UI via the
    /// `/api/updates/*` routes and the
    /// `/api/settings/experimental_builds` toggle.
    pub updater: Arc<Updater>,
    /// Firmware updater (Teensy release polling + heartbeat-derived
    /// installed version). Polled by its own background task spawned in
    /// `server.rs`; exposed via `/api/firmware/*`. See SC-10.
    pub firmware: Arc<FirmwareUpdater>,
    /// Flag the daemon's main loop polls. When the updater handler for
    /// `/api/updates/install` flips it, the daemon exits cleanly so the
    /// installer can replace files on disk. Same shape as the global
    /// Ctrl+C `running` AtomicBool — the updater handler stores `false`.
    pub running: Arc<std::sync::atomic::AtomicBool>,
}
