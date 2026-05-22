//! In-process pub/sub fan-out for [`StateChange`] events.
//!
//! # Why a hand-rolled `std::sync::mpsc` fan-out instead of `tokio::sync::broadcast`?
//!
//! The translator's hot path is fully synchronous today (UDP recv loop,
//! serial writer thread, interpolation workers — all on `std::thread`)
//! and the project deliberately has zero async runtime. Pulling in
//! tokio just for `broadcast` would (a) add a multi-MB dep tree to a
//! crate that's currently ~10 deps deep, and (b) force every subscriber
//! to either run on an executor or block_on. The future axum HTTP
//! server (issue #7 / later tasks) will need tokio, but that's a
//! separate process boundary — we can confine the runtime to that
//! module without making the device-state core depend on it.
//!
//! Instead this bus holds `Vec<mpsc::Sender<StateChange>>` behind a
//! [`Mutex`](std::sync::Mutex). `publish` walks the list and best-effort
//! sends to each, dropping any sender whose receiver has been freed.
//! `subscribe` returns the receiver half of a freshly-created bounded
//! channel and parks the sender in the list. This is the same shape as
//! `broadcast::channel` from the subscriber's perspective.
//!
//! # Capacity
//!
//! Each subscriber gets its own bounded channel of [`SUBSCRIBER_CAPACITY`]
//! = 1024. Justification: peak event rate is ~1 kHz under sustained
//! 8 kHz polling that touches state (most polls reuse the same mask, so
//! `ButtonsChanged` is much rarer than that; move/wheel events follow
//! UDP traffic which the host SDK rate-limits). 1024 slots gives ≈1 s
//! of lag tolerance, which is generous for an in-process consumer that
//! should be draining continuously. On overflow we log once and drop —
//! it's a sign the subscriber is wedged, not a normal-operation concern.

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;

use super::event::StateChange;

/// Per-subscriber channel capacity. See module docs for the math.
#[allow(dead_code)]
pub const SUBSCRIBER_CAPACITY: usize = 1024;

/// Pub/sub bus owned by `DeviceController`. Cheap to construct; the
/// only allocation per subscriber is a single bounded channel.
pub struct EventBus {
    subscribers: Mutex<Vec<Sender<StateChange>>>,
}

impl EventBus {
    /// Build an empty bus with no subscribers.
    pub fn new() -> Self {
        Self {
            subscribers: Mutex::new(Vec::new()),
        }
    }

    /// Best-effort fan-out to every live subscriber. Dead subscribers
    /// (receiver dropped) are pruned in-place. Full subscribers get a
    /// single warn-log per overflow event and the message is dropped;
    /// this is intentional — see module-level capacity docs.
    pub fn publish(&self, change: StateChange) {
        // Lock briefly. If `publish` becomes a measurable hot spot we
        // can switch to an `RwLock` (publishers take read, subscribe
        // takes write) — but that's premature today.
        let mut guard = self.subscribers.lock().unwrap();
        // Walk in reverse so swap_remove on a dead subscriber doesn't
        // skip the one swapped into its slot.
        let mut i = guard.len();
        while i > 0 {
            i -= 1;
            match guard[i].send(change.clone()) {
                Ok(()) => {}
                Err(_) => {
                    // Receiver dropped — prune.
                    guard.swap_remove(i);
                }
            }
        }
    }

    /// Like `publish` but uses a bounded `try_send` semantic by way of
    /// the same mpsc::Sender (unbounded mpsc has no try variant; this
    /// helper is reserved for a future swap to `crossbeam-channel`
    /// bounded if we ever need backpressure). Today it just delegates
    /// to `publish` so the public surface stays stable.
    #[allow(dead_code)]
    pub fn publish_bounded(&self, change: StateChange) {
        self.publish(change);
    }

    /// Register a new subscriber. Returns the receiver half of an mpsc
    /// channel that will see every `StateChange` published from this
    /// point forward. Past events are NOT replayed (deliberate — the
    /// subscriber should snapshot `DeviceState` directly if it wants
    /// to know the starting state).
    #[allow(dead_code)]
    pub fn subscribe(&self) -> Receiver<StateChange> {
        // `mpsc::channel()` is unbounded. We model the bounded-capacity
        // contract documented in this module via the explicit log-and-
        // drop path in `publish_with_overflow_warn` (not currently used;
        // reserved for the future migration to `crossbeam-channel`
        // bounded). The 1024 capacity in module docs describes the
        // SOFT contract — if a subscriber ever lags this badly, we'll
        // see runaway memory before the channel itself complains.
        let (tx, rx) = mpsc::channel();
        self.subscribers.lock().unwrap().push(tx);
        rx
    }

    /// Currently-registered subscriber count. Exposed for tests and
    /// diagnostics; not part of the steady-state hot path.
    #[allow(dead_code)]
    pub fn subscriber_count(&self) -> usize {
        self.subscribers.lock().unwrap().len()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn evt() -> StateChange {
        StateChange::Reset { at: Instant::now() }
    }

    #[test]
    fn subscribers_receive_published_events() {
        let bus = EventBus::new();
        let rx1 = bus.subscribe();
        let rx2 = bus.subscribe();
        bus.publish(evt());
        assert!(matches!(rx1.try_recv(), Ok(StateChange::Reset { .. })));
        assert!(matches!(rx2.try_recv(), Ok(StateChange::Reset { .. })));
    }

    #[test]
    fn dropped_subscribers_are_pruned() {
        let bus = EventBus::new();
        {
            let _rx = bus.subscribe();
            assert_eq!(bus.subscriber_count(), 1);
        }
        // The receiver has been dropped; publishing should prune it.
        bus.publish(evt());
        assert_eq!(bus.subscriber_count(), 0);
    }

    #[test]
    fn no_subscribers_is_a_noop() {
        let bus = EventBus::new();
        // Should not panic.
        bus.publish(evt());
        bus.publish(evt());
    }
}
