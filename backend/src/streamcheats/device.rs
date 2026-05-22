//! [`DeviceController`] — the authoritative orchestrator for the
//! proxied HID device. Owns the [`DeviceState`], emits 9-byte
//! Streamcheats serial packets via the existing
//! [`SerialTxHolder`](crate::util::translator::SerialTxHolder), and
//! publishes [`StateChange`] events on the [`EventBus`].
//!
//! # Lifecycle
//!
//! Today this type is unused — it's the foundation for the next
//! refactor pass that will collapse `util::translator`'s
//! `Arc<Mutex<u8>>` button mask + ad-hoc `send_packet` into a single
//! controller. Building it as a separate, well-tested unit first means
//! we can ship + review this layer in isolation before flipping the
//! translator over to it.
//!
//! # Locking discipline
//!
//! Every `apply_*` method takes the state mutex, mutates state, builds
//! the serial packet, drops the mutex, sends to the serial channel,
//! then publishes the event. The mutex is NEVER held across the
//! channel send or the bus publish — both of those can block briefly
//! (the publish walks every subscriber's mpsc) and we don't want to
//! create cross-thread priority inversions where the UDP main thread
//! blocks waiting for a slow event subscriber.

use std::sync::Mutex;
use std::time::Instant;

use tracing::{info, warn};

use crate::streamcheats::packet::build_packet;
use crate::streamcheats::state::{DeviceState, EventBus, StateChange};
use crate::util::translator::{SerialEnvelope, SerialTxHolder};

/// Single source of truth for the proxied device's logical state.
/// Wraps the [`DeviceState`] in a mutex, holds a clone of the
/// supervisor's swappable serial sender, and owns an [`EventBus`] that
/// downstream subscribers (e.g. the future `kmbox_net::monitor`
/// emitter) can register on.
pub struct DeviceController {
    state: Mutex<DeviceState>,
    serial_tx: SerialTxHolder,
    bus: EventBus,
    /// Reserved for symmetry with the existing `Translator::enable_timing`
    /// flag — the controller doesn't currently format timing into its
    /// log lines because all of its timing-sensitive work (the channel
    /// send) is already instrumented by the writer thread. Kept on the
    /// struct so the next refactor can flip translator log lines to
    /// route through here without changing the public constructor.
    #[allow(dead_code)]
    enable_timing: bool,
}

impl DeviceController {
    /// Build a controller. `serial_tx` is the same swappable holder
    /// the translator already passes around — the controller and the
    /// translator (once it's refactored) will share clones of it so
    /// the supervisor's disconnect path still works unchanged.
    pub fn new(serial_tx: SerialTxHolder, bus: EventBus, enable_timing: bool) -> Self {
        Self {
            state: Mutex::new(DeviceState::default()),
            serial_tx,
            bus,
            enable_timing,
        }
    }

    /// Snapshot the current state. Cheap (one Clone of a small POD
    /// struct). Useful for subscribers that want the full picture at
    /// the moment they subscribe — the bus does NOT replay history.
    #[allow(dead_code)]
    pub fn snapshot_state(&self) -> DeviceState {
        self.state.lock().unwrap().snapshot()
    }

    /// Register a new event subscriber. Forwarded to the internal
    /// [`EventBus`]; see its docs for delivery semantics. Will be
    /// called by the upcoming `kmbox_net::monitor` emitter (task #9).
    #[allow(dead_code)]
    pub fn subscribe(&self) -> std::sync::mpsc::Receiver<StateChange> {
        self.bus.subscribe()
    }

    /// Set the cumulative button mask to `mask` (Option-B semantics —
    /// the caller has already resolved the final mask from the KMBox
    /// payload). Emits a `mask, 0, 0, 0` serial packet (the firmware
    /// expects a full packet on every button change), then publishes
    /// [`StateChange::ButtonsChanged`] iff the mask actually changed.
    /// Returns the new mask for the caller's convenience.
    pub fn apply_buttons(&self, mask: u8) -> u8 {
        // Lock, mutate, capture before/after, build packet, RELEASE
        // lock, then dispatch. See module docs for why the lock is
        // not held across send/publish.
        let now = Instant::now();
        let (changed_from, pkt) = {
            let mut s = self.state.lock().unwrap();
            let from = s.button_mask;
            s.button_mask = mask;
            s.last_update_at = Some(now);
            s.total_packets_emitted = s.total_packets_emitted.saturating_add(1);
            let pkt = build_packet(mask, 0, 0, 0);
            (if from == mask { None } else { Some(from) }, pkt)
        };

        self.send_serial(pkt, now);

        if let Some(from) = changed_from {
            info!("STATE: buttons 0x{:02X} -> 0x{:02X}", from, mask);
            self.bus.publish(StateChange::ButtonsChanged {
                from,
                to: mask,
                at: now,
            });
        }

        mask
    }

