//! `cmd_mask_mouse` + `cmd_unmask_all` implementation.
//!
//! Module layout follows the project convention (one concern per file):
//! * [`state`] — `MaskState` snapshot + bit constants
//! * [`controller`] — diff-and-emit `MaskController`
//! * [`watchdog`] — sens-reduction re-arm pump thread
//!
//! Top-level translator dispatches into [`MaskController`]; the
//! controller in turn borrows a [`crate::streamcheats::DeviceController`]
//! to send settings packets and (via the watchdog) periodic HID
//! re-arm packets while X/Y axes are masked.

pub mod controller;
pub mod state;
pub mod watchdog;

pub use controller::MaskController;
#[allow(unused_imports)]
pub use state::MaskState;
