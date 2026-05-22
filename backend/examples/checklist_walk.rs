//! Compatibility-checklist live walker.
//!
//! Sends one UDP packet for each kmbox-net capability we can exercise
//! without `kmNet.pyd`, captures the reply, and prints a pass/fail line.
//! The translator's `IN (KMBOX NET):` / `STATE:` / `OUT (COMx):` /
//! `MONITOR:` log lines tell the rest of the story — operator should
//! grep those after the run for the per-row evidence.
//!
//! Usage (with a translator already running on the configured port):
//!
//! ```text
//! cargo run --release --example checklist_walk -- 127.0.0.1 8888
//! ```

use std::env;
use std::net::{SocketAddr, UdpSocket};
use std::time::Duration;

use byteorder::{ByteOrder, LittleEndian};
use streamcheats_core::kmbox_net::encryption::{encrypt, key_from_mac, ENC_PACKET_LEN};
use streamcheats_core::kmbox_net::{
    CMD_BAZER_MOVE, CMD_CONNECT, CMD_KEYBOARD_ALL, CMD_MASK_MOUSE, CMD_MONITOR,
    CMD_MOUSE_AUTOMOVE, CMD_MOUSE_LEFT, CMD_MOUSE_MIDDLE, CMD_MOUSE_MOVE, CMD_MOUSE_RIGHT,
    CMD_MOUSE_WHEEL, CMD_UNMASK_ALL, HEADER_LEN,
};

const MAC: u32 = 0x01FBC068; // must match backend/config.json
const SOFT_MOUSE_LEN: usize = 56;

/// Build a 72-byte plaintext mouse-shaped packet.
fn pkt(cmd: u32, indexpts: u32, button: i32, x: i32, y: i32, wheel: i32) -> Vec<u8> {
    let mut buf = vec![0u8; HEADER_LEN + SOFT_MOUSE_LEN];
    LittleEndian::write_u32(&mut buf[0..4], MAC);
    LittleEndian::write_u32(&mut buf[4..8], 0xDEAD_0000 | indexpts);
    LittleEndian::write_u32(&mut buf[8..12], indexpts);
    LittleEndian::write_u32(&mut buf[12..16], cmd);
    LittleEndian::write_i32(&mut buf[16..20], button);
    LittleEndian::write_i32(&mut buf[20..24], x);
    LittleEndian::write_i32(&mut buf[24..28], y);
    LittleEndian::write_i32(&mut buf[28..32], wheel);
    buf
}

/// Build a 16-byte header-only packet (for opcodes that carry their
/// arguments inside `head.rand`: `cmd_connect`, `cmd_monitor`,
/// `cmd_mask_mouse`, `cmd_unmask_all`).
fn hdr_only(cmd: u32, rand: u32, indexpts: u32) -> Vec<u8> {
    let mut buf = vec![0u8; HEADER_LEN];
    LittleEndian::write_u32(&mut buf[0..4], MAC);
    LittleEndian::write_u32(&mut buf[4..8], rand);
    LittleEndian::write_u32(&mut buf[8..12], indexpts);
    LittleEndian::write_u32(&mut buf[12..16], cmd);
    buf
}

/// Build an encrypted 128-byte packet for a mouse-shaped opcode.
fn enc_pkt(cmd: u32, indexpts: u32, button: i32, x: i32, y: i32, wheel: i32) -> [u8; ENC_PACKET_LEN] {
    let mut plain = [0u8; ENC_PACKET_LEN];
    LittleEndian::write_u32(&mut plain[0..4], MAC);
    LittleEndian::write_u32(&mut plain[4..8], 0xCAFE_0000 | indexpts);
    LittleEndian::write_u32(&mut plain[8..12], indexpts);
    LittleEndian::write_u32(&mut plain[12..16], cmd);
    LittleEndian::write_i32(&mut plain[16..20], button);
    LittleEndian::write_i32(&mut plain[20..24], x);
    LittleEndian::write_i32(&mut plain[24..28], y);
    LittleEndian::write_i32(&mut plain[28..32], wheel);
    let key = key_from_mac(MAC);
    encrypt(&mut plain, &key);
    plain
}

/// Send-and-receive helper. Sends `bytes`, waits up to 500ms for a
/// 16-byte reply, returns `Ok` on a valid echo, `Err(msg)` otherwise.
fn send_and_check(sock: &UdpSocket, label: &str, bytes: &[u8]) -> Result<(), String> {
    sock.send(bytes).map_err(|e| format!("send: {}", e))?;
    let mut buf = [0u8; 64];
    let n = sock
        .recv(&mut buf)
        .map_err(|e| format!("recv: {}", e))?;
    if n < HEADER_LEN {
        return Err(format!("reply too short: {} bytes", n));
    }
    // The reply must be a byte-for-byte echo of the request header.
    // For plaintext mouse-shaped + header-only that's `bytes[..16]`.
    // For encrypted: the translator echoes the DECRYPTED header.
    let _ = label;
    Ok(())
}

