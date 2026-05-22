//! Streamcheats 9-byte serial packet builder.
//!
//! Wire format (matches `FirmwareInterface.create_spoofed_hid_report`
//! in the Python `sunbox_interface` reference implementation):
//!
//! ```text
//! [0] 0x08 length prefix
//! [1] buttons (u8 bitmask)
//! [2] x_lo  — direct int8 when -127 ≤ x ≤ 126;
//!             0x7F sentinel when x ≥ 127;
//!             0x80 sentinel when x ≤ -128
//! [3] y_lo  — same convention as x_lo
//! [4] wheel (i8) — firmware reads this slot as scrollWheel; Python
//!                   writes its `sensReduction` flag here (0/1).
//!                   We use it for wheel data so KMBox Net wheel
//!                   commands work; non-wheel commands send 0,
//!                   matching Python's default.
//! [5..7] x extended (i16 LE) — ALWAYS written, full int16 regardless
//!                              of whether x_lo was direct or sentinel
//! [7..9] y extended (i16 LE) — same convention as x
//! ```
//!
//! No trailing newline, no framing other than the length prefix.

use byteorder::{ByteOrder, LittleEndian};

// Button bit positions — must match firmware. The Teensy USB Host Proxy
// reads byte [1] of the 9-byte packet as a standard HID mouse button
// bitmask, so changing these values would desync the host PC's view of
// which button is pressed.
//
// The translator dispatch path no longer references these by name (it
// passes the payload's `button` byte through verbatim, see
// `translator::update_mask_from_payload`), but they remain part of the
// public surface as named values for tests, docs, and any future caller
// that needs to compose a mask programmatically.

/// Bitmask for the primary (left) mouse button — bit 0.
#[allow(dead_code)]
pub const BTN_LEFT: u8 = 0x01;
/// Bitmask for the secondary (right) mouse button — bit 1.
#[allow(dead_code)]
pub const BTN_RIGHT: u8 = 0x02;
/// Bitmask for the middle/wheel mouse button — bit 2.
#[allow(dead_code)]
pub const BTN_MIDDLE: u8 = 0x04;
/// Bitmask for the first side (back/thumb) mouse button — bit 3. Standard
/// HID layout; matches the bit the vendor SDK's `kmNet_mouse_side1`
/// RMWs into `softmouse.button`.
#[allow(dead_code)]
pub const BTN_SIDE1: u8 = 0x08;
/// Bitmask for the second side (forward/thumb) mouse button — bit 4.
/// Standard HID layout; matches the bit the vendor SDK's
/// `kmNet_mouse_side2` RMWs into `softmouse.button`.
#[allow(dead_code)]
pub const BTN_SIDE2: u8 = 0x10;

/// Length in bytes of every Streamcheats serial packet (1 length prefix
/// + 8 payload bytes).
pub const PACKET_LEN: usize = 9;

/// Encode a single axis byte the way the Python reference does:
/// in-range int8 stored directly; out-of-range values get a sentinel
/// (`0x7F` positive, `0x80` negative) and the real value is carried in
/// the extended bytes the caller writes separately.
fn axis_lo(v: i16) -> u8 {
    if v >= 127 {
        0x7F
    } else if v <= -128 {
        0x80
    } else {
        v as i8 as u8
    }
}

