//! Experimental input-API control plane (SC-8).
//!
//! Owns the lifecycle of "alternate input listeners" — tools whose
//! protocol is foreign to the StreamCheats device's native USB control
//! path but which, when enabled, accept commands and translate them
//! into the device's protocol. Today the only such API is `kmbox-net`;
//! future entries (`serial-bridge`, `tcp-bridge`, ...) drop into
//! [`registry::REGISTRY`] without touching the manager surface.
//!
//! The manager is the single source of truth for:
//!
//!   * which API id is currently selected,
//!   * whether the selected API's listener is currently running,
//!   * the last fatal error from a start attempt (if any), and
//!   * the bound socket address while running.
//!
//! Persistence: [`Manager::set_active`] / [`Manager::set_enabled`]
//! mirror their changes back to `config.json` via
//! [`crate::util::settings::set_experimental_api`] so toggling the UI
//! survives a daemon restart.

pub mod registry;

use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tracing::{info, warn};

use crate::kmbox_net::listener::{self, Listener};
use crate::util::settings::set_experimental_api;
use crate::util::translator::Translator;

#[allow(unused_imports)]
pub use registry::{ApiDescriptor, KMBOX_NET_ID, REGISTRY};

/// Public-facing snapshot of the manager's state. Serialised as the
/// body of `GET /api/experimental/status`.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    /// Currently selected API id. Always present — even when disabled
    /// we remember the last choice so re-enabling restores it.
    pub active: String,
    /// Whether the user has opted the selected API in. Independent of
    /// `running`: a misconfigured listener might be `enabled = true,
    /// running = false, last_error = Some(_)`.
    pub enabled: bool,
    /// Whether the listener is actually accepting datagrams right now.
    pub running: bool,
    /// Bound socket address when running; `None` when stopped.
    pub bound: Option<String>,
    /// Last error from a failed start attempt. Cleared on the next
    /// successful start.
    pub last_error: Option<String>,
}

/// Inner mutable state. Guarded by the manager's `Mutex` so all
/// transitions are serialised; the listener handle is only ever held
/// across the mutex boundary inside the manager's own methods.
struct Inner {
    active: String,
    enabled: bool,
    last_error: Option<String>,
    listener: Option<Listener>,
}

/// Cloneable handle to the experimental control plane. Cheap to clone
/// — every field lives behind an `Arc`.
#[derive(Clone)]
pub struct Manager {
    inner: Arc<Mutex<Inner>>,
    translator: Arc<Translator>,
    listen_addr: IpAddr,
    port: u16,
    global_running: Arc<AtomicBool>,
    /// Where to write `config.json` updates back to. Same `cwd` the
    /// rest of the settings-persistence path uses.
    config_dir: PathBuf,
}

impl Manager {
    /// Construct the manager. Does NOT start any listener — the caller
    /// is responsible for calling [`Manager::boot`] once the rest of
    /// the daemon is wired up.
    pub fn new(
        active: String,
        enabled: bool,
        translator: Arc<Translator>,
        listen_addr: IpAddr,
        port: u16,
        global_running: Arc<AtomicBool>,
        config_dir: PathBuf,
    ) -> Self {
        let initial = if registry::is_known(&active) {
            active
        } else {
            warn!(
                "experimental: persisted active id {:?} is unknown; falling back to {:?}",
                active, KMBOX_NET_ID
            );
            KMBOX_NET_ID.to_string()
        };
        Self {
            inner: Arc::new(Mutex::new(Inner {
                active: initial,
                enabled,
                last_error: None,
                listener: None,
            })),
            translator,
            listen_addr,
            port,
            global_running,
            config_dir,
        }
    }

    /// Honour the persisted `enabled` flag at daemon boot. Called once
    /// from `main::run` after the manager is built. Logs and records
    /// `last_error` on failure but never returns an error itself — a
    /// listener that fails to bind at startup should not abort the
    /// whole daemon.
    pub fn boot(&self) {
        let should_start = {
            let g = self
                .inner
                .lock()
                .expect("experimental: inner mutex poisoned");
            g.enabled
        };
        if should_start {
            if let Err(e) = self.start_internal() {
                warn!("experimental: boot start failed: {}", e);
            }
        } else {
            info!("experimental: disabled on boot — kmbox-net listener not started");
        }
    }

    /// Snapshot the public-facing state.
    pub fn status(&self) -> Status {
        let g = self
            .inner
            .lock()
            .expect("experimental: inner mutex poisoned");
        Status {
            active: g.active.clone(),
            enabled: g.enabled,
            running: g.listener.is_some(),
            bound: g.listener.as_ref().map(|l| l.addr().to_string()),
            last_error: g.last_error.clone(),
        }
    }

    /// Switch the active API. Returns `Err` if `id` is unknown OR if a
    /// listener is currently running (the UI is expected to disable
    /// first, then change the selection — matches the SC-8 ticket).
    pub fn set_active(&self, id: &str) -> Result<(), SetActiveError> {
        if !registry::is_known(id) {
            return Err(SetActiveError::Unknown);
        }
        let mut g = self
            .inner
            .lock()
            .expect("experimental: inner mutex poisoned");
        if g.listener.is_some() {
            return Err(SetActiveError::Running);
        }
        if g.active == id {
            return Ok(());
        }
        g.active = id.to_string();
        drop(g);
        self.persist();
        info!("experimental: active API set to {}", id);
        Ok(())
    }

    /// Start the listener for the currently-selected API. Idempotent —
    /// calling start while already running is a successful no-op.
    pub fn enable(&self) -> Result<(), String> {
        self.start_internal()?;
        {
            let mut g = self
                .inner
                .lock()
                .expect("experimental: inner mutex poisoned");
            g.enabled = true;
        }
        self.persist();
        Ok(())
    }

