//! Event variants published on the [`super::bus::EventBus`] whenever the
//! [`super::super::device::DeviceController`] mutates state.
//!
//! Design notes:
//! * `Move`/`Wheel` variants carry the full `button_mask` alongside their
//!   delta so subscribers (the future `kmbox_net::monitor` UDP emitter,
//!   diagnostics dashboards) can describe the complete device state at
//!   that instant without re-locking the controller. This duplicates a
//!   tiny amount of data on the wire in exchange for lock-free reads on
//!   the subscriber side, which is the right trade-off because the bus
//!   is the hot path during gaming sessions.
//! * `ButtonsChanged` fires ONLY when the mask actually changed
//!   (`from != to`). Move/Wheel events fire on every emit regardless of
//!   whether the delta is zero — subscribers may legitimately want to
//!   observe cadence (e.g. tick rate from interpolation workers).

use std::time::Instant;

/// One mutation of the proxied device's state, published on the event
/// bus immediately after the corresponding serial packet has been
/// dispatched.
///
/// Fields are read by future subscribers (e.g. the planned
/// `kmbox_net::monitor` emitter — task #9) that have not yet been
/// wired in. `allow(dead_code)` keeps the build warning-clean today
/// without forcing the variant payload to be reshaped when the
/// subscriber lands.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub enum StateChange {
    /// The cumulative button mask actually changed (caller has verified
    /// `from != to`). A no-op `apply_buttons` does NOT publish this.
    ButtonsChanged {
        from: u8,
        to: u8,
        at: Instant,
    },
    /// A relative-move serial packet was emitted. Fires every call —
    /// including no-op (0,0) ticks from interpolation workers — because
    /// monitor subscribers may want cadence visibility.
    MoveEmitted {
        dx: i16,
        dy: i16,
        button_mask: u8,
        at: Instant,
    },
    /// A wheel serial packet was emitted. Fires every call regardless
    /// of magnitude, mirroring `MoveEmitted`.
    WheelEmitted {
        wheel: i8,
        button_mask: u8,
        at: Instant,
    },
    /// `cmd_connect` (or another explicit reset) cleared the volatile
    /// device state. The lifetime emission counter is intentionally NOT
    /// included here because it survives reset (see [`super::device_state::DeviceState::reset`]).
    Reset {
        at: Instant,
    },
}
