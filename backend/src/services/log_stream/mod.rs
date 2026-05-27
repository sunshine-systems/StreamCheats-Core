//! Real-time log streaming.
//!
//! Provides a tracing subscriber layer that captures every event into
//! both a bounded ring buffer (for replay-on-connect) and a tokio
//! broadcast channel (for live fan-out). The HTTP layer's
//! `/logs/stream` WebSocket route consumes those handles.
//!
//! # Wire-up sketch
//!
//! ```ignore
//! let (layer, handles) = log_stream::build();
//! tracing_subscriber::registry().with(stdout_layer).with(file_layer).with(layer).init();
//! // Stash `handles` on AppState so the route can read the ring and
//! // subscribe to the broadcast.
//! ```
//!
//! # Format intent
//!
//! Unlike the stdout / file layers (which use `fmt::Layer` to write a
//! full `<RFC3339> <LEVEL> <message>` line), the stream layer captures
//! *only* the event's `message` body. The `LogEvent` wire format
//! already carries timestamp and level as structured fields (`ts` /
//! `level`), so including them in `line` causes the UI to render them
//! twice — once from the structured fields and again as a leading
//! prefix in the message body. Keep the stream-bound line
//! message-only; let the file appender keep the full prefixed format.

use std::sync::Arc;

use tracing_subscriber::{EnvFilter, Layer};

pub mod broadcast;
pub mod event;
pub mod layer;
pub mod ring;

pub use broadcast::LogBroadcaster;
pub use event::LogEvent;
pub use ring::LogRing;

/// Clone-cheap pair of handles the HTTP layer needs to serve
/// `/logs/stream`. Stashed on `AppState`.
#[derive(Clone)]
pub struct LogStreamHandles {
    pub ring: Arc<LogRing>,
    pub broadcaster: LogBroadcaster,
}

/// Build the tracing layer + the matching handles. The layer is boxed
/// to a concrete `Layer<Registry>` so `init_logging` can drop it into
/// its existing `Vec<Box<dyn Layer<_>>>` collector without further
/// generics gymnastics.
pub fn build() -> (
    Box<dyn Layer<tracing_subscriber::Registry> + Send + Sync>,
    LogStreamHandles,
) {
    let ring = Arc::new(LogRing::new(ring::DEFAULT_CAPACITY));
    let broadcaster = LogBroadcaster::new();
    let layer = layer::LogStreamLayer::new(ring.clone(), broadcaster.clone());

    // Per-layer EnvFilter (`info` default, overridable via RUST_LOG)
    // mirrors the stdout / file layers — without it the global registry
    // would feed us every TRACE event from `tungstenite`, `hyper`, etc.,
    // and the WS would become an unreadable firehose of crate-internal
    // chatter.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let filtered = layer.with_filter(filter);

    let boxed: Box<dyn Layer<tracing_subscriber::Registry> + Send + Sync> = Box::new(filtered);
    let handles = LogStreamHandles { ring, broadcaster };
    (boxed, handles)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt;

    #[tokio::test(flavor = "current_thread")]
    async fn layer_publishes_to_ring_and_broadcast() {
        let (layer, handles) = build();
        let mut rx = handles.broadcaster.subscribe();

        // Dedicated dispatcher scoped to this test — no `init()` so we
        // don't poison the process-global subscriber for sibling tests.
        let subscriber = tracing_subscriber::registry().with(layer);
        let dispatch = tracing::Dispatch::new(subscriber);
        tracing::dispatcher::with_default(&dispatch, || {
            tracing::info!("hello from test");
            tracing::warn!("something amiss");
        });

        let first = rx.try_recv().expect("first event");
        let second = rx.try_recv().expect("second event");
        // Stream-bound `line` carries the message body only — no
        // RFC-3339 timestamp prefix, no level prefix. The structured
        // `ts` / `level` fields on `LogEvent` are the source of truth.
        assert_eq!(first.line, "hello from test");
        assert_eq!(first.level, "INFO");
        assert_eq!(second.line, "something amiss");
        assert_eq!(second.level, "WARN");

        let snap = handles.ring.snapshot();
        assert_eq!(snap.len(), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn streamed_line_does_not_start_with_timestamp_or_level() {
        // Regression guard for the duplicate-ts-and-level bug. The
        // stream layer must not prefix the message with a timestamp or
        // a level token — those live on the structured `ts` / `level`
        // fields of `LogEvent` and the UI renders them as separate
        // columns.
        let (layer, handles) = build();
        let mut rx = handles.broadcaster.subscribe();

        let subscriber = tracing_subscriber::registry().with(layer);
        let dispatch = tracing::Dispatch::new(subscriber);
        tracing::dispatcher::with_default(&dispatch, || {
            tracing::info!("STATE: connected");
            tracing::warn!("OUT (COM3): packet rejected");
            tracing::error!("disk full");
        });

        for _ in 0..3 {
            let ev = rx.try_recv().expect("event");
            assert!(
                !ev.line.starts_with(|c: char| c.is_ascii_digit()),
                "line must not start with a digit (would be RFC-3339 ts): {:?}",
                ev.line
            );
            for tok in ["TRACE ", "DEBUG ", "INFO ", "WARN ", "ERROR "] {
                assert!(
                    !ev.line.starts_with(tok),
                    "line must not start with level token {tok:?}: {:?}",
                    ev.line
                );
            }
        }

        // Ring snapshot mirrors the broadcast — same invariant.
        for ev in handles.ring.snapshot() {
            assert!(
                !ev.line.starts_with(|c: char| c.is_ascii_digit()),
                "ring line must not start with digit: {:?}",
                ev.line
            );
        }
    }
}
