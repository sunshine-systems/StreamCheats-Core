//! MaskController — diffs incoming `cmd_mask_mouse` / `cmd_unmask_all`
//! requests against the prior mask state and emits the matching
//! `DeviceSettings` packets via the [`DeviceController`].
//!
//! Lives one layer above [`DeviceController`] (it borrows the
//! controller to emit settings packets and to query current buttons).
//! Owned by the translator dispatch path.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tracing::{info, warn};

use crate::streamcheats::{build_settings_packet, DeviceController, DeviceSettings};

use super::state::{
    MaskState, MASK_LMB, MASK_MMB, MASK_RMB, MASK_SIDE1, MASK_SIDE2, MASK_WHEEL, MASK_X, MASK_Y,
};
use super::watchdog::Watchdog;

/// Per-axis amount value sent when X / Y axis masking is OFF — matches
/// the firmware's "full passthrough" amount of 100.
pub const SENS_AMOUNT_PASSTHROUGH: i16 = 100;
/// Amount value sent when X / Y axis masking is ON — zero amount
/// means the firmware scales the physical mouse delta to 0 during the
/// sens-reduction window.
pub const SENS_AMOUNT_MASKED: i16 = 0;
/// Duration (ms) of the sens-reduction window the watchdog re-arms.
/// Matches the pump cadence × 2 so a single missed tick still keeps
/// the suppression continuous.
pub const SENS_WINDOW_MS: i16 = 100;

/// Diff-and-emit controller for `cmd_mask_mouse` / `cmd_unmask_all`.
/// Holds the last-seen [`MaskState`] plus an optional pump thread; the
/// pump is spawned the first time X or Y becomes masked and stopped
/// when both clear (or `clear_all`/drop runs).
pub struct MaskController {
    state: Mutex<MaskState>,
    /// Borrowed for emit + current-buttons snapshot inside the watchdog.
    device: Arc<DeviceController>,
    /// Program-wide shutdown flag — passed into newly-spawned watchdogs
    /// so they exit cleanly on Ctrl+C.
    global_running: Arc<AtomicBool>,
    /// `Some` whenever a pump thread is active.
    watchdog: Mutex<Option<Watchdog>>,
}

impl MaskController {
    /// Build a controller. The `global_running` flag is the same one
    /// `main::run` clones into every long-lived worker; the watchdog
    /// borrows a clone so the pump exits within ~25ms of Ctrl+C.
    pub fn new(device: Arc<DeviceController>, global_running: Arc<AtomicBool>) -> Self {
        Self {
            state: Mutex::new(MaskState::default()),
            device,
            global_running,
            watchdog: Mutex::new(None),
        }
    }

    /// Snapshot of the current mask state. Used by tests + diagnostics.
    #[allow(dead_code)]
    pub fn snapshot(&self) -> MaskState {
        *self.state.lock().unwrap()
    }

