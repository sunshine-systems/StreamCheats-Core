//! Bounded ring buffer of recently-emitted `LogEvent`s.
//!
//! When a renderer first connects to `/logs/stream`, it gets a snapshot
//! of this buffer before live events start streaming so the user sees
//! context (typically: daemon startup banner + the most recent few
//! seconds of activity).
//!
//! Capacity is 5 000 events — enough to cover ~1 minute of busy serial
//! traffic without bloating memory (5 000 × ~200 B ≈ 1 MiB). Older
//! events fall off the front on overflow.

use std::collections::VecDeque;
use std::sync::Mutex;

use super::event::LogEvent;

/// Default capacity (matches the spec; kept as a const so tests can
/// reuse it without literal drift).
pub const DEFAULT_CAPACITY: usize = 5_000;

/// Thread-safe bounded FIFO of recent events.
#[derive(Debug)]
pub struct LogRing {
    inner: Mutex<VecDeque<LogEvent>>,
    capacity: usize,
}

impl LogRing {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(VecDeque::with_capacity(capacity)),
            capacity,
        }
    }

    /// Append one event. If the ring is at capacity the oldest entry is
    /// dropped to make room.
    pub fn push(&self, event: LogEvent) {
        let mut q = self.inner.lock().expect("log ring mutex poisoned");
        if q.len() == self.capacity {
            q.pop_front();
        }
        q.push_back(event);
    }

    /// Clone the current contents into a `Vec`. Used by the WS handler
    /// on first connect to flush recent history before subscribing to
    /// the live broadcast.
    pub fn snapshot(&self) -> Vec<LogEvent> {
        let q = self.inner.lock().expect("log ring mutex poisoned");
        q.iter().cloned().collect()
    }

    /// Current ring depth. Exposed primarily for tests.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.lock().expect("log ring mutex poisoned").len()
    }

    /// Ring capacity (constant for the lifetime of the ring).
    #[allow(dead_code)]
    pub fn capacity(&self) -> usize {
        self.capacity
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
    fn push_grows_until_capacity() {
        let ring = LogRing::new(3);
        ring.push(ev("a"));
        ring.push(ev("b"));
        assert_eq!(ring.len(), 2);
        ring.push(ev("c"));
        assert_eq!(ring.len(), 3);
    }

    #[test]
    fn push_over_capacity_drops_oldest() {
        let ring = LogRing::new(3);
        for line in ["a", "b", "c", "d", "e"] {
            ring.push(ev(line));
        }
        let snap = ring.snapshot();
        assert_eq!(snap.len(), 3);
        let lines: Vec<&str> = snap.iter().map(|e| e.line.as_str()).collect();
        assert_eq!(lines, vec!["c", "d", "e"]);
    }

    #[test]
    fn snapshot_clones_independently() {
        let ring = LogRing::new(5);
        ring.push(ev("a"));
        let snap1 = ring.snapshot();
        ring.push(ev("b"));
        let snap2 = ring.snapshot();
        assert_eq!(snap1.len(), 1);
        assert_eq!(snap2.len(), 2);
    }

    #[test]
    fn default_capacity_is_5000() {
        assert_eq!(DEFAULT_CAPACITY, 5_000);
    }
}