    /// Apply a relative-move with the current button mask. Updates
    /// `last_dx`/`last_dy` and emits a serial packet. Always publishes
    /// [`StateChange::MoveEmitted`] (even on (0,0) — see
    /// [`StateChange`] docs).
    pub fn apply_move(&self, dx: i16, dy: i16) {
        let now = Instant::now();
        let (mask, pkt) = {
            let mut s = self.state.lock().unwrap();
            s.last_dx = dx;
            s.last_dy = dy;
            s.last_update_at = Some(now);
            s.total_packets_emitted = s.total_packets_emitted.saturating_add(1);
            let mask = s.button_mask;
            let pkt = build_packet(mask, dx as i32, dy as i32, 0);
            (mask, pkt)
        };

        self.send_serial(pkt, now);

        info!("STATE: move dx={} dy={} buttons=0x{:02X}", dx, dy, mask);
        self.bus.publish(StateChange::MoveEmitted {
            dx,
            dy,
            button_mask: mask,
            at: now,
        });
    }

    /// Atomic "set buttons AND apply move" in a single serial send.
    ///
    /// Exists to preserve the legacy translator behaviour of emitting
    /// exactly ONE serial packet per `cmd_mouse_move` opcode, even when
    /// the opcode's `payload.button` changes the cumulative mask: a
    /// separate `apply_buttons(mask); apply_move(dx, dy);` pair would
    /// produce two serial packets (one buttons-only, one move-with-
    /// buttons), doubling the wire traffic the host originally meant.
    ///
    /// Publishes [`StateChange::ButtonsChanged`] iff the mask actually
    /// changed (matching `apply_buttons` semantics) AND always publishes
    /// [`StateChange::MoveEmitted`] (matching `apply_move` semantics).
    pub fn apply_buttons_and_move(&self, buttons: u8, dx: i16, dy: i16) {
        let now = Instant::now();
        let (changed_from, pkt) = {
            let mut s = self.state.lock().unwrap();
            let from = s.button_mask;
            s.button_mask = buttons;
            s.last_dx = dx;
            s.last_dy = dy;
            s.last_update_at = Some(now);
            s.total_packets_emitted = s.total_packets_emitted.saturating_add(1);
            let pkt = build_packet(buttons, dx as i32, dy as i32, 0);
            (if from == buttons { None } else { Some(from) }, pkt)
        };

        self.send_serial(pkt, now);

        if let Some(from) = changed_from {
            info!("STATE: buttons 0x{:02X} -> 0x{:02X}", from, buttons);
            self.bus.publish(StateChange::ButtonsChanged {
                from,
                to: buttons,
                at: now,
            });
        }
        info!("STATE: move dx={} dy={} buttons=0x{:02X}", dx, dy, buttons);
        self.bus.publish(StateChange::MoveEmitted {
            dx,
            dy,
            button_mask: buttons,
            at: now,
        });
    }

    /// Atomic "set buttons AND apply wheel" in a single serial send.
    /// Same rationale as [`apply_buttons_and_move`] — preserves the
    /// legacy one-packet-per-opcode contract for `cmd_mouse_wheel`.
    pub fn apply_buttons_and_wheel(&self, buttons: u8, wheel: i8) {
        let now = Instant::now();
        let (changed_from, pkt) = {
            let mut s = self.state.lock().unwrap();
            let from = s.button_mask;
            s.button_mask = buttons;
            s.last_wheel = wheel;
            s.last_update_at = Some(now);
            s.total_packets_emitted = s.total_packets_emitted.saturating_add(1);
            let pkt = build_packet(buttons, 0, 0, wheel as i32);
            (if from == buttons { None } else { Some(from) }, pkt)
        };

        self.send_serial(pkt, now);

        if let Some(from) = changed_from {
            info!("STATE: buttons 0x{:02X} -> 0x{:02X}", from, buttons);
            self.bus.publish(StateChange::ButtonsChanged {
                from,
                to: buttons,
                at: now,
            });
        }
        info!("STATE: wheel={} buttons=0x{:02X}", wheel, buttons);
        self.bus.publish(StateChange::WheelEmitted {
            wheel,
            button_mask: buttons,
            at: now,
        });
    }