    /// Handle one `cmd_mask_mouse` packet. `rand` is the raw 32-bit
    /// `head.rand` field — low byte carries the mouse mask bits, upper
    /// 16+8 bits carry the keyboard vkey if this was a `mask_keyboard`
    /// call.
    pub fn apply_mask_mouse(&self, rand: u32) {
        let new_bits = (rand & 0xFF) as u8;
        let keyboard_vkey = ((rand >> 8) & 0xFFFF) as u16;

        let (old_bits, transitions) = {
            let mut s = self.state.lock().unwrap();
            let old = s.mouse_bits;
            s.mouse_bits = new_bits;
            if keyboard_vkey != 0 {
                s.last_keyboard_vkey = keyboard_vkey;
            }
            (old, old ^ new_bits)
        };

        info!(
            "STATE: mask bits 0x{:02X} -> 0x{:02X} (delta=0x{:02X}, kb_vkey=0x{:04X})",
            old_bits, new_bits, transitions, keyboard_vkey
        );
        // Human-readable summary captured alongside the raw-bits line so
        // the bug-report log slice (which is the only place device state
        // lives now that device_state.json is gone) records the same
        // information `MaskState` exposes in memory.
        info!(
            "STATE: mask buttons=0x{:02X} axes_x={} axes_y={} wheel={} keyboard_vkey=0x{:04X}",
            new_bits & 0x1F,
            on_off(new_bits & MASK_X != 0),
            on_off(new_bits & MASK_Y != 0),
            on_off(new_bits & MASK_WHEEL != 0),
            keyboard_vkey,
        );

        // Per-button passthrough toggles. We only emit on change so
        // the firmware isn't bombarded on every `mask_mouse(...)` call
        // when the host's masks haven't actually moved.
        if transitions & MASK_LMB != 0 {
            self.emit_setting(
                DeviceSettings::DisablePassthroughForLmb,
                bool_to_i16(new_bits & MASK_LMB != 0),
                "LMB",
            );
        }
        if transitions & MASK_RMB != 0 {
            self.emit_setting(
                DeviceSettings::DisablePassthroughForRmb,
                bool_to_i16(new_bits & MASK_RMB != 0),
                "RMB",
            );
        }
        if transitions & MASK_MMB != 0 {
            self.emit_setting(
                DeviceSettings::DisablePassthroughForMmb,
                bool_to_i16(new_bits & MASK_MMB != 0),
                "MMB",
            );
        }
        if transitions & MASK_SIDE1 != 0 {
            self.emit_setting(
                DeviceSettings::DisablePassthroughForMb4,
                bool_to_i16(new_bits & MASK_SIDE1 != 0),
                "Side1",
            );
        }
        if transitions & MASK_SIDE2 != 0 {
            self.emit_setting(
                DeviceSettings::DisablePassthroughForMb5,
                bool_to_i16(new_bits & MASK_SIDE2 != 0),
                "Side2",
            );
        }

        // X / Y axis masking — uses the firmware's sens-reduction
        // pipeline. EnableSensReduction toggles globally; per-axis
        // amount goes to 0 to suppress, 100 to passthrough. Duration
        // is set once (every transition) so the watchdog's wheel=1
        // re-arms land on the same window length.
        let x_changed = transitions & MASK_X != 0;
        let y_changed = transitions & MASK_Y != 0;
        if x_changed || y_changed {
            let any_axis_now = (new_bits & (MASK_X | MASK_Y)) != 0;
            let was_any_axis = (old_bits & (MASK_X | MASK_Y)) != 0;

            // Master enable flips with "did we transition from no-axis
            // to any-axis or back".
            if any_axis_now && !was_any_axis {
                self.emit_setting(DeviceSettings::EnableSensReduction, 1, "SensReduction-on");
                self.emit_setting(
                    DeviceSettings::SensReductionDurationMilliseconds,
                    SENS_WINDOW_MS,
                    "SensReduction-window",
                );
            }
            if x_changed {
                let amount = if new_bits & MASK_X != 0 {
                    SENS_AMOUNT_MASKED
                } else {
                    SENS_AMOUNT_PASSTHROUGH
                };
                self.emit_setting(DeviceSettings::SensReductionAmountX, amount, "X-amount");
            }
            if y_changed {
                let amount = if new_bits & MASK_Y != 0 {
                    SENS_AMOUNT_MASKED
                } else {
                    SENS_AMOUNT_PASSTHROUGH
                };
                self.emit_setting(DeviceSettings::SensReductionAmountY, amount, "Y-amount");
            }
            if !any_axis_now && was_any_axis {
                self.emit_setting(DeviceSettings::EnableSensReduction, 0, "SensReduction-off");
            }

            // Watchdog lifecycle: start when entering axis-mask mode,
            // stop when leaving it.
            self.update_watchdog(any_axis_now);
        }

        // Wheel mask — firmware doesn't expose a wheel-passthrough
        // toggle yet. WARN and drop. See open GitHub issue.
        if transitions & MASK_WHEEL != 0 {
            warn!(
                "STATE: mask wheel = {} -> NOT SUPPORTED (firmware has no wheel-passthrough toggle; see GitHub issue tracking this gap)",
                new_bits & MASK_WHEEL != 0
            );
        }

        // Keyboard mask — firmware has no keyboard channel at all.
        if keyboard_vkey != 0 {
            warn!(
                "STATE: mask keyboard vkey=0x{:04X} -> NOT SUPPORTED (firmware has no keyboard channel)",
                keyboard_vkey
            );
        }
    }

