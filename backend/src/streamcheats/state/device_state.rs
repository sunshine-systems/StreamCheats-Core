//! Authoritative snapshot of the proxied HID device's current logical
//! state — button mask, last-emitted move/wheel deltas, and emission
//! counters. Lives behind a [`Mutex`](std::sync::Mutex) inside
//! [`super::super::device::DeviceController`].
//!
//! The fields here intentionally mirror what a downstream subscriber
//! (e.g. the future `kmbox_net::monitor` UDP emitter) would need to
//! describe the device's state without re-reading the serial stream.

use std::time::Instant;

/// Authoritative device state owned by `DeviceController`. Cloneable so
/// callers can take a cheap snapshot without holding the controller's
/// mutex across whatever they do next with the data (build a UDP
/// packet, render a status line, etc.).
#[derive(Debug, Clone, Default)]
pub struct DeviceState {
    /// Cumulative HID mouse button mask (LMB=0x01, RMB=0x02, MMB=0x04,
    /// SIDE1=0x08, SIDE2=0x10). Updated by `apply_buttons` and by every
    /// `apply_move`/`apply_wheel` call (which carry the current mask as
    /// the third byte of the wire packet but do not modify it).
    pub button_mask: u8,
    /// Most recent dx applied via `apply_move`. NOT cumulative.
    pub last_dx: i16,
    /// Most recent dy applied via `apply_move`. NOT cumulative.
    pub last_dy: i16,
    /// Most recent wheel delta applied via `apply_wheel`. NOT cumulative.
    pub last_wheel: i8,
    /// Timestamp of the most recent successful state update.
    pub last_update_at: Option<Instant>,
    /// Monotonic count of serial packets the controller has emitted
    /// since process start. Survives `reset()` (see docs there) so that
    /// long-running diagnostics keep a stable lifetime counter.
    pub total_packets_emitted: u64,
}

impl DeviceState {
    /// Cheap deep copy. Provided as a named method so callers reading
    /// the controller's state through a guard make the intent obvious
    /// at the call site (`state.snapshot()` vs the more ambiguous
    /// `state.clone()`).
    #[allow(dead_code)]
    pub fn snapshot(&self) -> DeviceState {
        self.clone()
    }

    /// Zero the volatile bits (buttons, last move/wheel deltas, last
    /// update timestamp) but PRESERVE `total_packets_emitted` so the
    /// lifetime counter survives a `cmd_connect` reset. Picked over
    /// "zero everything" because total_packets_emitted is most useful
    /// when it spans the full session — a host app rebinding via
    /// reconnect shouldn't make the counter lie about traffic the
    /// translator actually generated.
    pub fn reset(&mut self) {
        self.button_mask = 0;
        self.last_dx = 0;
        self.last_dy = 0;
        self.last_wheel = 0;
        self.last_update_at = None;
        // total_packets_emitted intentionally preserved.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_state_reset_clears_buttons() {
        let mut s = DeviceState {
            button_mask: 0x02,
            last_dx: 10,
            last_dy: -5,
            last_wheel: 1,
            last_update_at: Some(Instant::now()),
            total_packets_emitted: 42,
        };
        s.reset();
        assert_eq!(s.button_mask, 0);
        assert_eq!(s.last_dx, 0);
        assert_eq!(s.last_dy, 0);
        assert_eq!(s.last_wheel, 0);
        assert!(s.last_update_at.is_none());
        assert_eq!(
            s.total_packets_emitted, 42,
            "reset must preserve the lifetime emission counter"
        );
    }

    #[test]
    fn snapshot_is_independent_copy() {
        let mut s = DeviceState::default();
        s.button_mask = 0x01;
        let snap = s.snapshot();
        s.button_mask = 0x04;
        assert_eq!(snap.button_mask, 0x01);
        assert_eq!(s.button_mask, 0x04);
    }
}
