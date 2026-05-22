//! Per-peer bookkeeping for the monitor subscriber.

use std::time::Instant;

/// What the registry remembers about each subscribed monitor peer.
///
/// The `target_addr` is computed once at registration time from the
/// peer's UDP source address (its `ip`) and the port carried in the
/// `cmd_monitor` payload (`head.rand & 0xFFFF`). We deliberately do NOT
/// store the source port the request arrived on — the vendor SDK's
/// `ThreadListenProcess` binds a fresh socket on the *requested* port
/// (`kmboxNet.cpp:1517`), so the host app's outbound request socket and
/// its inbound listening socket are different ports.
#[derive(Debug, Clone)]
pub struct PeerInfo {
    /// Wall-clock instant the peer first registered. Preserved across
    /// re-registrations (cmd_monitor from a peer already in the table
    /// updates `last_emit_at` but leaves `registered_at` untouched).
    /// Read today only by the registry's `Refreshed`-path test; the
    /// future bug-report / diagnostics dashboard (task #7) will surface
    /// this as "subscribed since X".
    #[allow(dead_code)]
    pub registered_at: Instant,
    /// Most recent successful emit to this peer. `None` until the first
    /// `StateChange` after registration. Updated on every successful
    /// `send_to`; a failed send leaves this untouched so a flaky peer
    /// remains visibly stale in diagnostics.
    pub last_emit_at: Option<Instant>,
    /// Monotonic counter of successful emits to this peer since
    /// registration. Wraps via `saturating_add` rather than panicking.
    pub total_emits: u64,
    /// Upper 16 bits of the `cmd_monitor` header's `rand` field. The
    /// vendor SDK always sends `0xAA55` here (per `kmboxNet.cpp:1583`),
    /// so this is informational only today — kept on the struct so a
    /// future protocol revision that uses these bits for sub-mode
    /// selection (e.g. mouse-only / keyboard-only) lands without an
    /// API break.
    pub mode_flags: u16,
}

impl PeerInfo {
    /// Build a fresh PeerInfo at `now` with no emits yet recorded.
    pub fn new(now: Instant, mode_flags: u16) -> Self {
        Self {
            registered_at: now,
            last_emit_at: None,
            total_emits: 0,
            mode_flags,
        }
    }

    /// Record a successful emit at `now`. Called by the subscriber
    /// thread after `send_to` returns Ok.
    pub fn note_emit(&mut self, now: Instant) {
        self.last_emit_at = Some(now);
        self.total_emits = self.total_emits.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_starts_with_zero_emits_and_no_last_emit() {
        let p = PeerInfo::new(Instant::now(), 0xAA55);
        assert_eq!(p.total_emits, 0);
        assert!(p.last_emit_at.is_none());
        assert_eq!(p.mode_flags, 0xAA55);
    }

    #[test]
    fn note_emit_updates_count_and_timestamp() {
        let t0 = Instant::now();
        let mut p = PeerInfo::new(t0, 0);
        let t1 = Instant::now();
        p.note_emit(t1);
        assert_eq!(p.total_emits, 1);
        assert_eq!(p.last_emit_at, Some(t1));
        p.note_emit(t1);
        assert_eq!(p.total_emits, 2);
    }
}