    /// Handle `cmd_unmask_all`. Resets every bit to zero, emits the
    /// corresponding "off" settings packets, stops the watchdog, and
    /// WARNs if there was any pending keyboard mask state we couldn't
    /// honour. `rand` may carry a vkey from `kmNet_unmask_keyboard` —
    /// the vendor SDK overloads `cmd_unmask_all` for that case.
    pub fn apply_unmask_all(&self, rand: u32) {
        let keyboard_vkey = ((rand >> 8) & 0xFFFF) as u16;

        let (old_bits, prior_vkey) = {
            let mut s = self.state.lock().unwrap();
            let old_bits = s.mouse_bits;
            let prior_vkey = s.last_keyboard_vkey;
            s.mouse_bits = 0;
            s.last_keyboard_vkey = 0;
            (old_bits, prior_vkey)
        };

        info!(
            "STATE: unmask_all (was 0x{:02X}, kb_vkey=0x{:04X}, this_call_vkey=0x{:04X})",
            old_bits, prior_vkey, keyboard_vkey
        );
        // Mirror the human-readable summary emitted by apply_mask_mouse
        // — after unmask everything is off, but we want one line in the
        // log slice that says so explicitly.
        info!(
            "STATE: mask buttons=0x00 axes_x=off axes_y=off wheel=off keyboard_vkey=0x0000"
        );

        // Always emit the resets for the per-button passthrough IDs
        // and the sens-reduction pipeline. We always send them so a
        // host that does `cmd_unmask_all` as a defensive cleanup has
        // a guaranteed-clean state even if our shadow somehow drifted.
        self.emit_setting(DeviceSettings::DisablePassthroughForLmb, 0, "LMB");
        self.emit_setting(DeviceSettings::DisablePassthroughForRmb, 0, "RMB");
        self.emit_setting(DeviceSettings::DisablePassthroughForMmb, 0, "MMB");
        self.emit_setting(DeviceSettings::DisablePassthroughForMb4, 0, "Side1");
        self.emit_setting(DeviceSettings::DisablePassthroughForMb5, 0, "Side2");
        self.emit_setting(
            DeviceSettings::SensReductionAmountX,
            SENS_AMOUNT_PASSTHROUGH,
            "X-amount",
        );
        self.emit_setting(
            DeviceSettings::SensReductionAmountY,
            SENS_AMOUNT_PASSTHROUGH,
            "Y-amount",
        );
        self.emit_setting(DeviceSettings::EnableSensReduction, 0, "SensReduction-off");

        self.update_watchdog(false);

        if prior_vkey != 0 || keyboard_vkey != 0 {
            warn!(
                "STATE: unmask_all swallowed keyboard mask state (prior=0x{:04X}, this_call=0x{:04X}) — firmware has no keyboard channel",
                prior_vkey, keyboard_vkey
            );
        }
    }

    /// Push one settings packet through the controller's serial path.
    fn emit_setting(&self, id: DeviceSettings, value: i16, label: &str) {
        let pkt = build_settings_packet(id, value);
        self.device.send_settings_packet(pkt);
        info!(
            "STATE: mask -> settings id={} ({}) value={}",
            id as u8, label, value
        );
    }

    /// Lifecycle gate around the watchdog: spawns when `want_running`
    /// is true and the pump isn't already running; stops + joins when
    /// false and the pump is running.
    fn update_watchdog(&self, want_running: bool) {
        let mut guard = self.watchdog.lock().unwrap();
        match (want_running, guard.is_some()) {
            (true, false) => {
                *guard = Some(Watchdog::spawn(
                    self.device.clone(),
                    self.global_running.clone(),
                ));
            }
            (false, true) => {
                if let Some(mut w) = guard.take() {
                    w.stop();
                }
            }
            _ => {}
        }
    }
}

