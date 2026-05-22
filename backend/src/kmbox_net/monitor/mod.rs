//! KMBox Net **monitor mode** — the *outgoing* half of the bridge.
//!
//! When a third-party host app calls `kmNet_monitor(port)` against the
//! translator, the box (we are the box) starts pushing UDP echo packets
//! to the app's listening port on every device-state change. This module
//! implements that emitter end-to-end:
//!
//! * [`PeerRegistry`](peer_registry::PeerRegistry) — shared, thread-safe
//!   table of currently-subscribed monitor peers. The translator writes
//!   into it on every `cmd_monitor`; the subscriber thread reads from it
//!   on every `StateChange`.
//! * [`PeerInfo`](peer_info::PeerInfo) — what we remember per peer
//!   (target address, mode flags, subscription/last-emit timestamps,
//!   total emit count).
//! * [`encoder`] — wire-format builder. Produces the 20-byte
//!   `standard_mouse_report_t + standard_keyboard_report_t` datagram
//!   the vendor SDK's `ThreadListenProcess` `memcpy`s into its global
//!   `hw_mouse`/`hw_keyboard` (`kmboxNet.cpp:1530-1531`).
//! * [`subscriber`] — long-running `std::thread` that owns one
//!   outbound UDP socket, subscribes to the [`EventBus`] via
//!   [`DeviceController::subscribe`], and per event fans out to every
//!   registered peer.
//!
//! # Threading
//!
//! Single dedicated thread (`monitor_emitter`) consumes the
//! `mpsc::Receiver<StateChange>` returned by `DeviceController::subscribe()`
//! with a 250 ms `recv_timeout` so it exits promptly when the global
//! shutdown flag flips. The thread holds its own `UdpSocket` bound to
//! `0.0.0.0:0` (the vendor SDK opens a separate socket too — `kmboxNet.cpp:1511`).
//!
//! # Logging
//!
//! All log lines use the `MONITOR:` prefix to keep them grep-able as a
//! distinct channel alongside `IN (KMBOX NET):`, `OUT (COMx):`, etc.
//!
//! [`EventBus`]: crate::streamcheats::EventBus
//! [`DeviceController::subscribe`]: crate::streamcheats::DeviceController::subscribe

pub mod encoder;
pub mod peer_info;
pub mod peer_registry;
pub mod subscriber;

#[allow(unused_imports)]
pub use peer_info::PeerInfo;
pub use peer_registry::PeerRegistry;
pub use subscriber::spawn_monitor_thread;