    /// Cheap read of just the current button mask. Used by interpolation
    /// workers that re-read the mask on every 4 ms tick — avoids cloning
    /// the whole `DeviceState` snapshot at that cadence. Currently only
    /// referenced by tests; kept on the public surface because the
    /// monitor subscriber may want a non-event-driven readback path.
    #[allow(dead_code)]
    pub fn current_buttons(&self) -> u8 {
        self.state.lock().unwrap().button_mask
    }

    /// Adopt a new button mask WITHOUT emitting a serial packet. Used by
    /// the translator's `cmd_mouse_automove` / `cmd_bazier_move` arms,
    /// which carry the host's current button mask in their payload but
    /// expect the *worker thread* (not the dispatch path) to do all
    /// serial sending. Publishes [`StateChange::ButtonsChanged`] iff
    /// the mask actually changed so monitor subscribers still see the
    /// transition.
    pub fn set_button_mask_silent(&self, mask: u8) {
        let now = Instant::now();
        let changed_from = {
            let mut s = self.state.lock().unwrap();
            let from = s.button_mask;
            s.button_mask = mask;
            // Intentionally do NOT bump total_packets_emitted or touch
            // last_update_at — we did not emit anything on the wire.
            if from == mask {
                None
            } else {
                Some(from)
            }
        };
        if let Some(from) = changed_from {
            info!("STATE: buttons 0x{:02X} -> 0x{:02X} (silent)", from, mask);
            self.bus.publish(StateChange::ButtonsChanged {
                from,
                to: mask,
                at: now,
            });
        }
    }

    /// Apply a wheel delta with the current button mask. Updates
    /// `last_wheel` and emits a serial packet. Always publishes
    /// [`StateChange::WheelEmitted`].
    ///
    /// The translator dispatch path goes through
    /// [`apply_buttons_and_wheel`] instead (one packet per opcode), so
    /// this exists for symmetry with `apply_move` / `apply_buttons` and
    /// for any future caller that wants a wheel update without
    /// touching the button mask.
    #[allow(dead_code)]
    pub fn apply_wheel(&self, wheel: i8) {
        let now = Instant::now();
        let (mask, pkt) = {
            let mut s = self.state.lock().unwrap();
            s.last_wheel = wheel;
            s.last_update_at = Some(now);
            s.total_packets_emitted = s.total_packets_emitted.saturating_add(1);
            let mask = s.button_mask;
            let pkt = build_packet(mask, 0, 0, wheel as i32);
            (mask, pkt)
        };

        self.send_serial(pkt, now);

        info!("STATE: wheel={} buttons=0x{:02X}", wheel, mask);
        self.bus.publish(StateChange::WheelEmitted {
            wheel,
            button_mask: mask,
            at: now,
        });
    }

    /// Reset the volatile state (used on `cmd_connect`). Does NOT emit
    /// a serial packet — the firmware infers reset from the absence of
    /// further input, and emitting a zero packet here would race with
    /// the host app's first real command. Publishes
    /// [`StateChange::Reset`] so subscribers can re-baseline.
    pub fn reset(&self) {
        let now = Instant::now();
        {
            let mut s = self.state.lock().unwrap();
            s.reset();
            s.last_update_at = Some(now);
        }

        info!("STATE: reset");
        self.bus.publish(StateChange::Reset { at: now });
    }

