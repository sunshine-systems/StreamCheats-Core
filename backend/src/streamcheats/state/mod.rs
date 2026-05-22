//! Authoritative device-state machine + pub/sub event bus for the
//! Streamcheats USB-host-proxy.
//!
//! This module is the foundation for a multi-step refactor:
//!
//! 1. (this commit) introduces [`DeviceState`], [`StateChange`], and
//!    [`EventBus`]; the [`super::device::DeviceController`] wires them
//!    together. Nothing in the existing codebase calls it yet — it's
//!    intentionally inert wiring so it can ship in isolation.
//! 2. (next task) `util::translator` is refactored to delegate every
//!    button / move / wheel mutation to a shared `DeviceController`
//!    instead of holding its own `Arc<Mutex<u8>>` button mask.
//! 3. (later task) `kmbox_net::monitor` subscribes to the bus and
//!    emits UDP datagrams describing each state change to whoever
//!    asked to be monitored.

pub mod bus;
pub mod device_state;
pub mod event;

pub use bus::EventBus;
pub use device_state::DeviceState;
pub use event::StateChange;
