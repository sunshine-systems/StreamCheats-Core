//! `tracing_subscriber::fmt::Layer` adapter that publishes each event
//! into the ring + broadcast.
//!
//! Rather than implementing `Layer<S>` from scratch and reformatting
//! events by hand (which would inevitably drift from the stdout / file
//! layers' format), we piggy-back on the existing `fmt::Layer` by
//! plugging in a custom `MakeWriter` that returns a per-event capture
//! buffer. When tracing drops the buffer (end of event formatting), the
//! buffer's `Drop` impl extracts the bytes, strips ANSI codes, parses
//! out the level, and pushes a `LogEvent` to both the ring and the
//! broadcaster.
//!
//! Why per-event: `MakeWriter::make_writer_for(&Metadata)` is called
//! once per event, giving us access to the level cheaply (it lives on
//! the metadata) and isolating one event's bytes into a private buffer.
//! That avoids the alternative of locking a shared buffer per write
//! and trying to split-on-newline ourselves.

use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use tracing::Metadata;
use tracing_subscriber::fmt::MakeWriter;

use super::broadcast::LogBroadcaster;
use super::event::LogEvent;
use super::ring::LogRing;

/// Per-event capture buffer. Implements `Write` so `fmt::Layer` can
/// write its formatted line into it; on `Drop` it flushes the captured
/// bytes through the ring + broadcast pipeline.
pub struct CaptureWriter {
    buf: Vec<u8>,
    level: String,
    ring: Arc<LogRing>,
    broadcaster: LogBroadcaster,
}

impl Write for CaptureWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for CaptureWriter {
    fn drop(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        // The formatter ends each event with a newline; trim it so the
        // wire-form line doesn't double-newline in the UI.
        let mut line = String::from_utf8_lossy(&self.buf).into_owned();
        if line.ends_with('\n') {
            line.pop();
            if line.ends_with('\r') {
                line.pop();
            }
        }
        let line = strip_ansi(&line);
        let event = LogEvent::new(&self.level, line);
        self.ring.push(event.clone());
        self.broadcaster.publish(event);
    }
}

/// `MakeWriter` factory that hands out fresh `CaptureWriter`s.
#[derive(Clone)]
pub struct LogStreamWriter {
    ring: Arc<LogRing>,
    broadcaster: LogBroadcaster,
    // Per-event level captured via `make_writer_for`. Stashed on the
    // writer itself when constructed so `Drop` can attach it to the
    // event without re-parsing the formatted line.
    pending_level: Arc<Mutex<&'static str>>,
}

impl LogStreamWriter {
    pub fn new(ring: Arc<LogRing>, broadcaster: LogBroadcaster) -> Self {
        Self {
            ring,
            broadcaster,
            pending_level: Arc::new(Mutex::new("INFO")),
        }
    }
}

impl<'a> MakeWriter<'a> for LogStreamWriter {
    type Writer = CaptureWriter;

    fn make_writer(&'a self) -> Self::Writer {
        CaptureWriter {
            buf: Vec::with_capacity(256),
            level: (*self.pending_level.lock().unwrap()).to_string(),
            ring: self.ring.clone(),
            broadcaster: self.broadcaster.clone(),
        }
    }

    fn make_writer_for(&'a self, meta: &Metadata<'_>) -> Self::Writer {
        CaptureWriter {
            buf: Vec::with_capacity(256),
            level: meta.level().to_string(),
            ring: self.ring.clone(),
            broadcaster: self.broadcaster.clone(),
        }
    }
}

/// Strip ANSI CSI escape sequences (`ESC [ ... m` and friends). We
/// configure the fmt layer with `with_ansi(false)` so this should be a
/// no-op in practice, but the strip is cheap insurance against a
/// future change that flips colors back on.
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
    fn capture_writer_publishes_on_drop() {
        let ring = Arc::new(LogRing::new(10));
        let bc = LogBroadcaster::new();
        let mut w = CaptureWriter {
            buf: Vec::new(),
            level: "INFO".into(),
            ring: ring.clone(),
            broadcaster: bc.clone(),
        };
        write!(w, "hello world\n").unwrap();
        drop(w);
        let snap = ring.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].line, "hello world");
        assert_eq!(snap[0].level, "INFO");
    }

    #[test]
    fn capture_writer_drops_empty_silently() {
        let ring = Arc::new(LogRing::new(10));
        let bc = LogBroadcaster::new();
        let w = CaptureWriter {
            buf: Vec::new(),
            level: "INFO".into(),
            ring: ring.clone(),
            broadcaster: bc,
        };
        drop(w);
        assert_eq!(ring.len(), 0);
    }
}
