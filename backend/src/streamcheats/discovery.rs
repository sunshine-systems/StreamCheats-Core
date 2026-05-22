//! COM-port auto-discovery for the Teensy USB Host Proxy firmware.
//!
//! At startup (and again whenever a session ends) the supervisor calls
//! [`discover_device`], which enumerates every serial port the OS knows
//! about and probes them all in parallel. Each probe opens the port at
//! [`BAUD`], reads with a short timeout, and watches for a complete line
//! that begins with one of the six prefixes our firmware emits
//! ([`FIRMWARE_PREFIXES`]). The first probe to match wins; the others
//! are aborted via a shared [`AtomicBool`] and joined.
//!
//! No assumptions are made about VID/PID — the firmware's own serial
//! chatter is the only fingerprint. This means swapping a Teensy or
//! plugging in two of them on different USB-serial chips both Just Work.
//!
//! See `main::supervisor_loop` for how discovery fits into the lifecycle.
//!
//! [`AtomicBool`]: std::sync::atomic::AtomicBool

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use tracing::{debug, warn};

/// Baud rate hardcoded across the crate. The Teensy firmware is fixed at
/// 115200; nothing else is in scope.
pub(crate) const BAUD: u32 = 115200;

/// Exact byte prefixes the firmware emits at the start of every line.
/// Matching against these (rather than a generic `^[A-Z]+:` regex) avoids
/// false-positives from unrelated devices that happen to print uppercase
/// debug text on their CDC interface.
///
/// Mirrors the prefix table documented in `src/main.rs`'s module docs:
/// `S: ` system, `I: ` info, `V: ` version, `E: ` error, `M: ` mouse
/// button event, `SYN:` delta-logging (no space — digits follow directly).
pub(crate) const FIRMWARE_PREFIXES: &[&[u8]] = &[
    b"S: ", b"I: ", b"V: ", b"E: ", b"M: ", b"SYN:",
];

/// Returns `true` if `line` (with any trailing `\r` already stripped)
/// begins with one of the six [`FIRMWARE_PREFIXES`]. Used by the probe
/// threads after each newline split and by the unit tests.
pub(crate) fn is_firmware_line(line: &[u8]) -> bool {
    FIRMWARE_PREFIXES.iter().any(|p| line.starts_with(p))
}

/// Scans `buf` for newline-terminated lines and returns `true` as soon
/// as it finds one that passes [`is_firmware_line`]. A trailing partial
/// line (no terminating `\n`) is ignored — the probe loop will collect
/// more bytes and re-check on the next iteration. `\r` characters are
/// stripped before matching so CRLF lines work too.
pub(crate) fn buffer_has_firmware_line(buf: &[u8]) -> bool {
    // `split('\n')` always yields one more element than the count of
    // separators, and the final element is whatever lies after the last
    // `\n` (empty if buf ends in '\n', a partial line otherwise). We
    // only want to match *completed* lines, so iterate everything
    // except the trailing element.
    let mut chunks = buf.split(|&b| b == b'\n').peekable();
    while let Some(raw) = chunks.next() {
        if chunks.peek().is_none() {
            // Trailing partial line — don't try to match it.
            break;
        }
        let line = if raw.last() == Some(&b'\r') {
            &raw[..raw.len() - 1]
        } else {
            raw
        };
        if is_firmware_line(line) {
            return true;
        }
    }
    false
}