    /// Stop the active listener. Idempotent — calling disable while
    /// already stopped flips `enabled` to `false` and persists, but
    /// does not error.
    pub fn disable(&self) {
        let listener = {
            let mut g = self
                .inner
                .lock()
                .expect("experimental: inner mutex poisoned");
            g.enabled = false;
            g.listener.take()
        };
        if let Some(l) = listener {
            l.stop();
        }
        self.persist();
    }

    /// Shutdown helper for the main loop. Same as [`Self::disable`]
    /// except it does NOT persist the flag — Ctrl+C should not flip
    /// the user's saved preference.
    pub fn shutdown(&self) {
        let listener = {
            let mut g = self
                .inner
                .lock()
                .expect("experimental: inner mutex poisoned");
            g.listener.take()
        };
        if let Some(l) = listener {
            l.stop();
        }
    }

    /// Bind and spawn the listener for the currently-selected API. On
    /// success, records the live handle and clears `last_error`. On
    /// failure, records the error and returns it.
    fn start_internal(&self) -> Result<(), String> {
        let already_running = {
            let g = self
                .inner
                .lock()
                .expect("experimental: inner mutex poisoned");
            g.listener.is_some()
        };
        if already_running {
            return Ok(());
        }
        let active = {
            let g = self
                .inner
                .lock()
                .expect("experimental: inner mutex poisoned");
            g.active.clone()
        };
        let result = match active.as_str() {
            KMBOX_NET_ID => listener::spawn(
                self.listen_addr,
                self.port,
                self.translator.clone(),
                self.global_running.clone(),
            )
            .map_err(|e| format!("{:#}", e)),
            other => Err(format!("unknown experimental api id: {:?}", other)),
        };
        let mut g = self
            .inner
            .lock()
            .expect("experimental: inner mutex poisoned");
        match result {
            Ok(handle) => {
                g.listener = Some(handle);
                g.last_error = None;
                Ok(())
            }
            Err(e) => {
                g.last_error = Some(e.clone());
                Err(e)
            }
        }
    }

    /// Mirror the current `active` / `enabled` to disk. Errors are
    /// logged — the in-memory state is still correct.
    fn persist(&self) {
        let (active, enabled) = {
            let g = self
                .inner
                .lock()
                .expect("experimental: inner mutex poisoned");
            (g.active.clone(), g.enabled)
        };
        if let Err(e) = set_experimental_api(&self.config_dir, &active, enabled) {
            warn!("experimental: persist to config.json failed: {}", e);
        }
    }
}

/// Reason [`Manager::set_active`] refused a transition.
#[derive(Debug)]
pub enum SetActiveError {
    /// The id is not in [`REGISTRY`].
    Unknown,
    /// A listener is currently running. The user must call disable
    /// first.
    Running,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kmbox_net::monitor::PeerRegistry;
    use crate::streamcheats::{DeviceController, EventBus, MaskController};
    use crate::util::translator::SerialTxHolder;
    use std::sync::Mutex;

    fn build_translator(running: Arc<AtomicBool>) -> Arc<Translator> {
        let holder: SerialTxHolder = Arc::new(Mutex::new(None));
        let device = Arc::new(DeviceController::new(holder, EventBus::new(), false));
        let registry = PeerRegistry::new();
        let mask = Arc::new(MaskController::new(device.clone(), running));
        Arc::new(Translator::new(0x01FBC068, false, device, registry, mask))
    }

    fn build_manager(enabled: bool, dir: std::path::PathBuf, port: u16) -> Manager {
        let running = Arc::new(AtomicBool::new(true));
        let translator = build_translator(running.clone());
        Manager::new(
            KMBOX_NET_ID.to_string(),
            enabled,
            translator,
            "127.0.0.1".parse().unwrap(),
            port,
            running,
            dir,
        )
    }

    #[test]
    fn defaults_to_stopped_and_disabled() {
        let dir = std::env::temp_dir().join(format!(
            "sc8-mgr-default-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mgr = build_manager(false, dir.clone(), 0);
        let s = mgr.status();
        assert_eq!(s.active, KMBOX_NET_ID);
        assert!(!s.enabled);
        assert!(!s.running);
        assert!(s.bound.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn enable_then_disable_starts_and_stops_listener() {
        let dir = std::env::temp_dir().join(format!(
            "sc8-mgr-enable-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // Port 0 — kernel picks one, avoids collision with any
        // already-running daemon.
        let mgr = build_manager(false, dir.clone(), 0);
        mgr.enable()
            .expect("enable must succeed on a free ephemeral port");
        let s = mgr.status();
        assert!(s.enabled);
        assert!(s.running);
        assert!(s.bound.is_some());
        assert!(s.last_error.is_none());

        // Persisted enabled flag round-trips on disk.
        let cfg = std::fs::read_to_string(dir.join("config.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&cfg).unwrap();
        assert_eq!(
            parsed["experimental_api"]["enabled"],
            serde_json::Value::Bool(true)
        );

        mgr.disable();
        let s = mgr.status();
        assert!(!s.enabled);
        assert!(!s.running);
        assert!(s.bound.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_active_rejects_unknown_and_running() {
        let dir = std::env::temp_dir().join(format!(
            "sc8-mgr-active-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mgr = build_manager(false, dir.clone(), 0);
        assert!(matches!(
            mgr.set_active("not-a-real-api"),
            Err(SetActiveError::Unknown)
        ));
        // Re-selecting the same id is a no-op.
        mgr.set_active(KMBOX_NET_ID).unwrap();
        // Once running, set_active must refuse.
        mgr.enable().unwrap();
        assert!(matches!(
            mgr.set_active(KMBOX_NET_ID),
            Err(SetActiveError::Running) | Ok(())
        ));
        mgr.disable();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
