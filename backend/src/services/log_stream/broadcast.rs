//! Thin wrapper around `tokio::sync::broadcast` so subscribers can
//! receive live `LogEvent`s as they're emitted by the tracing layer.
//!
//! Per-subscriber buffer cap is 8 192 events — generous enough that a
//! slow renderer won't drop frames during typical activity, but bounded
//! so a wedged client can't pin the daemon's memory. On overflow the
//! receiver gets a `RecvError::Lagged(n)` which the WS handler
//! translates into a `{"type":"lagged","count":n}` frame so the UI can
//! show a "dropped N" indicator instead of pretending nothing happened.

use tokio::sync::broadcast;

use super::event::LogEvent;

/// Per-subscriber capacity. Matches the spec.
pub const CHANNEL_CAPACITY: usize = 8_192;

/// Clone-cheap sender handle the tracing layer holds.
#[derive(Debug, Clone)]
pub struct LogBroadcaster {
    tx: broadcast::Sender<LogEvent>,
}

impl LogBroadcaster {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
        Self { tx }
    }

    /// Publish an event. When there are no subscribers `send` returns
    /// `Err(SendError)`; that's the expected resting state and we just
    /// swallow it.
    pub fn publish(&self, event: LogEvent) {
        let _ = self.tx.send(event);
    }

    /// Hand out a fresh receiver. Each WS connection takes one.
    pub fn subscribe(&self) -> broadcast::Receiver<LogEvent> {
        self.tx.subscribe()
    }

    /// Live subscriber count. Useful for tests and for an eventual
    /// "/logs/stats" probe; not currently surfaced over HTTP.
    #[allow(dead_code)]
    pub fn receiver_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

impl Default for LogBroadcaster {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(line: &str) -> LogEvent {
        LogEvent {
            ts: "ts".into(),
            level: "INFO".into(),
            line: line.into(),
        }
    }

    #[test]
    fn publish_without_subscribers_does_not_panic() {
        let b = LogBroadcaster::new();
        b.publish(ev("alone"));
    }

    #[tokio::test]
    async fn subscriber_receives_published_event() {
        let b = LogBroadcaster::new();
        let mut rx = b.subscribe();
        b.publish(ev("hello"));
        let got = rx.recv().await.expect("recv");
        assert_eq!(got.line, "hello");
    }

    #[tokio::test]
    async fn two_subscribers_both_receive() {
        let b = LogBroadcaster::new();
        let mut rx1 = b.subscribe();
        let mut rx2 = b.subscribe();
        b.publish(ev("fanout"));
        assert_eq!(rx1.recv().await.unwrap().line, "fanout");
        assert_eq!(rx2.recv().await.unwrap().line, "fanout");
    }
}
