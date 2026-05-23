//! Serial reader thread: reads from the serial port concurrently with
//! the writer (serial2 supports `&self` on both directions), buffers
//! bytes by newline, and emits one `IN (COMx):` log line per complete
//! firmware response line. Non-printable bytes are escaped as `\xHH`.
//!
//! Every complete non-NUL line also increments the shared
//! `lines_received` counter so the heartbeat thread can detect when
//! the device has gone unresponsive even though USB is still alive.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use tracing::warn;

use super::format::{flush_line, render_line};
use crate::firmware::device::LastHeartbeat;

/// Reader loop: collects bytes from the firmware, splits on newline, and
/// logs every complete line as `IN (<port>): <text>`. Non-printable bytes
/// are rendered as `\xHH` so binary noise stays readable. A 4 KiB
/// safety cap forces a flush if the firmware ever omits a newline.
///
/// Exits when the per-session `session_running` flag flips to `false`
/// (the supervisor signalling teardown, or another thread requesting
/// disconnect) OR when `read` returns a non-recoverable error (Windows
/// USB-CDC's "device unplugged" path). The read-error path **also**
/// flips `session_running` to `false` so the writer thread notices and
/// can run the disconnect SOP — without that hand-off, paused
/// heartbeats would leave the writer with no traffic to fail on and
/// the supervisor would stall.
pub(crate) fn serial_reader_loop(
    serial: &serial2::SerialPort,
    port_name: &str,
    session_running: Arc<AtomicBool>,
    lines_received: Arc<AtomicU64>,
    last_heartbeat: LastHeartbeat,
) {
    let mut buf = [0u8; 256];
    let mut line: Vec<u8> = Vec::with_capacity(256);

    while session_running.load(Ordering::SeqCst) {
        match serial.read(&mut buf) {
            Ok(0) => {}
            Ok(n) => {
                for &b in &buf[..n] {
                    if b == b'\n' {
                        // Count real activity from the firmware. The
                        // all-NUL noise that FTDI drivers sometimes
                        // emit during port settling doesn't qualify as
                        // a sign of life.
                        if !line.is_empty() && line.iter().any(|&b| b != 0) {
                            lines_received.fetch_add(1, Ordering::Relaxed);
                            // Inspect the rendered line for the
                            // `V: x.xx` heartbeat reply so the firmware
                            // updater can surface installed version.
                            // Render once; the format helper escapes
                            // non-printable bytes so the parser sees
                            // the same text the log line shows.
                            let rendered = render_line(&line);
                            last_heartbeat.observe_line(&rendered);
                        }
                        flush_line(port_name, &line);
                        line.clear();
                    } else if b == b'\r' {
                        // swallow — handled together with the following LF
                    } else {
                        line.push(b);
                        // Guard against runaway buffer if the firmware
                        // never sends a newline.
                        if line.len() > 4096 {
                            if line.iter().any(|&b| b != 0) {
                                lines_received.fetch_add(1, Ordering::Relaxed);
                                let rendered = render_line(&line);
                                last_heartbeat.observe_line(&rendered);
                            }
                            flush_line(port_name, &line);
                            line.clear();
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
                // Anything else (BrokenPipe, NotConnected, Os{...}) is
                // almost certainly "the user unplugged the Teensy".
                // Bail and signal the writer so it can run the SOP and
                // the supervisor can rescan.
                warn!("serial read error on {}: {} — ending session", port_name, e);
                session_running.store(false, Ordering::SeqCst);
                break;
            }
        }
    }

    // Flush any partial trailing line on shutdown.
    if !line.is_empty() {
        flush_line(port_name, &line);
    }
}
