//! KMBox Net UDP wire protocol — the incoming side of the bridge.
//!
//! * [`schema`] — wire-format types ([`Header`], [`SoftMouse`]) and the
//!   `CMD_*` command-code table.
//! * [`parser`] — `impl` blocks that decode each type from a little-endian
//!   byte slice and that build the reply header.
//!
//! All multi-byte fields are little-endian with no padding between them.
//! A packet is a fixed 16-byte [`Header`] followed by a command-specific
//! body (currently always a 56-byte [`SoftMouse`] — keyboard packets are
//! acknowledged with the reply header but the body is not decoded). The
//! reply is a byte-for-byte echo of the request header; strict host apps
//! reject any modification (see [`Header::reply`]).
//!
//! Reference implementation: <https://github.com/kvmaibox/kmboxnet>.

pub mod encryption;
pub mod monitor;
pub mod parser;
pub mod schema;

// Re-export the items most call sites need so consumers can write
// `use crate::kmbox_net::Header;` etc. without reaching into submodules.
pub use schema::{
    cmd_name, Header, MonitorRequest, SoftMouse, CMD_BAZER_MOVE, CMD_CONNECT, CMD_DEBUG,
    CMD_KEYBOARD_ALL, CMD_MASK_MOUSE, CMD_MONITOR, CMD_MOUSE_AUTOMOVE, CMD_MOUSE_LEFT,
    CMD_MOUSE_MIDDLE, CMD_MOUSE_MOVE, CMD_MOUSE_RIGHT, CMD_MOUSE_WHEEL, CMD_REBOOT, CMD_SETCONFIG,
    CMD_SETVIDPID, CMD_SHOWPIC, CMD_TRACE_ENABLE, CMD_UNMASK_ALL, HEADER_LEN,
};
