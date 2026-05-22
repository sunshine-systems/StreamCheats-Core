//! Heartbeat thread: emits a benign 9-byte settings packet every
//! [`HEARTBEAT_INTERVAL`] so the USB-serial chip and the Windows COM
//! driver never enter an idle low-power state. Matches
//! `FirmwareInterface.py`'s `_send_heartbeat`.
//!
//! Also watches a shared "lines received" counter (bumped by the
//! reader for every real firmware line) so an unresponsive but
//! USB-still-alive device can be detected and heartbeat sends paused
//! until the firmware starts talking again. Pausing matters because
//! the writer's disconnect SOP only triggers on three consecutive
//! *heartbeat write* failures — once writes succeed but the device
//! ignores them, hammering the chip with more heartbeats helps nobody.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tracing::{error, info, warn};

use super::{build_settings_packet, DeviceSettings, PACKET_LEN};
use crate::util::translator::SerialTxHolder;

/// Heartbeat interval — matches `FirmwareInterface.py`'s 2.5 s. The
/// hardware works at this cadence in Python; if it doesn't in Rust the
/// fix isn't to spam the chip with a faster heartbeat, it's to find
/// what's different about the write path.
pub(crate) const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(2500);

/// 9-byte heartbeat packet — a [`DeviceSettings::FirmwareVersion`] read
/// with value `0`. Triggers the firmware's `V: x.xx` reply line on its
/// serial output and has no HID side-effect. Byte-for-byte identical to
/// Python's `create_settings_report("FIRMWARE_VERSION", 0, 0)`. Pinned
/// in `streamcheats::device_settings::tests::heartbeat_packet_is_firmware_version_zero`.
pub(crate) const HEARTBEAT_PACKET: [u8; PACKET_LEN] =
    build_settings_packet(DeviceSettings::FirmwareVersion, 0);

/// Consecutive unanswered heartbeats (no firmware lines received in
/// the interval) before the loop declares the device unresponsive and
/// pauses sends. 3 × 2.5 s = ~7.5 s of silence — long enough to ride
/// out a transient firmware hiccup, short enough to stop bothering a
/// hung device quickly. Once paused, any non-NUL firmware line at all
/// flips the loop back to active.
const UNANSWERED_THRESHOLD: u32 = 3;

/// Heartbeat loop: every [`HEARTBEAT_INTERVAL`] checks the shared
/// `lines_received` counter against the value it saw at its last send.
/// A positive delta means the firmware has been talking and the
/// heartbeat is considered "answered" (the firmware acks with a `V:`
/// line, and even unrelated `I:`/`S:` lines count as proof of life).
/// Three consecutive zero-deltas log a warning, then an error, then
/// flip the loop into a **paused** state where it stops sending —
/// `holder.send()` would still succeed at the OS level and we don't
/// want to spray a hung device with stale prompts. While paused the
/// loop keeps polling the counter; the moment the firmware emits
/// anything the loop resumes its cadence.
///
/// The holder being `None` (no active session) is its own pause: no
/// sends, no counter checks, miss counter and pause state reset on
/// the next session-start transition.
///
/// Polls in 100 ms ticks rather than sleeping for the full interval so
/// Ctrl+C shutdown is honoured within ~100 ms instead of up to 2.5 s.
pub(crate) fn heartbeat_loop(
    tx: SerialTxHolder,
    running: Arc<AtomicBool>,
    lines_received: Arc<AtomicU64>,
) {
    let mut last_send_count: u64 = 0;
    let mut consecutive_misses: u32 = 0;
    let mut paused = false;
    let mut had_session = false;

    let mut next_at = Instant::now() + HEARTBEAT_INTERVAL;
    while running.load(Ordering::SeqCst) {
        let now = Instant::now();
        if now < next_at {
            let remaining = next_at.saturating_duration_since(now);
            thread::sleep(remaining.min(Duration::from_millis(100)));
            continue;
        }

        let guard = tx.lock().unwrap();
        let session_active = guard.is_some();

        // Session boundary: reset miss + pause state every time a new
        // session opens. Skip the responsiveness check on the very
        // first tick of a session because we haven't sent anything yet
        // for the new device to respond to.
        if session_active && !had_session {
            had_session = true;
            consecutive_misses = 0;
            paused = false;
            last_send_count = lines_received.load(Ordering::Relaxed);
            if let Some(sender) = guard.as_ref() {
                info!("Sending heartbeat (firmware version request)");
                let _ = sender.send((Instant::now(), HEARTBEAT_PACKET));
                last_send_count = lines_received.load(Ordering::Relaxed);
            }
            drop(guard);
            next_at = now + HEARTBEAT_INTERVAL;
            continue;
        } else if !session_active && had_session {
            had_session = false;
        }

        if !session_active {
            drop(guard);
            next_at = now + HEARTBEAT_INTERVAL;
            continue;
        }

        // Responsiveness: did the reader log anything from the
        // firmware since our last send?
        let current = lines_received.load(Ordering::Relaxed);
        let delta = current.saturating_sub(last_send_count);

        if delta > 0 {
            if paused {
                info!("Device responding again — resuming heartbeats");
                paused = false;
            } else if consecutive_misses > 0 {
                info!("Firmware activity detected — heartbeat miss counter reset");
            }
            consecutive_misses = 0;
        } else if !paused {
            consecutive_misses += 1;
            warn!(
                "Heartbeat unanswered ({}/{})",
                consecutive_misses, UNANSWERED_THRESHOLD
            );
            if consecutive_misses >= UNANSWERED_THRESHOLD {
                error!(
                    "Device stopped responding to heartbeats — pausing sends until firmware activity resumes"
                );
                paused = true;
            }
        }
        // (paused + delta == 0 → stay silently paused)

        if !paused {
            if let Some(sender) = guard.as_ref() {
                info!("Sending heartbeat (firmware version request)");
                let _ = sender.send((Instant::now(), HEARTBEAT_PACKET));
                last_send_count = lines_received.load(Ordering::Relaxed);
            }
        }
        drop(guard);
        next_at = now + HEARTBEAT_INTERVAL;
    }
}
