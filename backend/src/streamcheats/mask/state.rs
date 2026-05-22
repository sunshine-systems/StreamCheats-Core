//! Mask-state snapshot — what the host currently wants masked.
//!
//! The host's `kmNet_mask_mouse_*` calls are cumulative: every call
//! RMWs one bit into a persistent global (`mask_keyboard_mouse_flag`)
//! and re-sends the FULL flag word in `head.rand`. We mirror that
//! cumulative model here so we can diff "what was asked last time"
//! against "what's being asked now" and only emit serial deltas.
//!
//! Wire bit layout (low byte of `head.rand`, vendor `kmboxNet.cpp:1185-1317`):
//!
//! | Bit | Meaning         |
//! |----:|-----------------|
//! |  0  | LMB             |
//! |  1  | RMB             |
//! |  2  | MMB             |
//! |  3  | Side1           |
//! |  4  | Side2           |
//! |  5  | X axis          |
//! |  6  | Y axis          |
//! |  7  | Wheel (unsupp.) |
//!
//! Higher bits (`(vkey << 8)`) carry the requested keyboard mask vkey
//! when the host calls `kmNet_mask_keyboard`. The firmware has no
//! keyboard channel, so the translator surfaces a WARN and drops it.

/// Bit positions inside `head.rand`'s low byte. Names mirror the
/// vendor source's BIT0…BIT7 macros so cross-referencing stays trivial.
pub const MASK_LMB: u8 = 1 << 0;
pub const MASK_RMB: u8 = 1 << 1;
pub const MASK_MMB: u8 = 1 << 2;
pub const MASK_SIDE1: u8 = 1 << 3;
pub const MASK_SIDE2: u8 = 1 << 4;
pub const MASK_X: u8 = 1 << 5;
pub const MASK_Y: u8 = 1 << 6;
pub const MASK_WHEEL: u8 = 1 << 7;

/// Snapshot of what the host has asked the firmware to suppress. All
/// fields default to "nothing masked" — equivalent to the vendor SDK's
/// `mask_keyboard_mouse_flag == 0` startup state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MaskState {
    /// Cumulative low-byte (mouse-side) mask bits. Direct copy of the
    /// host's `mask_keyboard_mouse_flag & 0xFF`.
    pub mouse_bits: u8,
    /// vkey extracted from the upper bits of `head.rand` on the most
    /// recent `mask_keyboard` call. Carried purely for logging — the
    /// firmware has no keyboard mask channel so we never act on it.
    pub last_keyboard_vkey: u16,
}

#[allow(dead_code)] // helpers exposed for diagnostics + future use
impl MaskState {
    /// True iff the X-axis mask bit is set.
    #[inline]
    pub fn mask_x(&self) -> bool { (self.mouse_bits & MASK_X) != 0 }
    /// True iff the Y-axis mask bit is set.
    #[inline]
    pub fn mask_y(&self) -> bool { (self.mouse_bits & MASK_Y) != 0 }
    /// True iff either X or Y is masked — the condition under which
    /// the watchdog pump should be running.
    #[inline]
    pub fn axis_mask_active(&self) -> bool { self.mask_x() || self.mask_y() }
}