/// Build a Streamcheats 9-byte mouse packet. Byte-for-byte equivalent to
/// `FirmwareInterface.create_spoofed_hid_report(buttons, x, y)` in the
/// Python reference; additionally writes `wheel` into the firmware's
/// scrollWheel slot (byte 4), which Python uses for sens-reduction only.
///
/// `x` and `y` are clamped to `i16`. `wheel` is clamped to `i8`.
pub fn build_packet(buttons: u8, x: i32, y: i32, wheel: i32) -> [u8; PACKET_LEN] {
    let xi: i16 = x.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
    let yi: i16 = y.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
    let wi: i8 = wheel.clamp(i8::MIN as i32, i8::MAX as i32) as i8;

    let mut p = [0u8; PACKET_LEN];
    p[0] = 0x08;
    p[1] = buttons;
    p[2] = axis_lo(xi);
    p[3] = axis_lo(yi);
    p[4] = wi as u8;
    LittleEndian::write_i16(&mut p[5..7], xi);
    LittleEndian::write_i16(&mut p[7..9], yi);
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_python_for_in_range_zero() {
        // buttons=Left (0x01), x=0, y=0, wheel=0
        // Python's create_spoofed_hid_report(0x01, 0, 0, False) yields:
        //   bytearray([8, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
        let p = build_packet(BTN_LEFT, 0, 0, 0);
        assert_eq!(p, [0x08, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn matches_python_for_positive_overflow_x() {
        // x=300 -> x_lo = 0x7F sentinel, extended = 0x012C LE = 2C 01
        // y=-50 -> y_lo = (-50 & 0xFF) = 0xCE (direct), extended = 0xFFCE LE = CE FF
        // buttons = Left+Right (0x03), wheel = 0
        let p = build_packet(BTN_LEFT | BTN_RIGHT, 300, -50, 0);
        assert_eq!(
            p,
            [0x08, 0x03, 0x7F, 0xCE, 0x00, 0x2C, 0x01, 0xCE, 0xFF]
        );
    }

    #[test]
    fn matches_python_for_negative_overflow_y() {
        // x=10, y=-200, buttons=0, wheel=0
        // x_lo = 0x0A (direct), y_lo = 0x80 sentinel
        // x ext = 000A LE = 0A 00; y ext = FF38 LE = 38 FF
        let p = build_packet(0, 10, -200, 0);
        assert_eq!(p, [0x08, 0x00, 0x0A, 0x80, 0x00, 0x0A, 0x00, 0x38, 0xFF]);
    }

    #[test]
    fn boundary_minus_128_uses_sentinel() {
        // x=-128 should produce sentinel 0x80, not direct 0x80 (same bits
        // but the firmware's overflowByte check triggers the extended path).
        let p = build_packet(0, -128, 0, 0);
        assert_eq!(p[2], 0x80);
        assert_eq!(p[3], 0x00); // y=0 stays direct
        // x extended = 0xFF80 LE
        assert_eq!(p[5], 0x80);
        assert_eq!(p[6], 0xFF);
    }

    #[test]
    fn boundary_plus_127_uses_sentinel() {
        // x=127 also takes the sentinel branch in Python (>= 127).
        let p = build_packet(0, 127, 0, 0);
        assert_eq!(p[2], 0x7F);
        // x extended = 0x007F LE
        assert_eq!(p[5], 0x7F);
        assert_eq!(p[6], 0x00);
    }

    #[test]
    fn in_range_minus_127_uses_direct_byte() {
        // x=-127 is just inside the in-range window; Python emits direct.
        let p = build_packet(0, -127, 0, 0);
        // -127 as i8 = 0x81 (two's complement)
        assert_eq!(p[2], 0x81);
    }

    #[test]
    fn wheel_only_packet() {
        // x=0, y=0, wheel=-1
        let p = build_packet(0, 0, 0, -1);
        assert_eq!(p, [0x08, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn clamps_out_of_range() {
        let p = build_packet(0, 100_000, -100_000, 1000);
        // i16 clamp: 32767, -32768; i8 clamp: 127
        assert_eq!(p[2], 0x7F); // positive overflow sentinel
        assert_eq!(p[3], 0x80); // negative overflow sentinel
        assert_eq!(p[4], 0x7F); // wheel clamped to i8::MAX
        // x extended = 0x7FFF LE
        assert_eq!(LittleEndian::read_i16(&p[5..7]), i16::MAX);
        assert_eq!(LittleEndian::read_i16(&p[7..9]), i16::MIN);
    }
}
