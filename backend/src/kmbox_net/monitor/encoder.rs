//! Wire-format encoder for monitor-mode echo packets.
//!
//! Vendor format (`c++_demo/NetConfig/kmboxNet.cpp:1530-1531` of
//! `ThreadListenProcess`):
//!
//! ```text
//! offset  size  field                source
//!   0      1    mouse.report_id      standard_mouse_report_t
//!   1      1    mouse.buttons        ”
//!   2      2    mouse.x   (i16 LE)   ”
//!   4      2    mouse.y   (i16 LE)   ”
//!   6      2    mouse.wheel (i16 LE) ”
//!   8      1    kbd.report_id        standard_keyboard_report_t
//!   9      1    kbd.modifier         ”
//!  10     10    kbd.keys[10]         ”
//! ```
//!
//! Total: 20 bytes. The receiver does
//! `memcpy(&hw_mouse, buff, 8); memcpy(&hw_keyboard, &buff[8], 12);`
//! so any bytes beyond offset 19 are ignored. The translator carries no
//! keyboard state, so offsets 8..20 are always zero — the host app's
//! `kmNet_monitor_keyboard()` helper will report no keys held, which is
//! accurate.
//!
//! `report_id` is `0` here. The vendor SDK doesn't set it from the wire
//! on the receive side (it just `memcpy`s the whole buffer into its
//! global) and host apps read only `buttons`, `x`, `y`, `wheel` (see
//! `kmNet_monitor_mouse_*` at `kmboxNet.cpp:1620-1710`), so zero is
//! both legal and unambiguous.

use crate::kmbox_net::schema::MONITOR_PACKET_LEN;

/// Render one device-state slice as a 20-byte monitor echo datagram.
/// See module-level docs for the byte layout and rationale.
///
/// `dx`, `dy`, `wheel` come from the
/// [`crate::streamcheats::StateChange`] event being processed when the
/// dispatcher chooses to encode — they are NOT necessarily
/// `state.last_dx`/`last_dy`/`last_wheel` (those fields are also touched
/// by serial sends that occur between the bus publish and our send).
/// Passing them explicitly keeps the encoder deterministic and testable.
pub fn encode_state(button_mask: u8, dx: i16, dy: i16, wheel: i16) -> [u8; MONITOR_PACKET_LEN] {
    let mut buf = [0u8; MONITOR_PACKET_LEN];
    // standard_mouse_report_t — 8 bytes
    buf[0] = 0; // report_id (vendor doesn't read this on receive)
    buf[1] = button_mask;
    buf[2..4].copy_from_slice(&dx.to_le_bytes());
    buf[4..6].copy_from_slice(&dy.to_le_bytes());
    buf[6..8].copy_from_slice(&wheel.to_le_bytes());
    // standard_keyboard_report_t — 12 bytes, all zeros (translator has
    // no keyboard state to publish; see module docs).
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_buttons_in_byte_1() {
        let p = encode_state(0x02, 0, 0, 0);
        assert_eq!(p[1], 0x02);
    }

    #[test]
    fn encodes_positive_dx_dy_as_le_i16() {
        let p = encode_state(0, 10, 10, 0);
        // 10 LE = 0x0A 0x00
        assert_eq!(&p[2..4], &[0x0A, 0x00]);
        assert_eq!(&p[4..6], &[0x0A, 0x00]);
    }

    #[test]
    fn encodes_negative_dx_dy_as_two_complement_le() {
        let p = encode_state(0, -1, -2, 0);
        assert_eq!(&p[2..4], &[0xFF, 0xFF]); // -1 i16 LE
        assert_eq!(&p[4..6], &[0xFE, 0xFF]); // -2 i16 LE
    }

    #[test]
    fn encodes_wheel_in_bytes_6_7() {
        let p = encode_state(0, 0, 0, -1);
        assert_eq!(&p[6..8], &[0xFF, 0xFF]);
    }

    #[test]
    fn keyboard_section_is_all_zero() {
        let p = encode_state(0xFF, 999, -999, 7);
        assert_eq!(&p[8..20], &[0u8; 12], "keyboard 12 bytes must be all zero");
    }

    #[test]
    fn full_packet_for_state_buttons_0x02_dx10_dy10_matches_vendor_layout() {
        // The headline test from the task spec: buttons=0x02, dx=10, dy=10.
        // Expected wire bytes:
        //   [report_id=0, buttons=0x02, x=10LE, y=10LE, wheel=0LE, kbd 12x0]
        let p = encode_state(0x02, 10, 10, 0);
        let expected: [u8; 20] = [
            0x00, 0x02, // report_id, buttons
            0x0A, 0x00, // x = 10
            0x0A, 0x00, // y = 10
            0x00, 0x00, // wheel = 0
            // keyboard 12 bytes, all zero
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        assert_eq!(p, expected);
    }
}
