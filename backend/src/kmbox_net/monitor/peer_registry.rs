//! Thread-safe table of currently-subscribed monitor peers.
//!
//! The translator's UDP dispatch path writes into this registry on every
//! `cmd_monitor`; the [`super::subscriber`] thread reads from it on
//! every `StateChange`. A single shared `Arc<Mutex<HashMap<..>>>` keeps
//! both sides honest without dragging in a parking-lot or crossbeam dep.
//!
//! # De-duplication policy
//!
//! Peers are keyed by their *target* `SocketAddr` (`peer_ip` +
//! `target_port` from the `cmd_monitor` body). A repeated `cmd_monitor`
//! from the same source IP requesting the same target port is treated as
//! a refresh — `last_emit_at` and `total_emits` are preserved, the new
//! `mode_flags` is adopted, and [`RegisterOutcome::Refreshed`] is
//! returned so the caller can suppress its `MONITOR: subscribe` log line
//! (we only want to log the *first* subscribe to keep the log tidy
//! under a host app that re-sends `cmd_monitor` every N seconds — a
//! common keepalive pattern even though the vendor SDK doesn't do that).
//!
//! # Lifecycle
//!
//! For v1 there is no time-based stale-peer eviction. A peer stays
//! registered until either (a) the host app explicitly calls
//! `kmNet_monitor(0)` (we translate that to
//! [`PeerRegistry::unregister`]), or (b) the process exits. TODO: add a
//! configurable idle-timeout sweep — see the inline TODO in the
//! `register` body.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::peer_info::PeerInfo;

/// Reason `register` returned — used by the caller to decide whether to
/// emit a `MONITOR: subscribe` log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterOutcome {
    /// Peer was not previously known. Caller SHOULD log a subscribe line.
    Added,
    /// Peer already existed; we refreshed its `mode_flags`. Caller should
    /// NOT log a subscribe line (avoids spam under a periodic re-send
    /// pattern).
    Refreshed,
}

/// Shared, thread-safe peer table. Cheap to clone — the underlying
/// `HashMap` lives behind a single `Arc<Mutex<..>>` so each clone is
/// just a pointer bump.
#[derive(Clone, Default)]
pub struct PeerRegistry {
    inner: Arc<Mutex<HashMap<SocketAddr, PeerInfo>>>,
}

impl PeerRegistry {
    /// Build an empty registry. Equivalent to `PeerRegistry::default()`.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Add or refresh a peer subscription.
    ///
    /// * `peer_ip` — source IP of the UDP packet carrying the
    ///   `cmd_monitor` (the box doesn't know the peer's IP any other
    ///   way; the SDK doesn't put it in the payload).
    /// * `target_port` — port the peer is listening on for echo
    ///   packets. Comes from the low 16 bits of `head.rand`.
    /// * `mode_flags` — upper 16 bits of `head.rand`. Currently always
    ///   `0xAA55` per the vendor SDK; carried through for future use.
    ///
    /// Returns whether this was a new subscription
    /// ([`RegisterOutcome::Added`]) or a refresh of an existing one
    /// ([`RegisterOutcome::Refreshed`]) so the caller can throttle its
    /// log lines.
    //
    // TODO: per the v1 contract documented in this module, stale peers
    // currently linger until the process exits. A follow-up could add a
    // sweep that drops peers whose `last_emit_at` + `registered_at`
    // gap exceeds some configurable idle threshold (e.g. 30 s with no
    // state change AND no fresh cmd_monitor). Until then, a host app
    // that crashes mid-session leaves its entry in this map; emits to
    // it just fail silently in the subscriber's send path.
    pub fn register(
        &self,
        peer_ip: IpAddr,
        target_port: u16,
        mode_flags: u16,
        now: Instant,
    ) -> RegisterOutcome {
        let addr = SocketAddr::new(peer_ip, target_port);
        let mut guard = self.inner.lock().unwrap();
        match guard.get_mut(&addr) {
            Some(existing) => {
                existing.mode_flags = mode_flags;
                // Intentionally leave registered_at, last_emit_at, and
                // total_emits alone — a refresh shouldn't reset
                // diagnostics counters.
                RegisterOutcome::Refreshed
            }
            None => {
                guard.insert(addr, PeerInfo::new(now, mode_flags));
                RegisterOutcome::Added
            }
        }
    }

    /// Drop a peer's subscription. Called from the translator when the
    /// host app sends `cmd_monitor(0)`. Returns `true` if the peer was
    /// present, `false` if it wasn't (a redundant unsubscribe is not an
    /// error).
    pub fn unregister(&self, peer_ip: IpAddr, target_port: u16) -> bool {
        let addr = SocketAddr::new(peer_ip, target_port);
        self.inner.lock().unwrap().remove(&addr).is_some()
    }

