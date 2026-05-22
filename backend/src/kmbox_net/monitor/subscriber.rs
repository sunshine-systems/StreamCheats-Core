//! Long-running emitter thread that bridges the streamcheats
//! [`EventBus`] to registered monitor peers over UDP.
//!
//! # What it does
//!
//! 1. Subscribes once to the [`DeviceController`]'s event bus.
//! 2. Loops on `recv_timeout(250ms)` so it exits promptly when the
//!    process-wide `running` flag flips.
//! 3. On each [`StateChange`], snapshots the [`PeerRegistry`]. If
//!    *zero* peers are registered, does nothing (no send, no log) —
//!    this is the user-revised rule that keeps the log quiet in the
//!    common case of "host app never enabled monitor mode".
//! 4. Otherwise builds the 20-byte echo packet via [`super::encoder`]
//!    and `send_to`s it to each peer's target address, then bumps that
//!    peer's `last_emit_at` / `total_emits` and logs a single
//!    `MONITOR: emit ... -> <peer>` line per peer per event.
//!
//! # Why a separate UDP socket
//!
//! The vendor SDK's `ThreadListenProcess` opens its own dedicated
//! socket on the receive side (`kmboxNet.cpp:1511`) — symmetric with
//! how we want to bind a dedicated *outbound* socket here. Mixing
//! monitor sends onto the translator's main listening socket would
//! work on the wire (UDP doesn't care) but would couple the two
//! lifetimes — a future change to the listening socket's bind options
//! shouldn't be allowed to break monitor-mode emit. We bind
//! `0.0.0.0:0` so the OS picks an ephemeral source port; the SDK
//! source has no requirement on the box's outbound source port.
//!
//! [`EventBus`]: crate::streamcheats::EventBus
//! [`DeviceController`]: crate::streamcheats::DeviceController

use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tracing::{info, warn};

use super::encoder::encode_state;
use super::peer_registry::PeerRegistry;
use crate::streamcheats::StateChange;

/// How long the subscriber blocks waiting for an event before re-checking
/// the shutdown flag. Matches the UDP main loop's read timeout so the
/// process tears down with similar latency from both threads.
const RECV_TIMEOUT: Duration = Duration::from_millis(250);

/// Tiny abstraction so unit tests can substitute a recording fake for
/// `UdpSocket`. The real impl is a one-line forward to
/// [`UdpSocket::send_to`]; the test impl pushes into a `Vec`.
///
/// One method — `send_to(&self, &[u8], SocketAddr) -> io::Result<usize>`
/// — keeps the surface minimal and matches the std signature so the
/// real impl is trivial.
pub trait MonitorSender: Send + Sync {
    /// Send `bytes` to `peer`. Mirrors `UdpSocket::send_to`'s signature
    /// and semantics; the return value is the number of bytes the OS
    /// accepted, but the subscriber loop only cares about Ok/Err.
    fn send_to(&self, bytes: &[u8], peer: SocketAddr) -> std::io::Result<usize>;
}

impl MonitorSender for UdpSocket {
    fn send_to(&self, bytes: &[u8], peer: SocketAddr) -> std::io::Result<usize> {
        UdpSocket::send_to(self, bytes, peer)
    }
}

/// Spawn the subscriber thread. Returns its [`JoinHandle`] so the
/// caller can join cleanly at shutdown. The thread:
///
/// * owns `bus_rx` (the receiver returned by
///   [`crate::streamcheats::DeviceController::subscribe`]),
/// * holds a clone of the shared [`PeerRegistry`],
/// * binds a dedicated outbound UDP socket on `0.0.0.0:0`, and
/// * runs until the shared `running` flag flips to `false`.
///
/// Binding failure is logged at error level and the thread exits
/// immediately — the main listener keeps running, the translator
/// keeps replying to UDP, but monitor-mode emit is silently disabled
/// for this process lifetime. We chose log-and-degrade over panic
/// because a transient bind failure (e.g. a firewall mid-flap)
/// shouldn't kill the whole bridge.
pub fn spawn_monitor_thread(
    registry: PeerRegistry,
    bus_rx: Receiver<StateChange>,
    running: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("monitor_emitter".into())
        .spawn(move || {
            let socket = match UdpSocket::bind("0.0.0.0:0") {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(
                        "monitor: could not bind outbound UDP socket: {} — monitor-mode emit disabled for this run",
                        e
                    );
                    return;
                }
            };
            if let Ok(local) = socket.local_addr() {
                info!("monitor: emitter thread up, sending from {}", local);
            }
            run_loop(&socket, registry, bus_rx, running);
        })
        .expect("monitor_emitter thread spawn must not fail")
}