    /// Push a pre-built 9-byte settings packet onto the serial channel
    /// WITHOUT touching `DeviceState` or publishing a bus event.
    ///
    /// Settings packets (`0x03`-prefixed firmware-config writes) carry
    /// no HID semantics — they don't reflect button / move / wheel
    /// state, so updating `last_*` fields or publishing a `StateChange`
    /// would actively lie to monitor subscribers. Public so the
    /// [`crate::streamcheats::MaskController`] can route every mask
    /// transition through the same writer thread the heartbeat already
    /// uses, keeping wire ordering deterministic with respect to HID
    /// packets the same mask change triggers.
    pub fn send_settings_packet(&self, pkt: [u8; crate::streamcheats::PACKET_LEN]) {
        let now = Instant::now();
        // Bump the lifetime emission counter so diagnostics reflect
        // settings traffic — but leave button_mask / last_dx / last_dy
        // / last_wheel untouched (settings packets carry none of those
        // values). last_update_at IS bumped because the firmware did
        // see traffic at this instant.
        {
            let mut s = self.state.lock().unwrap();
            s.last_update_at = Some(now);
            s.total_packets_emitted = s.total_packets_emitted.saturating_add(1);
        }
        self.send_serial(pkt, now);
    }

    /// Emit a sens-reduction re-arm HID packet: `(buttons, 0, 0, wheel=1)`.
    /// The firmware reads byte 4 (`wheel` slot) as the re-arm trigger
    /// when sens reduction is enabled, so a single packet with that
    /// byte set restarts the suppression window. Caller supplies the
    /// current button mask so we never accidentally release a held
    /// button mid-pump. NOT publishing `MoveEmitted` or `WheelEmitted`
    /// here because no logical wheel scroll happened — this is a
    /// firmware-internal trigger, not a user-visible input event.
    pub fn apply_axis_mask_rearm(&self, buttons: u8) {
        let now = Instant::now();
        // Build the packet directly with wheel=1 and dx=dy=0.
        let pkt = crate::streamcheats::build_packet(buttons, 0, 0, 1);
        {
            let mut s = self.state.lock().unwrap();
            s.last_update_at = Some(now);
            s.total_packets_emitted = s.total_packets_emitted.saturating_add(1);
        }
        self.send_serial(pkt, now);
    }

