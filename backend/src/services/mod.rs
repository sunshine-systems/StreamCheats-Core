//! Cross-cutting orchestration services.
//!
//! Each submodule provides a focused, testable orchestrator that pulls
//! state from the device-specific modules (`streamcheats`, `kmbox_net`)
//! and composes it into something an HTTP route can hand back to the
//! caller. Protocol-specific logic stays in those modules — services
//! never speak the wire format.
//!
//! * [`bug_report`] — builds the in-memory zip returned by
//!   `POST /bug-report` (log slice + config snapshot + system info +
//!   device state + manifest).
//! * [`log_stream`] — bounded ring buffer + tokio broadcast pair fed by
//!   a tracing layer; powers the `/logs/stream` WebSocket.

pub mod bug_report;
pub mod log_stream;
