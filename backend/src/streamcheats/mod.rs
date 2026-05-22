//! Streamcheats firmware binary protocol — everything that talks to the
//! Teensy USB Host Proxy over serial. Both the wire-format builders and
//! the threads that actually push bytes onto / pull bytes off the wire
//! live here:
//!
//! * [`packet`] — 9-byte mouse-HID packet builder + button bitmask
//!   constants. The format and the "always-populate the extended (x, y)"
//!   rationale live at the top of that file.
//! * [`device_settings`] — `DeviceSettings` enum (the 18 firmware
//!   setting IDs) + 3-byte settings packet builder.
//! * [`writer`] — serial writer thread: drains the mpsc channel and
//!   `write_all`s each packet to the port.
//! * [`reader`] — serial reader thread: reads concurrently with the
//!   writer (`serial2` allows `&self` on both directions), buffers by
//!   `\n`, and emits each firmware line as an `IN (COMx)` log.
//! * [`heartbeat`] — keepalive thread: every
//!   `HEARTBEAT_INTERVAL` pushes a benign settings packet so the
//!   USB-serial chip never enters an idle low-power state.
//! * [`mod@format`] — small render helpers (`hex_bytes`,
//!   `render_line`, `flush_line`) shared by [`writer`] and [`reader`].
//!
//! Reference for the wire format: `FirmwareInterface.create_spoofed_hid_report`
//! in the Python `sunbox_interface` package — the Rust [`build_packet`]
//! is byte-for-byte compatible with that reference, with the single
//! intentional difference that byte 4 carries wheel data instead of
//! Python's `sensReduction` flag.

pub mod device;
pub mod device_settings;
pub mod discovery;
pub mod format;
pub mod heartbeat;
pub mod mask;
pub mod packet;
pub mod reader;
pub mod state;
pub mod writer;

pub use device_settings::{build_settings_packet, DeviceSettings};
// Re-export BTN_* even though the translator no longer references them by
// name — they document the standard HID button-bit layout and remain
// available to tests, future call sites, and downstream consumers.
#[allow(unused_imports)]
pub use packet::{build_packet, BTN_LEFT, BTN_MIDDLE, BTN_RIGHT, BTN_SIDE1, BTN_SIDE2, PACKET_LEN};

// Device-state machine + event bus. Re-exported at the streamcheats
// level so downstream subscribers (the future `kmbox_net::monitor`
// emitter) can `use crate::streamcheats::{DeviceController, ...}`
// without descending into the submodule path.
pub use device::DeviceController;
pub use mask::MaskController;
#[allow(unused_imports)]
pub use state::{DeviceState, EventBus, StateChange};
