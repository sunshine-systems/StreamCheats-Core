//! Heartbeat-derived installed-firmware tracking.
//!
//! The daemon's heartbeat (see [`crate::streamcheats::heartbeat`])
//! triggers a `V: x.xx` reply from the firmware on every tick. The
//! serial reader passes every complete line through
//! [`LastHeartbeat::observe_line`] which extracts the version + bumps a
//! timestamp.
//!
//! Single source of truth: the orchestrator and any future endpoint
//! (e.g. SC-7's `/api/device/status`) both read installed firmware
//! state from this struct rather than re-implementing the parser.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::filename::FirmwareVersion;

/// How long without a heartbeat-derived version line before we declare
/// the installed version `Unknown`. Three heartbeat ticks (3 × 2.5 s)
/// with a small fudge factor — short enough that a disconnected device
/// clears within ~10 s, long enough to ride out a single stray miss.
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(10);

/// Shared "last firmware version we saw" state. Cheap to clone — the
/// inner mutex is poisoned-safe (locks recovered via `.into_inner()`).
#[derive(Clone, Default)]
pub struct LastHeartbeat {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    version: Option<FirmwareVersion>,
    /// `Instant` we last successfully parsed a `V:` line. Used to
    /// compare against [`HEARTBEAT_TIMEOUT`] when callers ask for the
    /// current version.
    at: Option<Instant>,
}

/// Snapshot returned to callers — opaque to the rest of the daemon so
/// the underlying storage can evolve without touching the consumers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstalledFirmware {
    /// We have a recent `V:` reply within the timeout window.
    Known {
        version: FirmwareVersion,
        /// Time since the line was observed, in milliseconds. Surfaced
        /// alongside the version so the UI can render "seen 2s ago"
        /// without doing its own clock math.
        age_ms: u64,
    },
    /// No `V:` reply within the timeout window — device disconnected,
    /// silent, or never plugged in.
    Unknown,
}

impl LastHeartbeat {
    /// Fresh tracker with no history.
    pub fn new() -> Self {
        Self::default()
    }

    /// Inspect a raw firmware-emitted line. If it matches `V: <maj>.<min>`
    /// (the heartbeat reply shape, see
    /// [`crate::streamcheats::heartbeat::HEARTBEAT_PACKET`]), the version
    /// is captured and the timestamp bumped. Non-matching lines are a
    /// silent no-op — the reader passes everything through.
    pub fn observe_line(&self, line: &str) {
        if let Some(v) = parse_version_line(line) {
            self.record(v, Instant::now());
        }
    }

    /// Test/internal hook so unit tests can inject a specific timestamp
    /// instead of relying on wall-clock progression.
    pub fn record(&self, version: FirmwareVersion, at: Instant) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.version = Some(version);
        g.at = Some(at);
    }

    /// Snapshot the current installed-firmware state. Uses `now` so
    /// tests can pin the timeout boundary deterministically.
    pub fn snapshot_at(&self, now: Instant) -> InstalledFirmware {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match (g.version, g.at) {
            (Some(v), Some(at)) => {
                let age = now.saturating_duration_since(at);
                if age <= HEARTBEAT_TIMEOUT {
                    InstalledFirmware::Known {
                        version: v,
                        age_ms: age.as_millis().min(u64::MAX as u128) as u64,
                    }
                } else {
                    InstalledFirmware::Unknown
                }
            }
            _ => InstalledFirmware::Unknown,
        }
    }

    /// Convenience: snapshot using wall-clock `Instant::now()`.
    pub fn snapshot(&self) -> InstalledFirmware {
        self.snapshot_at(Instant::now())
    }
}

/// Parse a `V: <maj>.<min>` (with optional surrounding whitespace) into
/// a [`FirmwareVersion`]. Tolerates the `\xNN` rendered noise the
/// reader's [`crate::streamcheats::format::render_line`] emits for
/// non-printable bytes — we look at the *prefix* only.
pub(crate) fn parse_version_line(line: &str) -> Option<FirmwareVersion> {
    let s = line.trim();
    let rest = s.strip_prefix("V:")?.trim_start();
    // Accept anything from "5.17" up to "5.17<trailing junk>" — stop at
    // the first non-digit/non-dot character. Some firmware builds append
    // build metadata to the V: line.
    let mut end = 0;
    for (i, c) in rest.char_indices() {
        if c.is_ascii_digit() || c == '.' {
            end = i + c.len_utf8();
        } else {
            break;
        }
    }
    if end == 0 {
        return None;
    }
    FirmwareVersion::parse(&rest[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn parses_canonical_v_line() {
        let v = parse_version_line("V: 5.17").unwrap();
        assert_eq!(
            v,
            FirmwareVersion {
                major: 5,
                minor: 17
            }
        );
    }

    #[test]
    fn parses_v_line_no_space() {
        let v = parse_version_line("V:5.17").unwrap();
        assert_eq!(
            v,
            FirmwareVersion {
                major: 5,
                minor: 17
            }
        );
    }

    #[test]
    fn ignores_unrelated_lines() {
        assert!(parse_version_line("I: hello").is_none());
        assert!(parse_version_line("S: startup").is_none());
        assert!(parse_version_line("").is_none());
    }

    #[test]
    fn tolerates_trailing_junk() {
        let v = parse_version_line("V: 5.17 build=foo").unwrap();
        assert_eq!(
            v,
            FirmwareVersion {
                major: 5,
                minor: 17
            }
        );
    }

    #[test]
    fn snapshot_returns_unknown_when_empty() {
        let h = LastHeartbeat::new();
        assert_eq!(h.snapshot(), InstalledFirmware::Unknown);
    }

    #[test]
    fn observe_line_captures_version() {
        let h = LastHeartbeat::new();
        h.observe_line("V: 5.17");
        match h.snapshot() {
            InstalledFirmware::Known { version, .. } => {
                assert_eq!(
                    version,
                    FirmwareVersion {
                        major: 5,
                        minor: 17
                    }
                );
            }
            _ => panic!("expected Known"),
        }
    }

    #[test]
    fn snapshot_goes_unknown_after_timeout() {
        let h = LastHeartbeat::new();
        let t0 = Instant::now();
        h.record(
            FirmwareVersion {
                major: 5,
                minor: 17,
            },
            t0,
        );
        // Just inside the timeout window → Known.
        let still_known = h.snapshot_at(t0 + HEARTBEAT_TIMEOUT - Duration::from_millis(100));
        assert!(matches!(still_known, InstalledFirmware::Known { .. }));
        // Past the window → Unknown.
        let gone = h.snapshot_at(t0 + HEARTBEAT_TIMEOUT + Duration::from_secs(1));
        assert_eq!(gone, InstalledFirmware::Unknown);
    }

    #[test]
    fn observe_non_version_line_does_not_clear_existing() {
        let h = LastHeartbeat::new();
        h.observe_line("V: 5.17");
        h.observe_line("I: random noise");
        assert!(matches!(h.snapshot(), InstalledFirmware::Known { .. }));
    }
}
