//! Sens-reduction watchdog: keeps the firmware's event-gated
//! sens-reduction window armed while the host has X or Y masked.
//!
//! The firmware exposes movement masking as a *duration-bounded*
//! amount-reduction post-process: a single HID packet with `wheel=1`
//! (the firmware reads byte 4 as a re-arm trigger when sens reduction
//! is enabled) starts a window of `SensReductionDurationMilliseconds`
//! during which X/Y deltas from the physical mouse are scaled by the
//! `SensReductionAmount{X,Y}` factor. If the host wants X/Y suppressed
//! continuously, somebody has to keep re-arming that window before it
//! expires.
//!
//! The watchdog owns a `std::thread` that, every [`PUMP_INTERVAL`],
//! pushes one `(current_buttons, 0, 0, wheel=1)` packet through the
//! [`DeviceController`]. It snapshots `current_buttons` from the
//! controller each tick so a held button is never accidentally
//! released. The thread joins via a shared `Arc<AtomicBool>` flag the
//! controller flips on demand (mask cleared or process shutdown).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tracing::{debug, info};

use crate::streamcheats::DeviceController;

/// Cadence at which the pump re-emits the wheel=1 re-arm packet.
/// 50ms is half the typical firmware sens-reduction window (~100ms
/// default), giving us headroom to ride out one missed tick before
/// the window collapses and a stray physical-mouse delta sneaks
/// through.
pub const PUMP_INTERVAL: Duration = Duration::from_millis(50);

/// Handle to a running watchdog. Drop the handle to stop the pump
/// (the `Drop` impl signals the stop flag and joins the thread).
pub struct Watchdog {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Watchdog {
    /// Spawn the pump thread. `device` is the controller the pump will
    /// borrow each tick for the current-button snapshot + the serial
    /// emit. `global_running` is the program-wide shutdown flag — the
    /// pump exits whenever either it or its own private stop flag flips.
    pub fn spawn(device: Arc<DeviceController>, global_running: Arc<AtomicBool>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = stop.clone();
        let join = thread::spawn(move || {
            info!("STATE: mask watchdog spawned (interval={:?})", PUMP_INTERVAL);
            let mut next_at = Instant::now() + PUMP_INTERVAL;
            while !stop_for_thread.load(Ordering::SeqCst)
                && global_running.load(Ordering::SeqCst)
            {
                let now = Instant::now();
                if now < next_at {
                    // Sleep at most 25ms at a time so the stop signal
                    // is honoured within ~25ms instead of up to 50.
                    let nap = (next_at - now).min(Duration::from_millis(25));
                    thread::sleep(nap);
                    continue;
                }

                // Snapshot the live button mask so the watchdog never
                // accidentally releases a held button while pumping.
                let buttons = device.current_buttons();
                device.apply_axis_mask_rearm(buttons);
                next_at = now + PUMP_INTERVAL;
            }
            debug!("STATE: mask watchdog stopping");
        });
        Watchdog {
            stop,
            join: Some(join),
        }
    }

    /// Signal the pump to stop and join the thread. Idempotent.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        self.stop();
    }
}