/// Core event loop, extracted from the thread closure so unit tests can
/// drive it without spinning up a real `UdpSocket` (the tests pass a
/// `RecordingSender` instead).
pub(crate) fn run_loop(
    sender: &dyn MonitorSender,
    registry: PeerRegistry,
    bus_rx: Receiver<StateChange>,
    running: Arc<AtomicBool>,
) {
    while running.load(Ordering::SeqCst) {
        match bus_rx.recv_timeout(RECV_TIMEOUT) {
            Ok(change) => dispatch(sender, &registry, change),
            Err(RecvTimeoutError::Timeout) => {
                // Re-check `running` and keep waiting. Logging here
                // would create one line per 250 ms forever — silence is
                // the right choice.
            }
            Err(RecvTimeoutError::Disconnected) => {
                // The DeviceController was dropped, which means the
                // process is on its way down. Exit cleanly.
                info!("monitor: event bus closed — emitter thread exiting");
                return;
            }
        }
    }
    info!("monitor: shutdown flag tripped — emitter thread exiting");
}

/// Process one [`StateChange`]: peer-list snapshot, encode, fan-out,
/// log. Pulled into its own function so the test path can call it
/// directly without needing a real `Receiver`.
fn dispatch(sender: &dyn MonitorSender, registry: &PeerRegistry, change: StateChange) {
    // Hard short-circuit on zero peers. Per the v1 contract: NO log,
    // NO send, NO work. The bus publish itself already happened
    // upstream, so this branch is the entire "monitor mode is off"
    // cost: one HashMap len() check.
    let peers = registry.list_peers();
    if peers.is_empty() {
        return;
    }

    // Build the per-event encoder inputs ONCE so we send the same bytes
    // to every peer. The encoder is pure — given identical inputs it
    // produces identical bytes — so this also keeps the per-peer cost
    // down to one `send_to` syscall.
    let (event_label, pkt) = encode_for_event(&change);

    for (addr, _info) in peers {
        match sender.send_to(&pkt, addr) {
            Ok(_) => {
                let now = Instant::now();
                registry.note_emit(addr, now);
                info!("MONITOR: emit {} -> {}", event_label, addr);
            }
            Err(e) => {
                // Transient network blip — log and keep going. We do
                // NOT unregister the peer because the SDK has no
                // protocol-level "unsubscribe on failure" semantic;
                // de-registration is reserved for explicit
                // `cmd_monitor(0)` or future timeout-based eviction
                // (see PeerRegistry TODO).
                warn!("MONITOR: send to {} failed: {}", addr, e);
            }
        }
    }
}

