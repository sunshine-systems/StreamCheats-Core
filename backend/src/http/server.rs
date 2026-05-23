//! HTTP server lifecycle.
//!
//! [`spawn_http_server`] picks up the shared [`AppState`], binds
//! `127.0.0.1:0`, publishes the kernel-assigned port to the daemon
//! temp-file conventions, and runs an axum app inside a dedicated
//! tokio runtime on a fresh `std::thread`. The thread joins cleanly
//! on graceful shutdown via the shared `running: Arc<AtomicBool>` flag.
//!
//! Only this surface is async — the rest of the daemon (UDP listener,
//! serial supervisor, monitor emitter, heartbeat) stays std-thread
//! based as before.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tokio::net::TcpListener;
use tracing::{error, info, warn};

use crate::firmware;
use crate::http::routes::build_router;
use crate::http::state::AppState;
use crate::updater;
use crate::util::daemon;

/// Cadence at which the graceful-shutdown future polls `running`. Kept
/// short so axum tears down within ~250 ms of Ctrl+C.
const SHUTDOWN_POLL: Duration = Duration::from_millis(250);

/// Spawn the HTTP server thread.
///
/// `state_template` is filled in for every field EXCEPT `http_listen`,
/// which we patch after the bind succeeds. Returns the thread's
/// [`JoinHandle`] AND the bound `SocketAddr` so `main` can publish it
/// (already done internally here too — `main` just needs it for the
/// startup log line).
///
/// Returns `None` if binding failed; the rest of the daemon keeps
/// running, the user just doesn't get the bug-report endpoint.
pub fn spawn_http_server(
    mut state_template: AppState,
    running: Arc<AtomicBool>,
) -> Option<(JoinHandle<()>, SocketAddr)> {
    // Build the tokio runtime synchronously so we can resolve the bound
    // port BEFORE returning from this function — `main` wants to log it
    // alongside the UDP port.
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .thread_name("http-server")
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            error!("http: could not build tokio runtime: {}", e);
            return None;
        }
    };

    let listener = match runtime.block_on(TcpListener::bind("127.0.0.1:0")) {
        Ok(l) => l,
        Err(e) => {
            error!("http: bind 127.0.0.1:0 failed: {}", e);
            return None;
        }
    };

    let bound = match listener.local_addr() {
        Ok(a) => a,
        Err(e) => {
            error!("http: local_addr() failed after bind: {}", e);
            return None;
        }
    };
    state_template.http_listen = bound;

    if let Err(e) = daemon::write_http_port(bound.port()) {
        warn!("http: could not write http_port file: {}", e);
    } else {
        info!("http: pid={} http_port={}", std::process::id(), bound.port());
    }

    // Spawn the background updater poller inside the HTTP runtime so
    // it shares the same reactor as the route handlers (they all read
    // the same `Arc<Updater>` state mutex). Done before `axum::serve`
    // so the first check kicks off as soon as the runtime is live.
    let updater_handle = state_template.updater.clone();
    runtime.spawn(async move {
        updater::spawn_poller(updater_handle);
    });

    // Firmware updater poller — same pattern as the software updater.
    // Spawned inside the HTTP runtime so it shares the reactor with the
    // route handlers that read its state.
    let firmware_handle = state_template.firmware.clone();
    runtime.spawn(async move {
        firmware::spawn_poller(firmware_handle);
    });

    let router = build_router(state_template);

    let handle = thread::Builder::new()
        .name("http-server-driver".into())
        .spawn(move || {
            let shutdown_running = running.clone();
            runtime.block_on(async move {
                let shutdown = async move {
                    while shutdown_running.load(Ordering::SeqCst) {
                        tokio::time::sleep(SHUTDOWN_POLL).await;
                    }
                    info!("http: shutdown flag observed — winding down server");
                };
                if let Err(e) = axum::serve(listener, router)
                    .with_graceful_shutdown(shutdown)
                    .await
                {
                    error!("http: axum::serve exited with error: {}", e);
                }
            });
        })
        .expect("http-server-driver thread must spawn");

    Some((handle, bound))
}
