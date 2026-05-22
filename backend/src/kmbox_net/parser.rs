//! Parsing of incoming KMBox Net packets and construction of replies.

use anyhow::{bail, Result};
use byteorder::{ByteOrder, LittleEndian};

use super::schema::{Header, SoftMouse, HEADER_LEN, SOFT_MOUSE_LEN};
// Re-export of `MonitorRequest` not needed at this layer — the decoder
// is `MonitorRequest::from_header` and lives in `schema.rs`; this `use`
// is only here so the test below can reference it without descending.
#[cfg(test)]
use super::schema::{MonitorRequest, CMD_MONITOR, MONITOR_RAND_MAGIC};

impl Header {
    /// Decode the leading 16 bytes of `bytes` as a [`Header`]. Returns an
    /// error if the slice is shorter than [`HEADER_LEN`]; trailing bytes
    /// (the command body) are ignored and parsed separately by the body
    /// type that matches the command code.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < HEADER_LEN {
            bail!(
                "packet too short for header: {} < {}",
                bytes.len(),
                HEADER_LEN
            );
        }
        Ok(Header {
            mac: LittleEndian::read_u32(&bytes[0..4]),
            rand: LittleEndian::read_u32(&bytes[4..8]),
            indexpts: LittleEndian::read_u32(&bytes[8..12]),
            cmd: LittleEndian::read_u32(&bytes[12..16]),
        })
    }

    /// Build the reply header: a byte-for-byte echo of the request header.
    ///
    /// The vendor SDK's `NetRxReturnHandle` enforces `rx.cmd == tx.cmd` AND
    /// `rx.indexpts == tx.indexpts` — i.e. the reply must echo every field
    /// unchanged. The official client further overwrites `ret = 0` after
    /// the checks, masking any mismatch from its own callers, but other
    /// host apps (including stricter community implementations) honour the
    /// check and refuse to connect when `indexpts` differs. Echoing the
    /// whole header is the only form that satisfies all known clients.
    pub fn reply(&self) -> [u8; HEADER_LEN] {
        let mut out = [0u8; HEADER_LEN];
        LittleEndian::write_u32(&mut out[0..4], self.mac);
        LittleEndian::write_u32(&mut out[4..8], self.rand);
        LittleEndian::write_u32(&mut out[8..12], self.indexpts);
        LittleEndian::write_u32(&mut out[12..16], self.cmd);
        out
    }
}