    /// Push a packet onto the swappable serial channel. Silently drops
    /// when no device is currently attached — matches the existing
    /// translator's `send_packet` semantics so the UDP-still-replies-
    /// while-Teensy-unplugged contract is preserved.
    fn send_serial(&self, pkt: [u8; crate::streamcheats::PACKET_LEN], origin: Instant) {
        let env: SerialEnvelope = (origin, pkt);
        let guard = self.serial_tx.lock().unwrap();
        if let Some(tx) = guard.as_ref() {
            if let Err(e) = tx.send(env) {
                warn!("serial channel send failed: {}", e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::TryRecvError;
    use std::sync::{Arc, Mutex as StdMutex};

    /// Helper: build a controller with a real serial channel so the
    /// `send_serial` path doesn't no-op (we want to assert packets are
    /// emitted in the right order).
    fn make_with_serial() -> (
        DeviceController,
        std::sync::mpsc::Receiver<SerialEnvelope>,
    ) {
        let (tx, rx) = std::sync::mpsc::channel::<SerialEnvelope>();
        let holder: SerialTxHolder = Arc::new(StdMutex::new(Some(tx)));
        let ctrl = DeviceController::new(holder, EventBus::new(), false);
        (ctrl, rx)
    }

    /// Helper: build a controller with `None` in the holder so we can
    /// confirm the "no device attached" path doesn't panic.
    fn make_no_serial() -> DeviceController {
        let holder: SerialTxHolder = Arc::new(StdMutex::new(None));
        DeviceController::new(holder, EventBus::new(), false)
    }

    #[test]
    fn apply_buttons_publishes_event_only_on_change() {
        let (ctrl, _rx) = make_with_serial();
        let sub = ctrl.subscribe();

        // First call: 0x00 -> 0x02 publishes.
        ctrl.apply_buttons(0x02);
        let e = sub.try_recv().expect("expected one event");
        match e {
            StateChange::ButtonsChanged { from, to, .. } => {
                assert_eq!(from, 0x00);
                assert_eq!(to, 0x02);
            }
            other => panic!("expected ButtonsChanged, got {:?}", other),
        }

        // Second call with same mask: must NOT publish.
        ctrl.apply_buttons(0x02);
        assert!(
            matches!(sub.try_recv(), Err(TryRecvError::Empty)),
            "no-op apply_buttons must not publish ButtonsChanged"
        );
    }

    #[test]
    fn apply_buttons_publishes_event_on_change_with_correct_from_to() {
        let (ctrl, _rx) = make_with_serial();
        let sub = ctrl.subscribe();
        ctrl.apply_buttons(0x01);
        ctrl.apply_buttons(0x05);

        let first = sub.try_recv().unwrap();
        let second = sub.try_recv().unwrap();
        match first {
            StateChange::ButtonsChanged { from, to, .. } => {
                assert_eq!(from, 0x00);
                assert_eq!(to, 0x01);
            }
            other => panic!("expected ButtonsChanged, got {:?}", other),
        }
        match second {
            StateChange::ButtonsChanged { from, to, .. } => {
                assert_eq!(from, 0x01);
                assert_eq!(to, 0x05);
            }
            other => panic!("expected ButtonsChanged, got {:?}", other),
        }
    }

    #[test]
    fn apply_move_always_publishes_with_current_buttons() {
        let (ctrl, _rx) = make_with_serial();
        let sub = ctrl.subscribe();

        ctrl.apply_buttons(0x02); // sets mask + publishes ButtonsChanged
        let _ = sub.try_recv().unwrap(); // drain ButtonsChanged

        ctrl.apply_move(10, -5);
        let e = sub.try_recv().unwrap();
        match e {
            StateChange::MoveEmitted {
                dx,
                dy,
                button_mask,
                ..
            } => {
                assert_eq!(dx, 10);
                assert_eq!(dy, -5);
                assert_eq!(button_mask, 0x02, "move event must carry current mask");
            }
            other => panic!("expected MoveEmitted, got {:?}", other),
        }

        // A second move with the same delta must also publish — no
        // dedup on move/wheel.
        ctrl.apply_move(10, -5);
        let e = sub.try_recv().unwrap();
        assert!(matches!(e, StateChange::MoveEmitted { .. }));

        // Even a (0,0) tick (interpolation worker no-op) publishes.
        ctrl.apply_move(0, 0);
        let e = sub.try_recv().unwrap();
        match e {
            StateChange::MoveEmitted { dx, dy, .. } => {
                assert_eq!((dx, dy), (0, 0));
            }
            other => panic!("expected MoveEmitted, got {:?}", other),
        }
    }

    #[test]
    fn apply_wheel_always_publishes() {
        let (ctrl, _rx) = make_with_serial();
        let sub = ctrl.subscribe();
        ctrl.apply_buttons(0x04);
        let _ = sub.try_recv().unwrap();

        ctrl.apply_wheel(-1);
        let e = sub.try_recv().unwrap();
        match e {
            StateChange::WheelEmitted {
                wheel,
                button_mask,
                ..
            } => {
                assert_eq!(wheel, -1);
                assert_eq!(button_mask, 0x04);
            }
            other => panic!("expected WheelEmitted, got {:?}", other),
        }

        // Same wheel value again — must republish.
        ctrl.apply_wheel(-1);
        assert!(matches!(
            sub.try_recv().unwrap(),
            StateChange::WheelEmitted { .. }
        ));
    }

    #[test]
    fn subscribers_receive_published_events() {
        let (ctrl, _rx) = make_with_serial();
        let s1 = ctrl.subscribe();
        let s2 = ctrl.subscribe();

        ctrl.apply_buttons(0x01);
        assert!(matches!(
            s1.try_recv().unwrap(),
            StateChange::ButtonsChanged { .. }
        ));
        assert!(matches!(
            s2.try_recv().unwrap(),
            StateChange::ButtonsChanged { .. }
        ));
    }

    #[test]
    fn reset_publishes_and_clears_state() {
        let (ctrl, _rx) = make_with_serial();
        let sub = ctrl.subscribe();

        ctrl.apply_buttons(0x02);
        ctrl.apply_move(5, 5);
        let _ = sub.try_recv().unwrap();
        let _ = sub.try_recv().unwrap();

        ctrl.reset();
        let e = sub.try_recv().unwrap();
        assert!(matches!(e, StateChange::Reset { .. }));

        let snap = ctrl.snapshot_state();
        assert_eq!(snap.button_mask, 0);
        assert_eq!(snap.last_dx, 0);
        assert_eq!(snap.last_dy, 0);
        // total_packets_emitted should have survived reset and now
        // reflect the two pre-reset emissions (apply_buttons +
        // apply_move). reset() itself does not bump the counter.
        assert_eq!(snap.total_packets_emitted, 2);
    }

    #[test]
    fn no_device_attached_does_not_panic() {
        let ctrl = make_no_serial();
        let sub = ctrl.subscribe();
        // All of these must succeed silently — the supervisor swaps
        // the holder in/out at runtime, and apply_* must not panic
        // when nothing is downstream.
        ctrl.apply_buttons(0x01);
        ctrl.apply_move(1, 2);
        ctrl.apply_wheel(-3);
        ctrl.reset();
        // Events should still be published (the bus is independent
        // of the serial channel).
        assert!(matches!(
            sub.try_recv().unwrap(),
            StateChange::ButtonsChanged { .. }
        ));
        assert!(matches!(
            sub.try_recv().unwrap(),
            StateChange::MoveEmitted { .. }
        ));
        assert!(matches!(
            sub.try_recv().unwrap(),
            StateChange::WheelEmitted { .. }
        ));
        assert!(matches!(
            sub.try_recv().unwrap(),
            StateChange::Reset { .. }
        ));
    }

    #[test]
    fn apply_buttons_and_move_emits_single_packet() {
        let (ctrl, rx) = make_with_serial();
        ctrl.apply_buttons_and_move(0x02, 10, -5);
        // Exactly one serial packet — that's the whole point of the
        // combined helper vs separate apply_buttons + apply_move.
        let (_origin, p) = rx.try_recv().expect("expected one serial packet");
        assert_eq!(p[1], 0x02, "buttons byte");
        // dx=10 in-range -> direct byte 0x0A; dy=-5 -> 0xFB
        assert_eq!(p[2], 0x0A);
        assert_eq!(p[3], 0xFB);
        // No second packet.
        assert!(rx.try_recv().is_err(), "must emit only ONE serial packet");
        // State now reflects both mutations.
        let snap = ctrl.snapshot_state();
        assert_eq!(snap.button_mask, 0x02);
        assert_eq!(snap.last_dx, 10);
        assert_eq!(snap.last_dy, -5);
        assert_eq!(snap.total_packets_emitted, 1);
    }

    #[test]
    fn apply_buttons_and_move_publishes_buttons_only_on_change() {
        let (ctrl, _rx) = make_with_serial();
        let sub = ctrl.subscribe();

        // First call: mask 0x00 -> 0x02 must publish ButtonsChanged AND
        // MoveEmitted, in that order.
        ctrl.apply_buttons_and_move(0x02, 1, 2);
        let e1 = sub.try_recv().unwrap();
        let e2 = sub.try_recv().unwrap();
        assert!(matches!(e1, StateChange::ButtonsChanged { from: 0x00, to: 0x02, .. }));
        match e2 {
            StateChange::MoveEmitted { dx, dy, button_mask, .. } => {
                assert_eq!((dx, dy, button_mask), (1, 2, 0x02));
            }
            other => panic!("expected MoveEmitted, got {:?}", other),
        }

        // Second call with same mask: MoveEmitted only (no buttons change).
        ctrl.apply_buttons_and_move(0x02, 3, 4);
        let e3 = sub.try_recv().unwrap();
        assert!(matches!(e3, StateChange::MoveEmitted { dx: 3, dy: 4, button_mask: 0x02, .. }));
        assert!(sub.try_recv().is_err(), "no extra event");
    }

    #[test]
    fn apply_buttons_and_wheel_emits_single_packet() {
        let (ctrl, rx) = make_with_serial();
        ctrl.apply_buttons_and_wheel(0x04, -1);
        let (_origin, p) = rx.try_recv().expect("expected one serial packet");
        assert_eq!(p[1], 0x04);
        assert_eq!(p[4], 0xFF, "wheel byte = -1 as u8");
        assert!(rx.try_recv().is_err(), "must emit only ONE serial packet");
        let snap = ctrl.snapshot_state();
        assert_eq!(snap.button_mask, 0x04);
        assert_eq!(snap.last_wheel, -1);
        assert_eq!(snap.total_packets_emitted, 1);
    }

    #[test]
    fn apply_buttons_and_wheel_publishes_buttons_only_on_change() {
        let (ctrl, _rx) = make_with_serial();
        let sub = ctrl.subscribe();

        ctrl.apply_buttons_and_wheel(0x04, 1);
        let e1 = sub.try_recv().unwrap();
        let e2 = sub.try_recv().unwrap();
        assert!(matches!(e1, StateChange::ButtonsChanged { from: 0x00, to: 0x04, .. }));
        match e2 {
            StateChange::WheelEmitted { wheel, button_mask, .. } => {
                assert_eq!((wheel, button_mask), (1, 0x04));
            }
            other => panic!("expected WheelEmitted, got {:?}", other),
        }

        ctrl.apply_buttons_and_wheel(0x04, -1);
        let e3 = sub.try_recv().unwrap();
        assert!(matches!(e3, StateChange::WheelEmitted { wheel: -1, button_mask: 0x04, .. }));
        assert!(sub.try_recv().is_err());
    }

    #[test]
    fn set_button_mask_silent_updates_state_without_serial() {
        let (ctrl, rx) = make_with_serial();
        let sub = ctrl.subscribe();
        ctrl.set_button_mask_silent(0x02);
        // Must NOT emit a serial packet.
        assert!(rx.try_recv().is_err(), "silent mask set must not emit serial");
        // But MUST publish ButtonsChanged on transition.
        let e = sub.try_recv().unwrap();
        assert!(matches!(e, StateChange::ButtonsChanged { from: 0x00, to: 0x02, .. }));
        assert_eq!(ctrl.current_buttons(), 0x02);
        // total_packets_emitted must not have been bumped.
        assert_eq!(ctrl.snapshot_state().total_packets_emitted, 0);
    }

    #[test]
    fn set_button_mask_silent_no_op_does_not_publish() {
        let (ctrl, _rx) = make_with_serial();
        ctrl.set_button_mask_silent(0x02);
        let sub = ctrl.subscribe();
        ctrl.set_button_mask_silent(0x02);
        assert!(sub.try_recv().is_err(), "no-op silent set must not publish");
    }

    #[test]
    fn current_buttons_returns_mask_without_full_snapshot() {
        let (ctrl, _rx) = make_with_serial();
        assert_eq!(ctrl.current_buttons(), 0);
        ctrl.apply_buttons(0x09);
        assert_eq!(ctrl.current_buttons(), 0x09);
    }

    #[test]
    fn concurrent_apply_calls_serialize() {
        // Spawn two threads each calling apply_buttons rapidly with
        // ALTERNATING masks. The point is twofold:
        //   1. no panics (mutex behaves)
        //   2. the count of ButtonsChanged events received equals the
        //      number of actual transitions — which, because the two
        //      threads contend on the mask, we can't predict exactly
        //      but we CAN bound. The minimum is 1 (if every iteration
        //      happens to land on the same prior value); the maximum
        //      is 2*N (every call changes the mask). What we can
        //      assert is that the received count never EXCEEDS the
        //      number of calls that observed a transition — which, by
        //      construction (each apply_buttons publishes iff it
        //      changed), means the received count is bounded above by
        //      the total apply_buttons calls.
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::thread;

        let (ctrl, _rx) = make_with_serial();
        let ctrl = Arc::new(ctrl);
        let sub = ctrl.subscribe();

        const N: usize = 500;
        let calls = Arc::new(AtomicUsize::new(0));

        let c1 = ctrl.clone();
        let calls1 = calls.clone();
        let t1 = thread::spawn(move || {
            for _ in 0..N {
                c1.apply_buttons(0x01);
                calls1.fetch_add(1, Ordering::Relaxed);
            }
        });

        let c2 = ctrl.clone();
        let calls2 = calls.clone();
        let t2 = thread::spawn(move || {
            for _ in 0..N {
                c2.apply_buttons(0x02);
                calls2.fetch_add(1, Ordering::Relaxed);
            }
        });

        t1.join().unwrap();
        t2.join().unwrap();

        // Drain the subscriber and count events.
        let mut received = 0usize;
        while sub.try_recv().is_ok() {
            received += 1;
        }

        let total_calls = calls.load(Ordering::Relaxed);
        assert_eq!(total_calls, 2 * N);
        assert!(
            received <= total_calls,
            "received {} > total_calls {}",
            received,
            total_calls
        );
        // total_packets_emitted should equal total_calls (every
        // apply_buttons emits regardless of change).
        assert_eq!(ctrl.snapshot_state().total_packets_emitted as usize, total_calls);
    }
}
