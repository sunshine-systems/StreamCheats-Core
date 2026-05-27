//! `tracing_subscriber::Layer` implementation that publishes each event
//! into the ring + broadcast.
//!
//! Unlike the stdout / file layers (which use `fmt::Layer` to format a
//! full `<RFC3339> <LEVEL> <message>` line), this layer captures *only*
//! the event's `message` field body. The `LogEvent` wire format already
//! carries timestamp (`ts`) and `level` as structured fields, so
//! including them in `line` causes the UI to render the timestamp and
//! level twice — once from the structured fields and again as a leading
//! prefix in the message body.
//!
//! We implement `Layer<S>` directly (rather than piggy-backing on
//! `fmt::Layer` + `MakeWriter`) because:
//!   1. We don't want the timestamp / level prefix at all — fmt's
//!      "no format" mode still adds them.
//!   2. We want the level from `Metadata` (a `&'static str`) cheaply,
//!      without re-parsing it back out of the formatted string.
//!   3. A bespoke visitor that just snags `message` is ~30 lines and
//!      avoids dragging `MakeWriter` + a Drop-flushed buffer through
//!      the hot path.

use std::fmt::{self, Write as _};
use std::sync::Arc;

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

use super::broadcast::LogBroadcaster;
use super::event::LogEvent;
use super::ring::LogRing;

/// `Layer` that captures each event's message body and publishes a
/// `LogEvent` to the ring + broadcaster.
pub struct LogStreamLayer {
    ring: Arc<LogRing>,
    broadcaster: LogBroadcaster,
}

impl LogStreamLayer {
    pub fn new(ring: Arc<LogRing>, broadcaster: LogBroadcaster) -> Self {
        Self { ring, broadcaster }
    }
}

impl<S: Subscriber> Layer<S> for LogStreamLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        if visitor.message.is_empty() {
            // No message field — nothing meaningful to surface in the UI.
            return;
        }
        let level = event.metadata().level().as_str();
        let line = strip_ansi(&visitor.message);
        let log_event = LogEvent::new(level, line);
        self.ring.push(log_event.clone());
        self.broadcaster.publish(log_event);
    }
}

/// Visits an event's fields and concatenates the `message` field (the
/// formatted body of `tracing::info!("…")` / friends) into a string.
///
/// Non-`message` fields are intentionally ignored: the daemon doesn't
/// emit structured key/value pairs today, and surfacing them inline
/// would re-introduce noise the UI isn't prepared to render.
#[derive(Default)]
struct MessageVisitor {
    message: String,
}

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" {
            // `Debug` formatting of `format_args!` output yields the
            // plain string with no surrounding quoting, which is what
            // we want.
            let _ = write!(&mut self.message, "{value:?}");
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        }
    }
}

/// Strip ANSI CSI escape sequences (`ESC [ ... m` and friends). The
/// daemon's macros shouldn't emit them, but the strip is cheap
/// insurance against a future caller that pipes pre-colorized text
/// through `tracing::info!`.
fn strip_ansi(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1B && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            // Skip ESC [
            i += 2;
            // Skip parameter / intermediate bytes (0x20-0x3F)
            while i < bytes.len() && (0x20..=0x3F).contains(&bytes[i]) {
                i += 1;
            }
            // Skip final byte (0x40-0x7E)
            if i < bytes.len() && (0x40..=0x7E).contains(&bytes[i]) {
                i += 1;
            }
        } else {
            // Push the byte through. Input is &str so it's already
            // valid UTF-8 — push char by walking the UTF-8 boundary.
            let ch = input[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt;

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        let raw = "\x1b[2mhidden\x1b[0m visible \x1b[31mred\x1b[0m";
        assert_eq!(strip_ansi(raw), "hidden visible red");
    }

    #[test]
    fn strip_ansi_passes_clean_text_through() {
        assert_eq!(strip_ansi("plain"), "plain");
        assert_eq!(strip_ansi("héllo"), "héllo");
    }

    #[test]
    fn layer_captures_message_only_no_ts_or_level_prefix() {
        let ring = Arc::new(LogRing::new(10));
        let bc = LogBroadcaster::new();
        let layer = LogStreamLayer::new(ring.clone(), bc.clone());
        let mut rx = bc.subscribe();

        let subscriber = tracing_subscriber::registry().with(layer);
        let dispatch = tracing::Dispatch::new(subscriber);
        tracing::dispatcher::with_default(&dispatch, || {
            tracing::info!("STATE: starting up");
        });

        let ev = rx.try_recv().expect("event");
        // Stream-bound `line` must be just the message body — no
        // leading RFC-3339 timestamp, no leading level token.
        assert_eq!(ev.line, "STATE: starting up");
        assert_eq!(ev.level, "INFO");
        // Defensive: explicitly check we don't accidentally start with
        // a 4-digit year (RFC 3339) or one of the level tokens. This
        // is the exact regression the fix targets.
        assert!(
            !ev.line.starts_with(|c: char| c.is_ascii_digit()),
            "line should not start with a digit: {:?}",
            ev.line
        );
        for tok in ["TRACE ", "DEBUG ", "INFO ", "WARN ", "ERROR "] {
            assert!(
                !ev.line.starts_with(tok),
                "line should not start with level token {tok:?}: {:?}",
                ev.line
            );
        }

        let snap = ring.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].line, "STATE: starting up");
    }
}
