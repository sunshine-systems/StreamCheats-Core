//! Real-time log streaming.
//!
//! Provides a tracing subscriber layer that captures every formatted
//! log event into both a bounded ring buffer (for replay-on-connect)
//! and a tokio broadcast channel (for live fan-out). The HTTP layer's
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
//! # Format consistency
//!
//! The layer is built on top of `tracing_subscriber::fmt::Layer` with a
//! custom `MakeWriter` that buffers per-event bytes and pushes them
//! through on `Drop`. The fmt configuration matches the stdout and file
//! layers (no target, no ANSI), so each line emitted onto the WS is
//! byte-identical (sans trailing newline) to what's written to disk.

use std::sync::Arc;

use tracing_subscriber::fmt::format::DefaultFields;
use tracing_subscriber::fmt::Layer as FmtLayer;
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
    let writer = layer::LogStreamWriter::new(ring.clone(), broadcaster.clone());

    // The stream-bound formatter intentionally drops the RFC-3339
    // timestamp and the level prefix — both already travel as
    // structured fields on `LogEvent` (`ts`, `level`), and rendering
    // them inside `line` made the UI display each value twice (once
    // as a column, again at the head of the message body). The
    // stdout/file fmt::Layer is configured separately and still emits
    // the full `<ts> <LEVEL> <msg>` shape for on-disk archival.
    //
    // Per-layer EnvFilter (`info` default, overridable via RUST_LOG)
    // mirrors the stdout/file layers — without it the global registry
    // would feed us every TRACE event from `tungstenite`, `hyper`, etc.,
    // and the WS would become an unreadable firehose of crate-internal
    // chatter.
    let fmt_layer: FmtLayer<tracing_subscriber::Registry, DefaultFields, _, _> =
        tracing_subscriber::fmt::layer()
            .with_target(false)
            .with_ansi(false)
            .with_level(false)
            .without_time()
            .with_writer(writer);
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let filtered = fmt_layer.with_filter(filter);

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
        // Composing a `Box<dyn Layer<Registry>>` over a plain registry
        // works because the registry doesn't change shape (no
        // EnvFilter on top); add a filter inline if you need to scope
        // levels in future.
        let subscriber = tracing_subscriber::registry().with(layer);
        let dispatch = tracing::Dispatch::new(subscriber);
        tracing::dispatcher::with_default(&dispatch, || {
            tracing::info!("hello from test");
            tracing::warn!("something amiss");
        });

        // Buffered writers flushed on drop above. Drain the broadcast.
        let first = rx.try_recv().expect("first event");
        let second = rx.try_recv().expect("second event");
        assert!(first.line.contains("hello from test"));
        assert_eq!(first.level, "INFO");
        assert!(second.line.contains("something amiss"));
        assert_eq!(second.level, "WARN");

        let snap = handles.ring.snapshot();
        assert_eq!(snap.len(), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn streamed_line_omits_timestamp_and_level_prefix() {
        // Regression test for the duplicated-ts/duplicated-level UI bug.
        // Structured `ts` + `level` already travel as their own fields,
        // so `line` must contain only the message body.
        let (layer, handles) = build();
        let subscriber = tracing_subscriber::registry().with(layer);
        let dispatch = tracing::Dispatch::new(subscriber);
        tracing::dispatcher::with_default(&dispatch, || {
            tracing::info!("file logging: enabled");
            tracing::warn!("amiss");
            tracing::error!("kaboom");
        });

        let snap = handles.ring.snapshot();
        assert_eq!(snap.len(), 3);
        for ev in &snap {
            // No RFC-3339 prefix (would start with a digit).
            assert!(
                ev.line.as_bytes().first().map(|b| !b.is_ascii_digit()).unwrap_or(true),
                "streamed line must not start with a timestamp: {:?}",
                ev.line,
            );
            // No leading level token.
            for level in ["INFO", "WARN", "ERROR", "DEBUG", "TRACE"] {
                assert!(
                    !ev.line.starts_with(&format!("{level} ")),
                    "streamed line must not begin with a level prefix: {:?}",
                    ev.line,
                );
            }
        }
        assert_eq!(snap[0].line, "file logging: enabled");
        assert_eq!(snap[1].line, "amiss");
        assert_eq!(snap[2].line, "kaboom");
    }
}