/// Render a one-token event label for the log line AND build the wire
/// packet from the event's payload. Kept as one function so the label
/// and the packet are always derived from the same match arm — they
/// can't drift out of sync.
fn encode_for_event(change: &StateChange) -> (String, [u8; super::super::schema::MONITOR_PACKET_LEN]) {
    match change {
        StateChange::ButtonsChanged { to, .. } => (
            format!("ButtonsChanged{{0x{:02X}}}", to),
            encode_state(*to, 0, 0, 0),
        ),
        StateChange::MoveEmitted {
            dx,
            dy,
            button_mask,
            ..
        } => (
            format!("MoveEmitted{{dx={},dy={},btn=0x{:02X}}}", dx, dy, button_mask),
            encode_state(*button_mask, *dx, *dy, 0),
        ),
        StateChange::WheelEmitted {
            wheel,
            button_mask,
            ..
        } => (
            format!("WheelEmitted{{w={},btn=0x{:02X}}}", wheel, button_mask),
            encode_state(*button_mask, 0, 0, *wheel as i16),
        ),
        StateChange::Reset { .. } => (
            "Reset".to_string(),
            // A reset translates to "all zero" on the wire — the vendor
            // SDK has no dedicated reset opcode in monitor mode, so the
            // cleanest signal is a zeroed state report.
            encode_state(0, 0, 0, 0),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};
    use std::sync::Mutex as StdMutex;

    /// Recording fake — captures every `send_to` call so tests can
    /// assert on call count + payload bytes + destinations.
    #[derive(Default)]
    struct RecordingSender {
        calls: StdMutex<Vec<(Vec<u8>, SocketAddr)>>,
    }
    impl RecordingSender {
        fn calls(&self) -> Vec<(Vec<u8>, SocketAddr)> {
            self.calls.lock().unwrap().clone()
        }
    }
    impl MonitorSender for RecordingSender {
        fn send_to(&self, bytes: &[u8], peer: SocketAddr) -> std::io::Result<usize> {
            self.calls
                .lock()
                .unwrap()
                .push((bytes.to_vec(), peer));
            Ok(bytes.len())
        }
    }

    fn ip(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(a, b, c, d))
    }

    fn buttons_event(to: u8) -> StateChange {
        StateChange::ButtonsChanged {
            from: 0,
            to,
            at: Instant::now(),
        }
    }

    /// Spec rule (a): with zero peers, a StateChange produces zero
    /// sends. No logs would appear either; we assert the observable
    /// part (sends).
    #[test]
    fn no_peers_means_no_sends() {
        let reg = PeerRegistry::new();
        let sender = RecordingSender::default();
        dispatch(&sender, &reg, buttons_event(0x02));
        assert_eq!(sender.calls().len(), 0);
    }

    /// Spec rule (b): with one peer, one StateChange triggers one
    /// send to the peer's target address, carrying the encoded bytes.
    #[test]
    fn one_peer_one_event_one_send() {
        let reg = PeerRegistry::new();
        let addr = SocketAddr::new(ip(192, 168, 1, 50), 6000);
        reg.register(addr.ip(), addr.port(), 0xAA55, Instant::now());
        let sender = RecordingSender::default();
        dispatch(&sender, &reg, buttons_event(0x02));
        let calls = sender.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1, addr);
        // Bytes match the encoder's 20-byte output for buttons=0x02.
        assert_eq!(calls[0].0.len(), super::super::super::schema::MONITOR_PACKET_LEN);
        assert_eq!(calls[0].0[1], 0x02, "buttons byte");
    }

    /// Spec rule (c): with two peers, one event produces exactly two
    /// sends — same bytes, different destinations.
    #[test]
    fn two_peers_one_event_two_sends_same_bytes() {
        let reg = PeerRegistry::new();
        let a = SocketAddr::new(ip(10, 0, 0, 1), 7000);
        let b = SocketAddr::new(ip(10, 0, 0, 2), 7001);
        reg.register(a.ip(), a.port(), 0xAA55, Instant::now());
        reg.register(b.ip(), b.port(), 0xAA55, Instant::now());
        let sender = RecordingSender::default();
        dispatch(&sender, &reg, buttons_event(0x04));
        let calls = sender.calls();
        assert_eq!(calls.len(), 2);
        // Order is HashMap-iteration-dependent so sort by addr first.
        let mut dests: Vec<SocketAddr> = calls.iter().map(|c| c.1).collect();
        dests.sort();
        let mut expected = vec![a, b];
        expected.sort();
        assert_eq!(dests, expected);
        // Both payloads identical.
        assert_eq!(calls[0].0, calls[1].0);
    }

    /// Move events should encode dx/dy into bytes 2..6.
    #[test]
    fn move_event_encodes_deltas() {
        let reg = PeerRegistry::new();
        let addr = SocketAddr::new(ip(127, 0, 0, 1), 9000);
        reg.register(addr.ip(), addr.port(), 0, Instant::now());
        let sender = RecordingSender::default();
        dispatch(
            &sender,
            &reg,
            StateChange::MoveEmitted {
                dx: 10,
                dy: 10,
                button_mask: 0x02,
                at: Instant::now(),
            },
        );
        let calls = sender.calls();
        assert_eq!(calls.len(), 1);
        let p = &calls[0].0;
        assert_eq!(p[1], 0x02);
        assert_eq!(&p[2..4], &[0x0A, 0x00]);
        assert_eq!(&p[4..6], &[0x0A, 0x00]);
    }

    /// Successful send must bump the peer's `total_emits`.
    #[test]
    fn successful_send_bumps_total_emits() {
        let reg = PeerRegistry::new();
        let addr = SocketAddr::new(ip(127, 0, 0, 1), 9000);
        reg.register(addr.ip(), addr.port(), 0, Instant::now());
        let sender = RecordingSender::default();
        dispatch(&sender, &reg, buttons_event(0x01));
        dispatch(&sender, &reg, buttons_event(0x02));
        let peers = reg.list_peers();
        assert_eq!(peers[0].1.total_emits, 2);
        assert!(peers[0].1.last_emit_at.is_some());
    }

    /// Failing sender — emulate a network blip. We MUST NOT unregister
    /// the peer; the next event should still attempt to send.
    struct FailingSender;
    impl MonitorSender for FailingSender {
        fn send_to(&self, _bytes: &[u8], _peer: SocketAddr) -> std::io::Result<usize> {
            Err(std::io::Error::new(std::io::ErrorKind::Other, "boom"))
        }
    }

    #[test]
    fn send_failure_does_not_unregister_peer() {
        let reg = PeerRegistry::new();
        let addr = SocketAddr::new(ip(127, 0, 0, 1), 9000);
        reg.register(addr.ip(), addr.port(), 0, Instant::now());
        dispatch(&FailingSender, &reg, buttons_event(0x01));
        assert_eq!(reg.len(), 1, "send failure must NOT prune the peer");
        // total_emits stays at 0 because the send failed.
        assert_eq!(reg.list_peers()[0].1.total_emits, 0);
    }
}
