//! Small log-formatting helpers shared by the [`reader`] and [`writer`]
//! threads.
//!
//! [`reader`]: super::reader
//! [`writer`]: super::writer

use tracing::info;

/// Emit a single firmware line as `IN (<port>): <rendered>`. All-NUL
/// lines (a common transient when the FTDI driver is settling) are
/// discarded so they don't pollute the log.
pub(crate) fn flush_line(port_name: &str, line: &[u8]) {
    if line.iter().all(|&b| b == 0) {
        return; // ignore all-NUL noise
    }
    info!("IN ({}): {}", port_name, render_line(line));
}

/// Render a byte slice as text, escaping non-printable bytes as `\xHH`.
pub(crate) fn render_line(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for &b in bytes {
        if (0x20..=0x7E).contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("\\x{:02X}", b));
        }
    }
    out
}

/// Render a byte slice as space-separated uppercase hex (e.g. `08 01 00 ...`).
/// Used to log outbound Streamcheats packets.
pub(crate) fn hex_bytes(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        s.push_str(&format!("{:02X}", b));
    }
    s
}
