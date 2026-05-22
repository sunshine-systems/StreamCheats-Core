//! Firmware device-settings ID table and wire builder.
//!
//! The canonical source for these IDs is the `FirmwareSettings::updateSettings`
//! switch in
//! `firmware/libraries/USBHostProxy/examples/SunshineUSBProxy/CommandsSunBoxInterface.cpp`.
//! When the firmware grows a new setting, add the matching variant here
//! with the **same numeric value** the firmware's switch uses, and add a
//! corresponding test below pinning the wire bytes.
//!
//! Wire format (9 bytes — same `PACKET_LEN` as the mouse-HID packet):
//!
//! | Byte | Meaning                                                                     |
//! |-----:|-----------------------------------------------------------------------------|
//! |   0  | `0x03` length prefix — routes the firmware to its settings handler.         |
//! |   1  | Setting ID (the [`DeviceSettings`] variant's discriminant).                 |
//! |   2  | Value byte 0 (little-endian, signed `i16`).                                 |
//! |   3  | Value byte 1.                                                               |
//! | 4..8 | Zero padding so every packet is exactly [`PACKET_LEN`] bytes on the wire.   |
//!
//! Byte-for-byte equivalent to `FirmwareInterface.create_settings_report`
//! in the Python `sunbox_interface` reference.

use super::packet::PACKET_LEN;

/// One of the 12 setting IDs the firmware recognises.
///
/// The enum's `#[repr(u8)]` discriminant *is* the wire byte the firmware
/// switches on, so adding a new variant means picking exactly the same
/// numeric value the firmware's switch uses.
#[repr(u8)]
#[allow(dead_code)] // Most variants are exposed for future use; only FirmwareVersion is wired through today (heartbeat).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceSettings {
    /// ID 0. **Read-only.** Sending this with any value triggers the firmware
    /// to emit a `V: x.xx` line on its serial output. We use it as the
    /// heartbeat because it has no HID side-effect.
    FirmwareVersion = 0,

    /// ID 1. Bool. Toggles the firmware's per-frame performance / log
    /// output stream.
    LogPerformanceMetrics = 1,

    /// ID 2. Bool. Master enable for the sensitivity-reduction
    /// post-processing pipeline that runs on the firmware between the
    /// physical mouse and the host PC's USB HID report.
    EnableSensReduction = 2,

    /// ID 3. Duration (ms) of the sensitivity-reduction window applied
    /// after a triggering event.
    SensReductionDurationMilliseconds = 3,

    /// ID 4. Reduction amount applied to the X axis.
    ///
    /// (The firmware variable is spelled `sensReductionAmmountX` — the
    /// typo is preserved in the firmware source. The wire ID is the same;
    /// we normalise the spelling on our side.)
    SensReductionAmountX = 4,

    /// ID 5. Reduction amount applied to the Y axis. (See note on
    /// [`Self::SensReductionAmountX`] re: firmware spelling.)
    SensReductionAmountY = 5,

    /// ID 6. Bool. Block middle-mouse-button passthrough to the host PC.
    DisablePassthroughForMmb = 6,

    /// ID 7. Bool. Block right-mouse-button passthrough.
    DisablePassthroughForRmb = 7,

    /// ID 8. Bool. Block left-mouse-button passthrough.
    DisablePassthroughForLmb = 8,

    /// ID 9. Bool. Block side-button-1 (MB4) passthrough.
    DisablePassthroughForMb4 = 9,

    /// ID 10. Bool. Block side-button-2 (MB5) passthrough.
    DisablePassthroughForMb5 = 10,

    /// ID 11. Bool. Toggle the firmware's `SYN:` / `M:` delta-logging stream.
    EnableDeltaLogging = 11,
}

/// Wire length-prefix byte that routes the firmware to its settings handler.
/// Mouse-HID packets use `0x08`; settings packets use `0x03`.
pub const SETTINGS_PACKET_PREFIX: u8 = 0x03;

/// Build a 9-byte settings packet for the firmware.
///
/// `value` is packed little-endian and signed; the firmware reads it back
/// as `int16_t settingValue = data[1] | (data[2] << 8)`.
///
/// `const fn` so the heartbeat can be a `const` and the bytes are baked
/// into the binary at compile time.
pub const fn build_settings_packet(setting: DeviceSettings, value: i16) -> [u8; PACKET_LEN] {
    let v = value.to_le_bytes();
    [
        SETTINGS_PACKET_PREFIX,
        setting as u8,
        v[0],
        v[1],
        0,
        0,
        0,
        0,
        0,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_packet_is_firmware_version_zero() {
        // The heartbeat in main.rs sends FirmwareVersion=0. If either
        // changes, this test fails — keep them in sync.
        let p = build_settings_packet(DeviceSettings::FirmwareVersion, 0);
        assert_eq!(p, [0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn enable_sens_reduction_true() {
        let p = build_settings_packet(DeviceSettings::EnableSensReduction, 1);
        assert_eq!(p, [0x03, 2, 0x01, 0x00, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn negative_value_packs_as_le_twos_complement() {
        // -5 as i16 LE = 0xFFFB → bytes [FB, FF]
        let p = build_settings_packet(DeviceSettings::SensReductionAmountX, -5);
        assert_eq!(p, [0x03, 4, 0xFB, 0xFF, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn large_positive_value_packs_le() {
        // 1000ms = 0x03E8 → bytes [E8, 03]
        let p = build_settings_packet(
            DeviceSettings::SensReductionDurationMilliseconds,
            1000,
        );
        assert_eq!(p, [0x03, 3, 0xE8, 0x03, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn max_and_min_i16_values() {
        // i16::MAX = 0x7FFF → [FF, 7F]
        let p = build_settings_packet(DeviceSettings::SensReductionAmountX, i16::MAX);
        assert_eq!(&p[2..4], &[0xFF, 0x7F]);

        // i16::MIN = 0x8000 → [00, 80]
        let p = build_settings_packet(DeviceSettings::SensReductionAmountX, i16::MIN);
        assert_eq!(&p[2..4], &[0x00, 0x80]);
    }

    /// Every variant must keep its firmware-defined ID. This catches any
    /// reorder or accidental gap that would silently corrupt the wire.
    #[test]
    fn variant_discriminants_match_firmware() {
        assert_eq!(DeviceSettings::FirmwareVersion as u8, 0);
        assert_eq!(DeviceSettings::LogPerformanceMetrics as u8, 1);
        assert_eq!(DeviceSettings::EnableSensReduction as u8, 2);
        assert_eq!(DeviceSettings::SensReductionDurationMilliseconds as u8, 3);
        assert_eq!(DeviceSettings::SensReductionAmountX as u8, 4);
        assert_eq!(DeviceSettings::SensReductionAmountY as u8, 5);
        assert_eq!(DeviceSettings::DisablePassthroughForMmb as u8, 6);
        assert_eq!(DeviceSettings::DisablePassthroughForRmb as u8, 7);
        assert_eq!(DeviceSettings::DisablePassthroughForLmb as u8, 8);
        assert_eq!(DeviceSettings::DisablePassthroughForMb4 as u8, 9);
        assert_eq!(DeviceSettings::DisablePassthroughForMb5 as u8, 10);
        assert_eq!(DeviceSettings::EnableDeltaLogging as u8, 11);
    }
}
