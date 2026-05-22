//! Wire format for log events streamed over `/logs/stream`.
//!
//! Kept deliberately small: a wall-clock timestamp, a level string the
//! UI can switch on for coloring, and the fully-formatted `line` (which
//! already carries any prefix conventions like `IN (KMBOX NET):` or
//! `OUT (COMx):` that the daemon emits).
//!
//! The renderer parses prefixes itself for coloring, so we don't try to
//! split fields out here — keeping a single `line` mirrors the file
//! appender exactly and avoids reformatting drift between channels.

use serde::Serialize;

/// One JSON frame the WebSocket sends per event.
///
/// `ts` is rendered as an RFC 3339 timestamp with millisecond precision
/// in UTC so the frontend can sort / lay out chronologically without
/// needing to know the daemon's local-time offset.
#[derive(Debug, Clone, Serialize)]
pub struct LogEvent {
    /// ISO-8601 / RFC-3339 UTC timestamp, e.g. `2026-05-21T18:34:01.234Z`.
    pub ts: String,
    /// Level name in upper case: `INFO`, `WARN`, `ERROR`, `DEBUG`, `TRACE`.
    pub level: String,
    /// Fully formatted log line, ANSI codes stripped. Carries any
    /// channel prefixes (`IN (KMBOX NET):`, `OUT (COMx):`, etc.) that
    /// the existing fmt layer already produces.
    pub line: String,
}

impl LogEvent {
    /// Build an event with the current UTC wall clock. `level` is
    /// coerced to upper case so the frontend can switch on it without a
    /// further case fold.
    pub fn new(level: impl Into<String>, line: impl Into<String>) -> Self {
        let ts = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        Self {
            ts,
            level: level.into().to_uppercase(),
            line: line.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_event_serializes_expected_shape() {
        let e = LogEvent {
            ts: "2026-05-21T18:34:01.234Z".to_string(),
            level: "INFO".to_string(),
            line: "hello world".to_string(),
        };
        let json = serde_json::to_string(&e).expect("serialize");
        assert!(json.contains("\"ts\":\"2026-05-21T18:34:01.234Z\""));
        assert!(json.contains("\"level\":\"INFO\""));
        assert!(json.contains("\"line\":\"hello world\""));
    }

    #[test]
    fn new_uppercases_level_and_carries_line() {
        let e = LogEvent::new("info", "the line");
        assert_eq!(e.level, "INFO");
        assert_eq!(e.line, "the line");
        // Timestamp shape: YYYY-MM-DDTHH:MM:SS.mmmZ — 24 chars.
        assert_eq!(e.ts.len(), 24, "ts={:?}", e.ts);
        assert!(e.ts.ends_with('Z'));
    }
}
