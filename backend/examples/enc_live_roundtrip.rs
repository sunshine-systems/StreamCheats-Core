//! Phase 3 live encryption round-trip driver.
//!
//! The vendor's Python demo `tests/vendor-demos/python_demo/mouse_enc.py`
//! cannot be exercised directly here because `kmNet.pyd` (the closed
//! CPython extension that wraps the SDK) isn't shipped on this machine.
//! As permitted by the task spec's fallback ("construct encrypted
//! packets in Rust using your ported `encrypt()` and send them at the
//! translator via a UDP socket"), this binary mirrors every `enc_*`
//! call from `mouse_enc.py` using the in-process port of `my_encrypt`.
//!
//! It sends five encrypted packets, captures the translator's reply
//! for each, and prints whether the reply header echoes the original
//! pre-encryption header exactly. The translator's own `IN (KMBOX
//! NET):` log lines (in `%LOCALAPPDATA%/StreamCheats Core/logs/`)
//! carry the decoded button / move / wheel values — operator should
//! `grep "IN (KMBOX NET):" $LOCALAPPDATA/StreamCheats Core/logs/kmbox.*.log`
//! to confirm the translator decoded each call correctly.
//!
//! Run while a translator daemon is listening on the configured port:
//!     cargo run --release --example enc_live_roundtrip -- 127.0.0.1 18888

use std::env;
use std::net::UdpSocket;
use std::time::Duration;

use byteorder::{ByteOrder, LittleEndian};
use streamcheats_core::kmbox_net::encryption::{encrypt, key_from_mac, ENC_PACKET_LEN};
use streamcheats_core::kmbox_net::{
    CMD_MOUSE_LEFT, CMD_MOUSE_MIDDLE, CMD_MOUSE_MOVE, CMD_MOUSE_RIGHT, CMD_MOUSE_WHEEL,
    HEADER_LEN,
};

const MAC: u32 = 0x01FBC068; // must match config.json's device_mac

/// One encrypted send + reply check.
struct EncCall {
    /// Human-readable label printed in the report.
    label: &'static str,
    /// CMD_* opcode the vendor SDK would use for this call.
    cmd: u32,
    /// Body fields (button, x, y, wheel) — soft_mouse_t headline ints.
    button: i32,
    x: i32,
    y: i32,
    wheel: i32,
}

fn build_encrypted_packet(call: &EncCall, indexpts: u32) -> [u8; ENC_PACKET_LEN] {
    let mut plain = [0u8; ENC_PACKET_LEN];
    LittleEndian::write_u32(&mut plain[0..4], MAC);
    LittleEndian::write_u32(&mut plain[4..8], 0xDEAD_0000 | indexpts);
    LittleEndian::write_u32(&mut plain[8..12], indexpts);
    LittleEndian::write_u32(&mut plain[12..16], call.cmd);
    LittleEndian::write_i32(&mut plain[16..20], call.button);
    LittleEndian::write_i32(&mut plain[20..24], call.x);
    LittleEndian::write_i32(&mut plain[24..28], call.y);
    LittleEndian::write_i32(&mut plain[28..32], call.wheel);

    let key = key_from_mac(MAC);
    encrypt(&mut plain, &key);
    plain
}

fn header_matches(plain_header: &[u8], reply: &[u8]) -> bool {
    reply.len() >= HEADER_LEN && &reply[..HEADER_LEN] == &plain_header[..HEADER_LEN]
}

fn plain_header_for(call: &EncCall, indexpts: u32) -> [u8; HEADER_LEN] {
    let mut h = [0u8; HEADER_LEN];
    LittleEndian::write_u32(&mut h[0..4], MAC);
    LittleEndian::write_u32(&mut h[4..8], 0xDEAD_0000 | indexpts);
    LittleEndian::write_u32(&mut h[8..12], indexpts);
    LittleEndian::write_u32(&mut h[12..16], call.cmd);
    h
}

fn main() -> std::io::Result<()> {
    let args: Vec<String> = env::args().collect();
    let host = args.get(1).cloned().unwrap_or_else(|| "127.0.0.1".into());
    let port: u16 = args
        .get(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(18888);
    let target = format!("{}:{}", host, port);

    let sock = UdpSocket::bind("127.0.0.1:0")?;
    sock.set_read_timeout(Some(Duration::from_millis(500)))?;
    sock.connect(&target)?;

    // The five enc_* calls the vendor python demo issues in the order
    // they appear in mouse_enc.py:
    //   enc_left(1)     enc_right(1)     enc_middle(1)
    //   enc_move(10,10) enc_wheel(10)
    // The button mask for the button calls mirrors the SDK's RMW
    // behaviour: each kmNet_enc_mouse_<btn> ORs its bit into the
    // persistent global before sending.
    let calls = [
        EncCall { label: "enc_left(1)",     cmd: CMD_MOUSE_LEFT,   button: 0x01, x: 0,  y: 0,  wheel: 0 },
        EncCall { label: "enc_right(1)",    cmd: CMD_MOUSE_RIGHT,  button: 0x03, x: 0,  y: 0,  wheel: 0 },
        EncCall { label: "enc_middle(1)",   cmd: CMD_MOUSE_MIDDLE, button: 0x07, x: 0,  y: 0,  wheel: 0 },
        EncCall { label: "enc_move(10,10)", cmd: CMD_MOUSE_MOVE,   button: 0x07, x: 10, y: 10, wheel: 0 },
        EncCall { label: "enc_wheel(10)",   cmd: CMD_MOUSE_WHEEL,  button: 0x07, x: 0,  y: 0,  wheel: 10 },
    ];

    let mut pass = 0usize;
    let mut fail = 0usize;
    for (i, call) in calls.iter().enumerate() {
        let idx = (i + 1) as u32;
        let cipher = build_encrypted_packet(call, idx);
        let plain_hdr = plain_header_for(call, idx);

        sock.send(&cipher)?;
        let mut buf = [0u8; 64];
        match sock.recv(&mut buf) {
            Ok(n) => {
                if header_matches(&plain_hdr, &buf[..n]) {
                    println!(
                        "[PASS] {}: reply echoes pre-encryption header ({} bytes)",
                        call.label, n
                    );
                    pass += 1;
                } else {
                    println!(
                        "[FAIL] {}: reply mismatch (got {} bytes)\n  plain hdr = {:02X?}\n  reply     = {:02X?}",
                        call.label,
                        n,
                        &plain_hdr[..],
                        &buf[..n.min(HEADER_LEN)]
                    );
                    fail += 1;
                }
            }
            Err(e) => {
                println!("[FAIL] {}: no reply within 500ms ({})", call.label, e);
                fail += 1;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    println!();
    println!("Live round-trip summary: {} pass, {} fail", pass, fail);
    println!("Inspect the translator's log file for the decoded values:");
    println!(
        "  grep \"IN (KMBOX NET):\" \"%LOCALAPPDATA%/StreamCheats Core/logs/kmbox.*.log\""
    );
    if fail > 0 {
        std::process::exit(1);
    }
    Ok(())
}