impl SoftMouse {
    /// Decode the post-header body of a mouse-shaped command. `body` is
    /// the datagram with the 16-byte header already stripped; it must be
    /// at least [`SOFT_MOUSE_LEN`] bytes.
    pub fn parse(body: &[u8]) -> Result<Self> {
        if body.len() < SOFT_MOUSE_LEN {
            bail!(
                "soft_mouse body too short: {} < {}",
                body.len(),
                SOFT_MOUSE_LEN
            );
        }
        let button = LittleEndian::read_i32(&body[0..4]);
        let x = LittleEndian::read_i32(&body[4..8]);
        let y = LittleEndian::read_i32(&body[8..12]);
        let wheel = LittleEndian::read_i32(&body[12..16]);
        let mut point = [0i32; 10];
        for (i, p) in point.iter_mut().enumerate() {
            let off = 16 + i * 4;
            *p = LittleEndian::read_i32(&body[off..off + 4]);
        }
        Ok(SoftMouse {
            button,
            x,
            y,
            wheel,
            point,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kmbox_net::schema::{CMD_CONNECT, CMD_MOUSE_MOVE};

    #[test]
    fn parses_header_le() {
        // mac=0x01FBC068 rand=0xDEADBEEF indexpts=0x00000007 cmd=CMD_MOUSE_MOVE
        let mut buf = [0u8; 16];
        LittleEndian::write_u32(&mut buf[0..4], 0x01FBC068);
        LittleEndian::write_u32(&mut buf[4..8], 0xDEADBEEF);
        LittleEndian::write_u32(&mut buf[8..12], 0x00000007);
        LittleEndian::write_u32(&mut buf[12..16], CMD_MOUSE_MOVE);

        let h = Header::parse(&buf).unwrap();
        assert_eq!(h.mac, 0x01FBC068);
        assert_eq!(h.rand, 0xDEADBEEF);
        assert_eq!(h.indexpts, 7);
        assert_eq!(h.cmd, CMD_MOUSE_MOVE);
    }

    #[test]
    fn header_reply_is_byte_for_byte_echo() {
        // The vendor SDK's NetRxReturnHandle rejects the reply unless
        // `rx.indexpts == tx.indexpts` AND `rx.cmd == tx.cmd`. The safest
        // — and only universally-accepted — reply is a verbatim echo of
        // every field in the header.
        let h = Header {
            mac: 0x01FBC068,
            rand: 0xAABBCCDD,
            indexpts: 42,
            cmd: CMD_CONNECT,
        };
        let r = h.reply();
        assert_eq!(LittleEndian::read_u32(&r[0..4]), 0x01FBC068);
        assert_eq!(LittleEndian::read_u32(&r[4..8]), 0xAABBCCDD);
        assert_eq!(LittleEndian::read_u32(&r[8..12]), 42);
        assert_eq!(LittleEndian::read_u32(&r[12..16]), CMD_CONNECT);
    }

    #[test]
    fn parses_mouse_move_body() {
        // button=0, x=10, y=-3, wheel=0, point all zero
        let mut body = [0u8; SOFT_MOUSE_LEN];
        LittleEndian::write_i32(&mut body[0..4], 0);
        LittleEndian::write_i32(&mut body[4..8], 10);
        LittleEndian::write_i32(&mut body[8..12], -3);
        LittleEndian::write_i32(&mut body[12..16], 0);
        let m = SoftMouse::parse(&body).unwrap();
        assert_eq!(m.button, 0);
        assert_eq!(m.x, 10);
        assert_eq!(m.y, -3);
        assert_eq!(m.wheel, 0);
        assert_eq!(m.point, [0; 10]);
    }

    #[test]
    fn parses_cmd_monitor_target_port_from_rand() {
        // The vendor SDK encodes the requested echo port in the low 16
        // bits of `head.rand` with the magic 0xAA55 in the upper 16 bits.
        // (kmboxNet.cpp:1583: `tx.head.rand = port | 0xaa55 << 16;`)
        let mut buf = [0u8; HEADER_LEN];
        LittleEndian::write_u32(&mut buf[0..4], 0x01FBC068);
        // port = 0x1234, magic in upper half
        LittleEndian::write_u32(&mut buf[4..8], 0x1234 | (MONITOR_RAND_MAGIC as u32) << 16);
        LittleEndian::write_u32(&mut buf[8..12], 42);
        LittleEndian::write_u32(&mut buf[12..16], CMD_MONITOR);

        let h = Header::parse(&buf).unwrap();
        assert_eq!(h.cmd, CMD_MONITOR);
        let req = MonitorRequest::from_header(&h);
        assert_eq!(req.target_port, 0x1234);
        assert_eq!(req.mode_flags, MONITOR_RAND_MAGIC as u16);
    }

    #[test]
    fn parses_cmd_monitor_unsubscribe_when_port_is_zero() {
        // `kmNet_monitor(0)` zeroes head.rand entirely (kmboxNet.cpp:1585);
        // our decoder must surface `target_port == 0` so the subscriber
        // knows this is an unsubscribe rather than "subscribe to port 0".
        let mut buf = [0u8; HEADER_LEN];
        LittleEndian::write_u32(&mut buf[4..8], 0);
        LittleEndian::write_u32(&mut buf[12..16], CMD_MONITOR);
        let h = Header::parse(&buf).unwrap();
        let req = MonitorRequest::from_header(&h);
        assert_eq!(req.target_port, 0);
        assert_eq!(req.mode_flags, 0);
    }

    #[test]
    fn parses_automove_with_duration_and_points() {
        let mut body = [0u8; SOFT_MOUSE_LEN];
        LittleEndian::write_i32(&mut body[4..8], 300);
        LittleEndian::write_i32(&mut body[8..12], -50);
        LittleEndian::write_i32(&mut body[16..20], 120);
        LittleEndian::write_i32(&mut body[20..24], 10);
        LittleEndian::write_i32(&mut body[24..28], 20);
        LittleEndian::write_i32(&mut body[28..32], 30);
        LittleEndian::write_i32(&mut body[32..36], 40);
        let m = SoftMouse::parse(&body).unwrap();
        assert_eq!(m.x, 300);
        assert_eq!(m.y, -50);
        assert_eq!(m.point[0], 120);
        assert_eq!(m.point[1], 10);
        assert_eq!(m.point[2], 20);
        assert_eq!(m.point[3], 30);
        assert_eq!(m.point[4], 40);
    }
}