    /// Snapshot of currently-registered peers. Returned as a Vec rather
    /// than a borrowed iterator so the caller can release the mutex
    /// before doing any I/O. Used by the subscriber thread on every
    /// `StateChange`; the clone cost is the size of `PeerInfo` * peers
    /// (negligible — host apps register one peer, occasionally a few).
    pub fn list_peers(&self) -> Vec<(SocketAddr, PeerInfo)> {
        let guard = self.inner.lock().unwrap();
        guard.iter().map(|(a, p)| (*a, p.clone())).collect()
    }

    /// Update bookkeeping after a successful emit to `addr`. Quiet no-op
    /// if the peer has been unregistered between `list_peers` and the
    /// send completing (which is the race we accept to keep the mutex
    /// off the I/O path).
    pub fn note_emit(&self, addr: SocketAddr, now: Instant) {
        if let Some(p) = self.inner.lock().unwrap().get_mut(&addr) {
            p.note_emit(now);
        }
    }

    /// Currently-registered peer count. Used by the subscriber to short-
    /// circuit before doing any per-event work — and by tests.
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }

    /// Convenience for the cheap zero-peers check in the subscriber's
    /// hot path. Equivalent to `self.len() == 0` but reads better at
    /// the call site.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn ip(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(a, b, c, d))
    }

    #[test]
    fn register_adds_new_peer() {
        let reg = PeerRegistry::new();
        let out = reg.register(ip(192, 168, 1, 50), 6000, 0xAA55, Instant::now());
        assert_eq!(out, RegisterOutcome::Added);
        assert_eq!(reg.len(), 1);
        let peers = reg.list_peers();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].0, SocketAddr::new(ip(192, 168, 1, 50), 6000));
        assert_eq!(peers[0].1.mode_flags, 0xAA55);
        assert_eq!(peers[0].1.total_emits, 0);
    }

    #[test]
    fn register_dedupes_same_peer_same_port() {
        let reg = PeerRegistry::new();
        let t0 = Instant::now();
        assert_eq!(
            reg.register(ip(10, 0, 0, 1), 7000, 0xAA55, t0),
            RegisterOutcome::Added
        );
        // Bump the emit count so we can prove `Refreshed` doesn't reset it.
        reg.note_emit(SocketAddr::new(ip(10, 0, 0, 1), 7000), Instant::now());
        // Second register from same (ip, port) is a refresh.
        let t1 = Instant::now();
        assert_eq!(
            reg.register(ip(10, 0, 0, 1), 7000, 0x1234, t1),
            RegisterOutcome::Refreshed
        );
        assert_eq!(reg.len(), 1, "must NOT add a duplicate entry");
        let peers = reg.list_peers();
        assert_eq!(peers[0].1.mode_flags, 0x1234, "mode_flags should refresh");
        assert_eq!(peers[0].1.total_emits, 1, "emit count must persist");
        assert_eq!(
            peers[0].1.registered_at, t0,
            "registered_at must NOT be reset on refresh"
        );
    }

    #[test]
    fn register_distinguishes_same_ip_different_ports() {
        let reg = PeerRegistry::new();
        reg.register(ip(10, 0, 0, 1), 7000, 0, Instant::now());
        reg.register(ip(10, 0, 0, 1), 7001, 0, Instant::now());
        assert_eq!(reg.len(), 2);
    }

    #[test]
    fn unregister_removes_peer_returns_true() {
        let reg = PeerRegistry::new();
        reg.register(ip(10, 0, 0, 1), 7000, 0, Instant::now());
        assert!(reg.unregister(ip(10, 0, 0, 1), 7000));
        assert_eq!(reg.len(), 0);
    }

    #[test]
    fn unregister_unknown_peer_is_noop_returns_false() {
        let reg = PeerRegistry::new();
        assert!(!reg.unregister(ip(10, 0, 0, 1), 7000));
    }

    #[test]
    fn list_peers_returns_snapshot_not_view() {
        // Mutating the registry after list_peers must not affect the
        // returned vec — caller relies on this to release the lock
        // before doing I/O.
        let reg = PeerRegistry::new();
        reg.register(ip(10, 0, 0, 1), 7000, 0, Instant::now());
        let snap = reg.list_peers();
        reg.unregister(ip(10, 0, 0, 1), 7000);
        assert_eq!(snap.len(), 1, "snapshot must be independent of registry");
        assert_eq!(reg.len(), 0);
    }
}
