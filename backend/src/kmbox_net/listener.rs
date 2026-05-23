//! UDP recv loop for the kmbox-net experimental API.
//!
//! Historically this loop ran inline at the bottom of `main::run` and
//! lived for the entire process lifetime. SC-8 lifted it out so the
//! `experimental::Manager` can start and stop it on demand without
//! tearing down the rest of the daemon (heartbeat, supervisor, device
//! controller, monitor emitter all stay running across enable/disable
//! transitions).
//!
//! Lifecycle:
//!   * [`spawn`] binds a fresh `UdpSocket` at `addr:port`, publishes
//!     the bound port to the daemon temp-file conventions, and spawns
//!     a worker thread that drives [`Translator::handle_packet`] for
//!     every datagram.
//!   * The worker exits when EITHER the per-listener `stop_flag` flips
//!     to `false` OR the global `running` flag flips to `false`. On
//!     exit the worker clears the published port file so the GUI does
//!     not see a stale UDP port for a stopped listener.
//!   * Dropping the socket releases the kernel port the moment the
//!     worker returns — there is no in-flight `recv_from` to drain
//!     because the 250 ms read timeout keeps the wakeup latency low.

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::{Context, Result};
use tracing::{info, warn};

use crate::util::daemon;
use crate::util::translator::Translator;

/// Wakeup cadence on the `running` / `stop_flag` polling. Matches the
/// historical 250 ms `set_read_timeout` so disable + Ctrl+C both feel
/// responsive without busy-spinning the worker.
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Live handle to a running kmbox-net listener. Dropping the handle
/// does NOT stop the listener (the manager owns shutdown coordination);
/// call [`Listener::stop`] explicitly.
pub struct Listener {
    addr: SocketAddr,
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Listener {
    /// Bound address the listener is currently accepting datagrams on.
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// Flip the stop flag and join the worker thread. Returns once the
    /// worker has released the socket. Idempotent — calling stop after
    /// the worker has already exited (e.g. on global shutdown) is a
    /// no-op.
    pub fn stop(mut self) {
        self.stop_flag.store(false, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// Spawn the listener. Binds synchronously so the caller gets the
/// kernel-assigned port (when `port == 0`) before this function
/// returns.
///
/// `translator` is shared (Arc) so the manager can keep its own
/// reference and re-use it across start/stop cycles without rebuilding
/// the device-controller wiring on every toggle.
///
/// `global_running` is the daemon's master shutdown flag. The listener
/// honours it in addition to its own `stop_flag` so Ctrl+C tears
/// everything down cleanly even when the listener is currently up.
pub fn spawn(
    listen_addr: IpAddr,
    port: u16,
    translator: Arc<Translator>,
    global_running: Arc<AtomicBool>,
) -> Result<Listener> {
    let bind = SocketAddr::new(listen_addr, port);
    let socket =
        UdpSocket::bind(bind).with_context(|| format!("binding UDP socket at {}", bind))?;

    // Mirror the recv-buffer bump that used to live in main.rs. Failure
    // is non-fatal: we log and continue with the OS default.
    {
        let sock_ref = socket2::SockRef::from(&socket);
        let desired = 256 * 1024;
        if let Err(e) = sock_ref.set_recv_buffer_size(desired) {
            warn!(
                "kmbox-net listener: could not bump SO_RCVBUF to {} bytes: {} (continuing with OS default)",
                desired, e
            );
        } else {
            let actual = sock_ref.recv_buffer_size().unwrap_or(0);
            info!(
                "kmbox-net listener: recv buffer set to {} bytes (requested {})",
                actual, desired
            );
        }
    }

    socket
        .set_read_timeout(Some(POLL_INTERVAL))
        .context("setting UDP read timeout")?;

    let bound = socket
        .local_addr()
        .context("reading local_addr after bind")?;

    if let Err(e) = daemon::write_port(bound.port()) {
        warn!("kmbox-net listener: could not write port file: {}", e);
    } else {
        info!(
            "kmbox-net listener: pid={} port={}",
            std::process::id(),
            bound.port()
        );
    }

    let stop_flag = Arc::new(AtomicBool::new(true));
    let worker_stop = stop_flag.clone();
    let worker_running = global_running;
    let handle = thread::Builder::new()
        .name("kmbox-net-listener".into())
        .spawn(move || worker(socket, translator, worker_stop, worker_running))
        .context("spawning kmbox-net listener thread")?;

    info!("kmbox-net listener: started on {}", bound);

    Ok(Listener {
        addr: bound,
        stop_flag,
        handle: Some(handle),
    })
}

/// Worker body. Receives datagrams, dispatches through the translator,
/// and exits on `stop_flag` or `global_running` flipping to `false`.
fn worker(
    socket: UdpSocket,
    translator: Arc<Translator>,
    stop_flag: Arc<AtomicBool>,
    global_running: Arc<AtomicBool>,
) {
    let mut buf = [0u8; 2048];
    while stop_flag.load(Ordering::SeqCst) && global_running.load(Ordering::SeqCst) {
        match socket.recv_from(&mut buf) {
            Ok((n, peer)) => {
                let datagram = &buf[..n];
                if let Some(reply) = translator.handle_packet(datagram, peer) {
                    if let Err(e) = socket.send_to(&reply, peer) {
                        warn!(
                            "kmbox-net listener: failed to send reply to {}: {}",
                            peer, e
                        );
                    }
                }
            }
            Err(e) => match e.kind() {
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => {
                    // Read timeout — loop and re-check the flags.
                }
                _ => {
                    warn!("kmbox-net listener: recv_from error: {}", e);
                }
            },
        }
    }

    // Clear the published port — a stopped listener has no port to
    // advertise. Best effort; missing file is fine.
    if let Err(e) = daemon::clear_port() {
        tracing::debug!("kmbox-net listener: clear_port failed: {}", e);
    }
    info!("kmbox-net listener: stopped");
}