/// Probe a single port for `probe_secs`. On success returns the open
/// port (still ready for read/write). On no-match or any error returns
/// `None`. The probe bails early when `abort` flips to `true`, so the
/// supervisor can cancel sibling probes once one of them wins.
fn probe_one(name: &PathBuf, probe_secs: u64, abort: &AtomicBool) -> Option<serial2::SerialPort> {
    let mut port = match serial2::SerialPort::open(name, BAUD) {
        Ok(p) => p,
        Err(e) => {
            debug!("probe: open {} failed: {}", name.display(), e);
            return None;
        }
    };
    // Short read timeout so the probe loop checks `abort` and the
    // overall deadline frequently. 100ms is small enough to be
    // responsive without burning a CPU.
    if let Err(e) = port.set_read_timeout(Duration::from_millis(100)) {
        debug!("probe: set_read_timeout {} failed: {}", name.display(), e);
        return None;
    }
    // Match the eventual session config so the chip wakes up the same
    // way during the probe as it will during the run.
    let _ = port.set_dtr(true);
    let _ = port.set_rts(true);

    let deadline = Instant::now() + Duration::from_secs(probe_secs);
    let mut accum: Vec<u8> = Vec::with_capacity(512);
    let mut chunk = [0u8; 256];

    while Instant::now() < deadline {
        if abort.load(Ordering::Relaxed) {
            return None;
        }
        match port.read(&mut chunk) {
            Ok(0) => {}
            Ok(n) => {
                accum.extend_from_slice(&chunk[..n]);
                if buffer_has_firmware_line(&accum) {
                    return Some(port);
                }
                // Cap accumulated buffer at 8 KiB — a runaway non-firmware
                // device shouldn't make us hold unbounded memory. Drop
                // the oldest half and keep matching forward.
                if accum.len() > 8192 {
                    accum.drain(..4096);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
                debug!("probe: read {} failed: {}", name.display(), e);
                return None;
            }
        }
    }
    None
}

/// Enumerate all serial ports and probe them in parallel for up to
/// `probe_secs` seconds each. Returns the first port whose firmware
/// banner matches, or `None` if no port produced a matching line.
///
/// The returned `SerialPort` is still open and configured at [`BAUD`]
/// with a 100 ms read timeout — the caller is expected to re-apply the
/// session's preferred timeouts (typically a 2 s read timeout and a 0
/// write timeout) before handing it to the writer/reader threads.
pub(crate) fn discover_device(probe_secs: u64) -> Option<(String, serial2::SerialPort)> {
    let ports = match serial2::SerialPort::available_ports() {
        Ok(p) => p,
        Err(e) => {
            warn!("could not enumerate serial ports: {}", e);
            return None;
        }
    };
    if ports.is_empty() {
        return None;
    }

    let abort = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<(String, serial2::SerialPort)>();
    let mut handles = Vec::with_capacity(ports.len());

    for path in ports {
        let abort = abort.clone();
        let tx = tx.clone();
        handles.push(thread::spawn(move || {
            if let Some(port) = probe_one(&path, probe_secs, &abort) {
                // First sender wins — losers (we got a match but
                // another thread did too in the same instant) just
                // silently drop the port via channel-send failure.
                let name = path.to_string_lossy().into_owned();
                let _ = tx.send((name, port));
            }
        }));
    }
    drop(tx);

    // Block until either someone wins or every probe finishes (channel
    // closes via the last sender being dropped above + every spawned
    // thread returning).
    let result = rx.recv().ok();

    // Signal any still-running probes to exit, then join everyone so we
    // don't leak threads holding ports open. `recv()` may also have
    // returned `None` if every probe finished without a match — in that
    // case `abort` is harmless to set.
    abort.store(true, Ordering::Relaxed);
    for h in handles {
        let _ = h.join();
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_every_known_prefix_embedded_in_noise() {
        // Each known prefix should be matched even when surrounded by
        // garbage data and trailing CR. We feed the full prefix list
        // one at a time so a regression on any single prefix shows up
        // by name.
        for prefix in FIRMWARE_PREFIXES {
            let mut buf = b"\x00random junk\xffno match here\n".to_vec();
            buf.extend_from_slice(prefix);
            buf.extend_from_slice(b"payload\r\n");
            assert!(
                buffer_has_firmware_line(&buf),
                "prefix {:?} should match",
                std::str::from_utf8(prefix).unwrap()
            );
        }
    }

    #[test]
    fn rejects_unknown_prefix() {
        // `X: hello\n` should NOT match — letter X is not one of ours.
        let buf = b"X: hello world\n".to_vec();
        assert!(!buffer_has_firmware_line(&buf));
    }

    #[test]
    fn rejects_known_letter_without_space() {
        // `I:hello\n` (missing space after the colon) must NOT match.
        // The firmware always emits `I: ...` with a space; the only
        // space-less prefix is `SYN:`.
        let buf = b"I:hello\n".to_vec();
        assert!(!buffer_has_firmware_line(&buf));
    }

    #[test]
    fn requires_complete_line() {
        // Partial line without a terminating newline must not match
        // even if the prefix is in there — we wait for a full line so
        // we don't false-positive on a half-buffered "S: " that turns
        // out to be the back half of another device's noise.
        let buf = b"S: starting up".to_vec();
        assert!(!buffer_has_firmware_line(&buf));
    }

    #[test]
    fn syn_prefix_matches_with_digits_immediately() {
        // The delta-log prefix `SYN:` is followed directly by digits —
        // no intervening space.
        let buf = b"SYN:12345\n".to_vec();
        assert!(buffer_has_firmware_line(&buf));
    }

    #[test]
    fn handles_crlf_line_endings() {
        // CRLF (firmware uses `\r\n` via Arduino's `println`) should
        // strip the `\r` before checking the prefix.
        let buf = b"V: 5.17\r\n".to_vec();
        assert!(buffer_has_firmware_line(&buf));
    }

    #[test]
    fn matches_second_line_after_noise_line() {
        // If a non-matching line arrives first followed by a firmware
        // line, we still match the firmware line.
        let buf = b"garbage line one\nS: hello\n".to_vec();
        assert!(buffer_has_firmware_line(&buf));
    }

    #[test]
    fn empty_buffer_does_not_match() {
        assert!(!buffer_has_firmware_line(b""));
    }

    #[test]
    fn is_firmware_line_direct() {
        // Direct exercise of the single-line predicate so a regression
        // there shows up without depending on the buffer splitter.
        assert!(is_firmware_line(b"S: ready"));
        assert!(is_firmware_line(b"SYN:000000"));
        assert!(!is_firmware_line(b"S:ready")); // missing space
        assert!(!is_firmware_line(b""));
        assert!(!is_firmware_line(b"hello"));
    }
}