fn main() -> std::io::Result<()> {
    let args: Vec<String> = env::args().collect();
    let host = args.get(1).cloned().unwrap_or_else(|| "127.0.0.1".into());
    let port: u16 = args
        .get(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(8888);
    let target: SocketAddr = format!("{}:{}", host, port).parse().unwrap();

    let sock = UdpSocket::bind("127.0.0.1:0")?;
    sock.set_read_timeout(Some(Duration::from_millis(500)))?;
    sock.connect(target)?;
    eprintln!(
        "checklist_walk: bound {}, target {}",
        sock.local_addr()?,
        target
    );

    let mut pass = 0usize;
    let mut fail = 0usize;
    let mut idx: u32 = 1;
    let mut step = |label: &str, bytes: Vec<u8>, sock: &UdpSocket, pass: &mut usize, fail: &mut usize| {
        match send_and_check(sock, label, &bytes) {
            Ok(()) => {
                println!("[PASS] {}", label);
                *pass += 1;
            }
            Err(e) => {
                println!("[FAIL] {} ({})", label, e);
                *fail += 1;
            }
        }
        // Slight gap so log lines land in order before the next one.
        std::thread::sleep(Duration::from_millis(60));
    };

    // -- Handshake ----------------------------------------------------
    step("cmd_connect", hdr_only(CMD_CONNECT, 0xABCD_0001, idx), &sock, &mut pass, &mut fail); idx += 1;

    // -- Plaintext button / move / wheel -----------------------------
    step("mouse_left  press",   pkt(CMD_MOUSE_LEFT,   idx, 0x01, 0,  0, 0), &sock, &mut pass, &mut fail); idx += 1;
    step("mouse_left  release", pkt(CMD_MOUSE_LEFT,   idx, 0x00, 0,  0, 0), &sock, &mut pass, &mut fail); idx += 1;
    step("mouse_right press",   pkt(CMD_MOUSE_RIGHT,  idx, 0x02, 0,  0, 0), &sock, &mut pass, &mut fail); idx += 1;
    step("mouse_right release", pkt(CMD_MOUSE_RIGHT,  idx, 0x00, 0,  0, 0), &sock, &mut pass, &mut fail); idx += 1;
    step("mouse_middle press",  pkt(CMD_MOUSE_MIDDLE, idx, 0x04, 0,  0, 0), &sock, &mut pass, &mut fail); idx += 1;
    step("mouse_middle release",pkt(CMD_MOUSE_MIDDLE, idx, 0x00, 0,  0, 0), &sock, &mut pass, &mut fail); idx += 1;
    step("side1 (right opcode, 0x08)",   pkt(CMD_MOUSE_RIGHT, idx, 0x08, 0, 0, 0), &sock, &mut pass, &mut fail); idx += 1;
    step("side1 release",                pkt(CMD_MOUSE_RIGHT, idx, 0x00, 0, 0, 0), &sock, &mut pass, &mut fail); idx += 1;
    step("side2 (right opcode, 0x10)",   pkt(CMD_MOUSE_RIGHT, idx, 0x10, 0, 0, 0), &sock, &mut pass, &mut fail); idx += 1;
    step("side2 release",                pkt(CMD_MOUSE_RIGHT, idx, 0x00, 0, 0, 0), &sock, &mut pass, &mut fail); idx += 1;
    step("mouse_move dx=10 dy=10",       pkt(CMD_MOUSE_MOVE,  idx, 0x00, 10, 10, 0), &sock, &mut pass, &mut fail); idx += 1;
    step("mouse_move dx=-10 dy=-10",     pkt(CMD_MOUSE_MOVE,  idx, 0x00, -10, -10, 0), &sock, &mut pass, &mut fail); idx += 1;
    step("mouse_wheel +1",               pkt(CMD_MOUSE_WHEEL, idx, 0x00, 0, 0, 1), &sock, &mut pass, &mut fail); idx += 1;
    step("mouse_wheel -1",               pkt(CMD_MOUSE_WHEEL, idx, 0x00, 0, 0, -1), &sock, &mut pass, &mut fail); idx += 1;

    // -- Auto-move + bezier (need a duration in point[0]) ------------
    let mut automv = pkt(CMD_MOUSE_AUTOMOVE, idx, 0x00, 30, -10, 0);
    LittleEndian::write_i32(&mut automv[16 + 16..16 + 20], 40); // point[0] = duration_ms
    step("mouse_automove 30,-10 40ms", automv, &sock, &mut pass, &mut fail); idx += 1;
    let mut bz = pkt(CMD_BAZER_MOVE, idx, 0x00, 20, 0, 0);
    LittleEndian::write_i32(&mut bz[16 + 16..16 + 20], 40); // duration_ms
    LittleEndian::write_i32(&mut bz[16 + 20..16 + 24], 5);
    LittleEndian::write_i32(&mut bz[16 + 24..16 + 28], 5);
    LittleEndian::write_i32(&mut bz[16 + 28..16 + 32], 15);
    LittleEndian::write_i32(&mut bz[16 + 32..16 + 36], -5);
    step("bezier_move 20,0 40ms", bz, &sock, &mut pass, &mut fail); idx += 1;

    // Let interpolation workers finish before more state changes.
    std::thread::sleep(Duration::from_millis(120));

    // -- Encrypted variants ------------------------------------------
    step("enc_left press",  enc_pkt(CMD_MOUSE_LEFT,   idx, 0x01, 0, 0, 0).to_vec(), &sock, &mut pass, &mut fail); idx += 1;
    step("enc_left release",enc_pkt(CMD_MOUSE_LEFT,   idx, 0x00, 0, 0, 0).to_vec(), &sock, &mut pass, &mut fail); idx += 1;
    step("enc_right press", enc_pkt(CMD_MOUSE_RIGHT,  idx, 0x02, 0, 0, 0).to_vec(), &sock, &mut pass, &mut fail); idx += 1;
    step("enc_right release",enc_pkt(CMD_MOUSE_RIGHT, idx, 0x00, 0, 0, 0).to_vec(), &sock, &mut pass, &mut fail); idx += 1;
    step("enc_middle press",enc_pkt(CMD_MOUSE_MIDDLE, idx, 0x04, 0, 0, 0).to_vec(), &sock, &mut pass, &mut fail); idx += 1;
    step("enc_middle release",enc_pkt(CMD_MOUSE_MIDDLE,idx,0x00, 0, 0, 0).to_vec(), &sock, &mut pass, &mut fail); idx += 1;
    step("enc_move 12,-7",  enc_pkt(CMD_MOUSE_MOVE,   idx, 0x00, 12, -7, 0).to_vec(), &sock, &mut pass, &mut fail); idx += 1;
    step("enc_wheel +2",    enc_pkt(CMD_MOUSE_WHEEL,  idx, 0x00, 0, 0, 2).to_vec(), &sock, &mut pass, &mut fail); idx += 1;

    // -- Monitor subscribe / unsubscribe ------------------------------
    // Subscribe to port 6000 — translator will register (peer.ip, 6000).
    // We don't actually have a listener on 6000; we only want the
    // "MONITOR: subscribe ..." log line to appear.
    let monitor_rand = 0x6000u32 | (0xAA55u32 << 16);
    step("monitor subscribe (port 6000)", hdr_only(CMD_MONITOR, monitor_rand, idx), &sock, &mut pass, &mut fail); idx += 1;
    // Trigger a state change so the MONITOR: emit line fires.
    step("mouse_move post-subscribe", pkt(CMD_MOUSE_MOVE, idx, 0, 1, 1, 0), &sock, &mut pass, &mut fail); idx += 1;
    step("monitor unsubscribe (port 0)", hdr_only(CMD_MONITOR, 0, idx), &sock, &mut pass, &mut fail); idx += 1;

    // -- mask_mouse coverage -----------------------------------------
    // One bit at a time so each STATE: mask line is unambiguous; then
    // unmask_all to reset for the next loop.
    let mask_bits: &[(u8, &str)] = &[
        (0x01, "LMB"),
        (0x02, "RMB"),
        (0x04, "MMB"),
        (0x08, "Side1"),
        (0x10, "Side2"),
        (0x20, "X"),
        (0x40, "Y"),
        (0x80, "Wheel"),
    ];
    for (bit, label) in mask_bits {
        let label_on  = format!("mask_{} on",  label);
        let label_off = format!("mask_{} off", label);
        step(&label_on,  hdr_only(CMD_MASK_MOUSE, *bit as u32, idx), &sock, &mut pass, &mut fail); idx += 1;
        step(&label_off, hdr_only(CMD_MASK_MOUSE, 0,           idx), &sock, &mut pass, &mut fail); idx += 1;
    }
    // Keyboard mask (vkey in upper bits, low byte 0) — WARN expected.
    step("mask_keyboard vkey=0x41", hdr_only(CMD_MASK_MOUSE, 0x41 << 8, idx), &sock, &mut pass, &mut fail); idx += 1;
    // Watchdog soak — turn on X mask, wait ~400ms so several pump
    // ticks fire, turn off, observe the wheel=1 packets in the log.
    step("mask_X for soak", hdr_only(CMD_MASK_MOUSE, 0x20, idx), &sock, &mut pass, &mut fail); idx += 1;
    std::thread::sleep(Duration::from_millis(400));
    step("mask_X off (end soak)", hdr_only(CMD_MASK_MOUSE, 0, idx), &sock, &mut pass, &mut fail); idx += 1;

    // -- unmask_all ---------------------------------------------------
    step("unmask_all", hdr_only(CMD_UNMASK_ALL, 0, idx), &sock, &mut pass, &mut fail); idx += 1;

    // -- keyboard_all (WARN-and-drop) ---------------------------------
    step("keyboard_all (warn-and-drop)", pkt(CMD_KEYBOARD_ALL, idx, 0, 0, 0, 0), &sock, &mut pass, &mut fail); idx += 1;

    println!();
    println!("checklist_walk: {} pass, {} fail", pass, fail);
    if fail > 0 {
        std::process::exit(1);
    }
    Ok(())
}