impl Drop for MaskController {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.watchdog.lock() {
            if let Some(mut w) = guard.take() {
                w.stop();
            }
        }
    }
}

#[inline]
fn bool_to_i16(b: bool) -> i16 {
    if b {
        1
    } else {
        0
    }
}

#[inline]
fn on_off(b: bool) -> &'static str {
    if b {
        "on"
    } else {
        "off"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::streamcheats::state::EventBus;
    use crate::streamcheats::PACKET_LEN;
    use crate::util::translator::{SerialEnvelope, SerialTxHolder};
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc;
    use std::sync::Mutex as StdMutex;

    fn make_ctrl() -> (
        MaskController,
        mpsc::Receiver<SerialEnvelope>,
        Arc<DeviceController>,
        Arc<AtomicBool>,
    ) {
        let (tx, rx) = mpsc::channel::<SerialEnvelope>();
        let holder: SerialTxHolder = Arc::new(StdMutex::new(Some(tx)));
        let device = Arc::new(DeviceController::new(holder, EventBus::new(), false));
        let global_running = Arc::new(AtomicBool::new(true));
        let mc = MaskController::new(device.clone(), global_running.clone());
        (mc, rx, device, global_running)
    }

    fn drain(rx: &mpsc::Receiver<SerialEnvelope>) -> Vec<[u8; PACKET_LEN]> {
        let mut out = Vec::new();
        while let Ok((_t, p)) = rx.try_recv() {
            out.push(p);
        }
        out
    }

    /// Only changed bits should produce settings packets. Calling
    /// `apply_mask_mouse(0x01)` twice in a row should only emit the
    /// LMB packet once.
    #[test]
    fn diffs_only_emit_on_change() {
        let (mc, rx, _device, _g) = make_ctrl();
        mc.apply_mask_mouse(0x01); // LMB on
        let first = drain(&rx);
        assert_eq!(first.len(), 1, "first call must emit exactly one packet");
        // Setting ID 8 = DisablePassthroughForLmb
        assert_eq!(first[0][1], 8);
        assert_eq!(first[0][2], 1);

        mc.apply_mask_mouse(0x01); // same as before
        let second = drain(&rx);
        assert!(second.is_empty(), "repeated identical call must emit nothing");
    }

    /// Releasing LMB (0x01 -> 0x00) must send the "off" packet.
    #[test]
    fn release_emits_off_packet() {
        let (mc, rx, _device, _g) = make_ctrl();
        mc.apply_mask_mouse(0x01);
        let _ = drain(&rx);
        mc.apply_mask_mouse(0x00);
        let pkts = drain(&rx);
        assert_eq!(pkts.len(), 1);
        assert_eq!(pkts[0][1], 8); // LMB id
        assert_eq!(pkts[0][2], 0); // off
    }

    /// Each per-button bit must map to its expected DeviceSettings ID.
    #[test]
    fn each_button_bit_maps_to_correct_setting_id() {
        let (mc, rx, _device, _g) = make_ctrl();
        // Hit them all in one shot.
        mc.apply_mask_mouse(0x1F); // bits 0..=4 all set
        let pkts = drain(&rx);
        // Setting IDs we expect to see: 8 (LMB), 7 (RMB), 6 (MMB), 9 (Side1), 10 (Side2)
        let ids: Vec<u8> = pkts.iter().map(|p| p[1]).collect();
        for want in [6u8, 7, 8, 9, 10] {
            assert!(ids.contains(&want), "missing setting id {} in {:?}", want, ids);
        }
        // All values should be 1 (mask on).
        for p in &pkts {
            assert_eq!(p[2], 1, "expected value=1 on mask-on packet, got {:?}", p);
        }
    }

    /// X-axis mask transition must trigger Enable+Duration+AmountX (3
    /// packets) and start the watchdog.
    #[test]
    fn x_mask_transition_emits_three_settings_and_starts_watchdog() {
        let (mc, rx, _device, _g) = make_ctrl();
        mc.apply_mask_mouse(MASK_X as u32);
        let pkts = drain(&rx);
        let ids: Vec<u8> = pkts.iter().map(|p| p[1]).collect();
        assert!(ids.contains(&2), "EnableSensReduction (id 2) missing");
        assert!(ids.contains(&3), "Duration (id 3) missing");
        assert!(ids.contains(&4), "AmountX (id 4) missing");
        // Watchdog should be running now.
        assert!(mc.watchdog.lock().unwrap().is_some());
    }

    /// Clearing the X mask must stop the watchdog and emit
    /// AmountX=100 + Enable=0.
    #[test]
    fn clearing_axis_mask_stops_watchdog() {
        let (mc, rx, _device, _g) = make_ctrl();
        mc.apply_mask_mouse(MASK_X as u32);
        let _ = drain(&rx);
        assert!(mc.watchdog.lock().unwrap().is_some());

        mc.apply_mask_mouse(0);
        let pkts = drain(&rx);
        let ids: Vec<u8> = pkts.iter().map(|p| p[1]).collect();
        assert!(ids.contains(&4), "AmountX reset missing");
        assert!(ids.contains(&2), "EnableSensReduction off missing");
        assert!(mc.watchdog.lock().unwrap().is_none());
    }

    /// `unmask_all` zeroes the shadow and emits the full reset bundle.
    #[test]
    fn unmask_all_resets_everything() {
        let (mc, rx, _device, _g) = make_ctrl();
        mc.apply_mask_mouse(MASK_LMB as u32 | MASK_X as u32);
        let _ = drain(&rx);

        mc.apply_unmask_all(0);
        let pkts = drain(&rx);
        let ids: Vec<u8> = pkts.iter().map(|p| p[1]).collect();
        for want in [6u8, 7, 8, 9, 10, 4, 5, 2] {
            assert!(ids.contains(&want), "id {} missing in unmask_all", want);
        }
        assert_eq!(mc.snapshot().mouse_bits, 0);
        assert!(mc.watchdog.lock().unwrap().is_none());
    }

    /// Wheel mask bit must NOT produce a settings packet — only a
    /// warn log. Verifies we didn't accidentally wire it through.
    #[test]
    fn wheel_mask_emits_no_settings_packet() {
        let (mc, rx, _device, _g) = make_ctrl();
        mc.apply_mask_mouse(MASK_WHEEL as u32);
        let pkts = drain(&rx);
        assert!(
            pkts.is_empty(),
            "wheel mask must not produce serial output, got {:?}",
            pkts
        );
    }

    /// Keyboard mask vkey in high bits must NOT produce any settings
    /// packet — pure warn-and-drop.
    #[test]
    fn keyboard_mask_emits_no_settings_packet() {
        let (mc, rx, _device, _g) = make_ctrl();
        // vkey = 0x41 ('A'); low byte stays 0 so no mouse change.
        mc.apply_mask_mouse(0x41 << 8);
        let pkts = drain(&rx);
        assert!(pkts.is_empty());
        assert_eq!(mc.snapshot().last_keyboard_vkey, 0x41);
    }

    /// Watchdog spawn / drop test: when the controller is dropped
    /// the watchdog thread must join (no orphaned threads). We can't
    /// observe the thread directly but `Drop` calls `stop()` which
    /// joins synchronously — if the join blocked forever, this test
    /// would hang (catchable via cargo test's per-test timeout).
    #[test]
    fn watchdog_joins_on_drop() {
        let (mc, _rx, _device, _g) = make_ctrl();
        mc.apply_mask_mouse(MASK_X as u32);
        assert!(mc.watchdog.lock().unwrap().is_some());
        drop(mc);
        // If we get here, the watchdog joined cleanly.
    }
}
