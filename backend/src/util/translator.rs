//! Thin command-dispatch bridge between incoming KMBox Net UDP packets
//! and the [`DeviceController`] that owns the device state and serial
//! channel. The translator holds NO device state itself — every button
//! / move / wheel mutation is delegated to the controller, which then
//! handles the serial send and publishes a `StateChange` event for any
//! downstream subscribers (e.g. the `kmbox_net::monitor` emitter).
//!
//! Spawns short-lived worker threads for `automove` (linear) and
//! `bezier_move` (cubic) interpolation. Workers re-read the current
//! button mask from the controller on every tick via
//! [`DeviceController::current_buttons`] so they always emit deltas
//! against the most recently-asserted host state.

use std::net::SocketAddr;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tracing::{debug, info, warn};

use crate::kmbox_net::encryption::{
    decrypt as decrypt_packet, is_encrypted_length, key_from_mac, ENC_PACKET_LEN,
};
use crate::kmbox_net::monitor::peer_registry::{PeerRegistry, RegisterOutcome};
use crate::kmbox_net::{
    cmd_name, Header, MonitorRequest, SoftMouse, CMD_BAZER_MOVE, CMD_CONNECT, CMD_DEBUG,
    CMD_KEYBOARD_ALL, CMD_MASK_MOUSE, CMD_MONITOR, CMD_MOUSE_AUTOMOVE, CMD_MOUSE_LEFT,
    CMD_MOUSE_MIDDLE, CMD_MOUSE_MOVE, CMD_MOUSE_RIGHT, CMD_MOUSE_WHEEL, CMD_REBOOT, CMD_SETCONFIG,
    CMD_SETVIDPID, CMD_SHOWPIC, CMD_TRACE_ENABLE, CMD_UNMASK_ALL, HEADER_LEN,
};
use crate::streamcheats::{DeviceController, MaskController, PACKET_LEN};

/// One outgoing Streamcheats packet bound for the serial worker.
pub type SerialPacket = [u8; PACKET_LEN];

/// What the translator hands to the serial writer thread: the packet plus
/// the `Instant` at which we want latency to be measured against. For
/// directly-translated commands (mouse_move, button toggles, wheel) the
/// origin is `Instant::now()` at the start of `handle_packet`, i.e. very
/// close to when the UDP datagram arrived — `latency` then approximates
/// end-to-end host-app → wire delay. For interpolation worker packets
/// the origin is `Instant::now()` at the worker's send moment so the
/// latency reflects channel + write cost only, not the intentional
/// `duration_ms` the host asked for.
pub type SerialEnvelope = (Instant, SerialPacket);

/// Wall-clock step interval (milliseconds) used by the interpolation
/// workers. Each tick emits one delta packet. 4 ms ≈ 250 Hz, which keeps
/// motion smooth without saturating the serial pipe.
const STEP_MS: u64 = 4;

/// Shared, swappable handle to the serial writer's mpsc sender. `None`
/// means "no device currently attached" — every sender that touches it
/// (the [`DeviceController`], the heartbeat) treats that case as a
/// silent no-op so the UDP side keeps replying without forwarding stale
/// traffic to a defunct port.
pub type SerialTxHolder = Arc<Mutex<Option<Sender<SerialEnvelope>>>>;

/// Per-process command-dispatch bridge. Parses incoming KMBox Net UDP
/// datagrams, validates MAC, and forwards each command to the shared
/// [`DeviceController`]. Holds NO device state — the controller is the
/// single source of truth for button mask, move/wheel deltas, and
/// serial emission.
///
/// The translator's `IN (KMBOX NET):` log lines remain its
/// responsibility — they're the authoritative record of inbound UDP
/// traffic. State-side logging (`STATE:`) and outbound serial logging
/// (`OUT (COMx):`) belong to the controller and the writer thread
/// respectively. Monitor-mode logging (`MONITOR:`) is split — subscribe
/// lines come from the translator's `cmd_monitor` arm, emit/unsubscribe
/// lines come from the monitor subscriber thread.
pub struct Translator {
    expected_mac: u32,
    enable_timing: bool,
    device: Arc<DeviceController>,
    /// Shared monitor-peer table written from the `cmd_monitor` arm of
    /// [`Translator::dispatch`] and read from the dedicated
    /// `monitor_emitter` thread (see [`crate::kmbox_net::monitor`]).
    /// Always populated — when there is no monitor subscriber thread
    /// (e.g. in unit tests), the registry still functions as a no-op
    /// data sink (peers register but nothing reads them, so cmd_monitor
    /// stays inert).
    monitor_registry: PeerRegistry,
    /// `cmd_mask_mouse` / `cmd_unmask_all` handler. Owns the cumulative
    /// mask shadow + the axis-mask watchdog. Arc so the translator can
    /// be cheaply cloned in tests.
    mask: Arc<MaskController>,
}

impl Translator {
    /// Build a new translator.
    ///
    /// * `expected_mac` — the 4-byte device identifier read from
    ///   `config.json`. Packets whose [`Header::mac`](crate::kmbox_net::Header::mac)
    ///   does not equal this value are silently dropped.
    /// * `enable_timing` — when `true`, each `IN (KMBOX NET): cmd=...`
    ///   line gets a `parse=Nµs` suffix showing how long the
    ///   header-parse → dispatch → channel-send leg took.
    /// * `device` — the shared controller that owns device state and
    ///   the swappable serial channel. The translator never touches the
    ///   underlying [`SerialTxHolder`] directly; the controller's
    ///   `apply_*` methods are the only path that emits serial packets.
    /// * `monitor_registry` — shared peer table for `cmd_monitor`
    ///   subscriptions. The monitor subscriber thread (spawned in
    ///   `main.rs::run`) reads from the same handle.
    pub fn new(
        expected_mac: u32,
        enable_timing: bool,
        device: Arc<DeviceController>,
        monitor_registry: PeerRegistry,
        mask: Arc<MaskController>,
    ) -> Self {
        Self {
            expected_mac,
            enable_timing,
            device,
            monitor_registry,
            mask,
        }
    }

    /// Returns ` parse=Nµs` (with a leading space) when timing logs are
    /// enabled, or an empty string when they're off. Used as a suffix on
    /// every `IN (KMBOX NET):` log line.
    fn parse_suffix(&self, recv_at: Instant) -> String {
        if self.enable_timing {
            format!(" parse={}µs", recv_at.elapsed().as_micros())
        } else {
            String::new()
        }
    }

    /// Process one incoming UDP datagram end-to-end.
    ///
    /// Returns the 16-byte reply the caller should send back to the peer,
    /// or `None` when the packet was silently dropped (wrong MAC, too
    /// short to parse). Side effects — delegating state mutations to
    /// the [`DeviceController`], spawning interpolation worker threads,
    /// (un)registering monitor peers — happen before the reply is built.
    ///
    /// `peer` is the UDP source address of the datagram. It's needed
    /// for `cmd_monitor`: the SDK puts the peer's *listening* port in
    /// `head.rand`, but the destination IP is implicit — it's wherever
    /// the request came from. The translator uses `peer.ip()` to build
    /// the monitor target address `(peer.ip(), target_port)`.
    pub fn handle_packet(&self, datagram: &[u8], peer: SocketAddr) -> Option<[u8; HEADER_LEN]> {
        // Capture as close to recv_from as we reasonably can — the only
        // intermediate work is the call indirection. This timestamp
        // propagates into the channel envelope so the writer thread can
        // compute end-to-end latency for the OUT log line.
        let recv_at = Instant::now();

        // Encrypted variants of every mouse / keyboard opcode arrive as
        // exactly 128 bytes (vendor SDK pads the encrypted buffer to
        // the block size and always passes `128` to `sendto` —
        // kmboxNet.cpp lines 198, 251, 300, 348, 400, 451, 496, 553,
        // 615, 687, 803, 901, 963). Plaintext datagrams are 16 bytes
        // (header-only opcodes) or 72 bytes (mouse-shaped). Length is
        // therefore an unambiguous discriminator — see
        // `crate::kmbox_net::encryption` for the full rationale.
        let mut dec_buf;
        let working: &[u8] = if is_encrypted_length(datagram.len()) {
            // Decrypt with the configured MAC's key. Note: we cannot
            // skip the MAC check here even after a successful decrypt —
            // a wrong-MAC packet will decrypt to garbage and Header::parse
            // will still succeed (any 16 bytes are a valid Header), so
            // the downstream `header.mac != expected_mac` check below
            // is what actually rejects mis-keyed encrypted traffic.
            dec_buf = [0u8; ENC_PACKET_LEN];
            dec_buf.copy_from_slice(&datagram[..ENC_PACKET_LEN]);
            let key = key_from_mac(self.expected_mac);
            decrypt_packet(&mut dec_buf, &key);
            debug!("decrypted 128-byte encrypted packet from {}", peer);
            &dec_buf
        } else {
            datagram
        };

        let header = match Header::parse(working) {
            Ok(h) => h,
            Err(e) => {
                warn!("malformed UDP packet ({} bytes): {}", datagram.len(), e);
                return None;
            }
        };

        if header.mac != self.expected_mac {
            debug!(
                "dropping packet with wrong mac=0x{:08X} (expected 0x{:08X})",
                header.mac, self.expected_mac
            );
            return None;
        }

        let body = &working[HEADER_LEN..];
        self.dispatch(&header, body, recv_at, peer);
        Some(header.reply())
    }

    fn dispatch(&self, header: &Header, body: &[u8], recv_at: Instant, peer: SocketAddr) {
        match header.cmd {
            CMD_CONNECT => {
                info!(
                    "IN (KMBOX NET): cmd=connect (reset button mask){}",
                    self.parse_suffix(recv_at)
                );
                self.device.reset();
            }
            // All mouse-shaped opcodes share the same 56-byte `soft_mouse_t`
            // body. The vendor SDK keeps `softmouse` as a persistent global
            // and RMWs the full button mask into `softmouse.button` BEFORE
            // every send — including on opcodes where button state isn't
            // semantically the "point" of the call (move, wheel) and on
            // calls that piggy-back through `cmd_mouse_right` (side1/side2,
            // see `kmboxNet.cpp:370,421`). So we trust `payload.button` as
            // the source of truth for every mouse opcode rather than
            // maintaining a local bit-twiddled mirror — that makes us
            // robust to dropped packets and to host apps that bind hotkeys
            // we never explicitly handle.
            CMD_MOUSE_MOVE => {
                if let Some(m) = self.parse_mouse(body, header.cmd) {
                    let mask = (m.button & 0xFF) as u8;
                    info!(
                        "IN (KMBOX NET): cmd=mouse_move dx={} dy={} btn=0x{:02X}{}",
                        m.x, m.y, mask, self.parse_suffix(recv_at)
                    );
                    // Combined helper => one serial packet, matching the
                    // pre-refactor wire cadence (a naive apply_buttons +
                    // apply_move would emit two).
                    self.device
                        .apply_buttons_and_move(mask, clamp_i16(m.x), clamp_i16(m.y));
                }
            }
            CMD_MOUSE_LEFT => self.handle_button_cmd(body, header.cmd, "left", recv_at),
            CMD_MOUSE_RIGHT => self.handle_button_cmd(body, header.cmd, "right", recv_at),
            CMD_MOUSE_MIDDLE => self.handle_button_cmd(body, header.cmd, "middle", recv_at),
            CMD_MOUSE_WHEEL => {
                if let Some(m) = self.parse_mouse(body, header.cmd) {
                    let mask = (m.button & 0xFF) as u8;
                    info!(
                        "IN (KMBOX NET): cmd=mouse_wheel wheel={} btn=0x{:02X}{}",
                        m.wheel, mask, self.parse_suffix(recv_at)
                    );
                    self.device.apply_buttons_and_wheel(mask, clamp_i8(m.wheel));
                }
            }
            CMD_MOUSE_AUTOMOVE => {
                if let Some(m) = self.parse_mouse(body, header.cmd) {
                    let mask = (m.button & 0xFF) as u8;
                    let duration_ms = m.point[0].max(0) as u64;
                    info!(
                        "IN (KMBOX NET): cmd=mouse_automove x={} y={} ms={} btn=0x{:02X} (worker){}",
                        m.x, m.y, duration_ms, mask, self.parse_suffix(recv_at)
                    );
                    // Adopt the payload's mask WITHOUT emitting serial
                    // — the worker will do all the sending at its own
                    // 4 ms cadence using whatever mask is current at
                    // each tick. This matches the pre-refactor
                    // dispatch path, which set the mask via
                    // `update_mask_from_payload` and emitted no
                    // standalone packet on the automove arm itself.
                    self.device.set_button_mask_silent(mask);
                    self.spawn_automove(m.x, m.y, duration_ms);
                }
            }
            CMD_BAZER_MOVE => {
                if let Some(m) = self.parse_mouse(body, header.cmd) {
                    let mask = (m.button & 0xFF) as u8;
                    let duration_ms = m.point[0].max(0) as u64;
                    let x1 = m.point[1];
                    let y1 = m.point[2];
                    let x2 = m.point[3];
                    let y2 = m.point[4];
                    info!(
                        "IN (KMBOX NET): cmd=bezier_move x={} y={} ms={} ctl=({},{})({},{}) btn=0x{:02X} (worker){}",
                        m.x, m.y, duration_ms, x1, y1, x2, y2, mask, self.parse_suffix(recv_at)
                    );
                    // Same rationale as cmd_mouse_automove above.
                    self.device.set_button_mask_silent(mask);
                    self.spawn_bezier(m.x, m.y, duration_ms, x1, y1, x2, y2);
                }
            }
            CMD_KEYBOARD_ALL => {
                // Keyboard support is firmware-side work; recognized here so
                // we don't fall through to the generic unknown-command log.
                // See COMPATIBILITY_CHECKLIST.md. The body is dropped on the
                // floor: the translator carries no keyboard state and the
                // Teensy proxy does not forward keystrokes to the PC.
                warn!(
                    "IN (KMBOX NET): cmd=keyboard_all — NOT OPERATIONAL (firmware does not support keyboard pass-through; this command is dropped){}",
                    self.parse_suffix(recv_at)
                );
            }
            CMD_MONITOR => self.handle_cmd_monitor(header, peer, recv_at),
            CMD_MASK_MOUSE => {
                info!(
                    "IN (KMBOX NET): cmd=mask_mouse rand=0x{:08X}{}",
                    header.rand,
                    self.parse_suffix(recv_at)
                );
                self.mask.apply_mask_mouse(header.rand);
            }
            CMD_UNMASK_ALL => {
                info!(
                    "IN (KMBOX NET): cmd=unmask_all rand=0x{:08X}{}",
                    header.rand,
                    self.parse_suffix(recv_at)
                );
                self.mask.apply_unmask_all(header.rand);
            }
            CMD_REBOOT | CMD_SETCONFIG | CMD_SETVIDPID
            | CMD_DEBUG | CMD_SHOWPIC | CMD_TRACE_ENABLE => {
                info!("IN (KMBOX NET): cmd={} (ack only)", cmd_name(header.cmd));
            }
            other => {
                warn!(
                    "IN (KMBOX NET): cmd=unknown(0x{:08X}) (ack only, replying with echo)",
                    other
                );
            }
        }
    }

    /// Dispatch `cmd_monitor`. The vendor SDK encodes the target UDP
    /// port in `head.rand` (low 16 bits) plus a fixed magic `0xAA55` in
    /// the upper 16 bits. `target_port == 0` is the SDK's idiomatic
    /// "stop monitoring" (`kmboxNet.cpp:1585`).
    ///
    /// Subscribe: register `(peer.ip(), target_port)` in the shared
    /// [`PeerRegistry`]. Log a single `MONITOR: subscribe ...` info
    /// line on *first* register; subsequent re-registers from the same
    /// peer (a host app that re-sends `cmd_monitor` as a keepalive)
    /// update the timestamp / mode flags silently to avoid log spam.
    ///
    /// Unsubscribe (`target_port == 0`): drop every entry that shares
    /// this peer's IP. Rationale: the host app's `kmNet_monitor(0)`
    /// doesn't tell us which port it was previously subscribed to —
    /// the vendor SDK clears its global `monitor_port` rather than
    /// echoing it back. Removing all entries for the source IP is the
    /// safe interpretation (typical case: one peer = one subscription).
    fn handle_cmd_monitor(&self, header: &Header, peer: SocketAddr, recv_at: Instant) {
        let req = MonitorRequest::from_header(header);
        if req.target_port == 0 {
            let mut removed = 0usize;
            for (addr, _) in self.monitor_registry.list_peers() {
                if addr.ip() == peer.ip()
                    && self.monitor_registry.unregister(addr.ip(), addr.port())
                {
                    removed += 1;
                }
            }
            if removed > 0 {
                info!(
                    "IN (KMBOX NET): cmd=monitor unsubscribe peer={} (removed {} entr{}){}",
                    peer.ip(),
                    removed,
                    if removed == 1 { "y" } else { "ies" },
                    self.parse_suffix(recv_at)
                );
                info!("MONITOR: unsubscribe peer {}", peer.ip());
            } else {
                debug!(
                    "IN (KMBOX NET): cmd=monitor unsubscribe peer={} (no prior registration){}",
                    peer.ip(),
                    self.parse_suffix(recv_at)
                );
            }
            return;
        }

        let outcome = self.monitor_registry.register(
            peer.ip(),
            req.target_port,
            req.mode_flags,
            recv_at,
        );
        info!(
            "IN (KMBOX NET): cmd=monitor subscribe peer={}:{} mode=0x{:04X}{}",
            peer.ip(),
            req.target_port,
            req.mode_flags,
            self.parse_suffix(recv_at)
        );
        // De-dupe: only emit the MONITOR: subscribe line on the FIRST
        // register from this (peer, port). Refresh is silent so a
        // keepalive-re-sending host app doesn't drown the log.
        if outcome == RegisterOutcome::Added {
            info!(
                "MONITOR: subscribe peer {}:{} mode=mouse (flags=0x{:04X})",
                peer.ip(),
                req.target_port,
                req.mode_flags
            );
        }
    }

    fn parse_mouse(&self, body: &[u8], cmd: u32) -> Option<SoftMouse> {
        match SoftMouse::parse(body) {
            Ok(m) => Some(m),
            Err(e) => {
                warn!("cmd={} body parse failed: {}", cmd_name(cmd), e);
                None
            }
        }
    }

    fn handle_button_cmd(&self, body: &[u8], cmd: u32, label: &str, recv_at: Instant) {
        let Some(m) = self.parse_mouse(body, cmd) else {
            return;
        };
        // Trust the payload's `button` field, not a local bit-twiddle:
        // the vendor SDK's `softmouse` global has already RMW'd the full
        // mask (including any side-button bits piggy-backing through
        // `cmd_mouse_right`) before sending.
        let mask = (m.button & 0xFF) as u8;
        info!(
            "IN (KMBOX NET): cmd=mouse_{} btn=0x{:02X}{}",
            label, mask, self.parse_suffix(recv_at)
        );
        self.device.apply_buttons(mask);
    }

    fn spawn_automove(&self, target_x: i32, target_y: i32, duration_ms: u64) {
        let device = self.device.clone();
        thread::spawn(move || {
            interp_linear(target_x, target_y, duration_ms, device);
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_bezier(
        &self,
        target_x: i32,
        target_y: i32,
        duration_ms: u64,
        x1: i32,
        y1: i32,
        x2: i32,
        y2: i32,
    ) {
        let device = self.device.clone();
        thread::spawn(move || {
            interp_bezier(target_x, target_y, duration_ms, x1, y1, x2, y2, device);
        });
    }
}

/// Clamp an `i32` to the `i16` range used by [`DeviceController::apply_move`].
/// Out-of-range values saturate to `i16::MAX` / `i16::MIN`; the serial
/// packet builder also performs the same clamp before writing the
/// extended bytes, so this just keeps the controller's API signature
/// honest at the boundary.
fn clamp_i16(v: i32) -> i16 {
    v.clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

/// Clamp an `i32` to the `i8` range used by [`DeviceController::apply_wheel`].
fn clamp_i8(v: i32) -> i8 {
    v.clamp(i8::MIN as i32, i8::MAX as i32) as i8
}

/// Linear interpolation worker: emits incremental moves so the cumulative
/// delta equals `(target_x, target_y)` over `duration_ms`, in [`STEP_MS`]
/// increments. A duration shorter than one step is rounded up to a
/// single-step move so a `automove(..., 0)` still moves the cursor.
///
/// Each tick re-reads the current button mask from the
/// [`DeviceController`] (via the cheap [`DeviceController::current_buttons`]
/// helper) so the emitted packets always carry whatever button state the
/// host most recently asserted — even if the host pressed/released a
/// button mid-interpolation.
fn interp_linear(target_x: i32, target_y: i32, duration_ms: u64, device: Arc<DeviceController>) {
    let dur_ms = duration_ms.max(STEP_MS);
    let steps = ((dur_ms + STEP_MS - 1) / STEP_MS).max(1) as i64;
    // Anchor every step's target time to the worker's start instant
    // rather than the previous step's wake time. That way an occasional
    // long sleep can't accumulate into drift across a long automove —
    // we just skip the sleep on a step we're already late for, and the
    // final emitted total still lands on the requested target.
    let start = Instant::now();
    let mut emitted_x: i64 = 0;
    let mut emitted_y: i64 = 0;
    let tx_i = target_x as i64;
    let ty_i = target_y as i64;

    for i in 1..=steps {
        let want_x = tx_i * i / steps;
        let want_y = ty_i * i / steps;
        let dx = (want_x - emitted_x) as i32;
        let dy = (want_y - emitted_y) as i32;
        emitted_x = want_x;
        emitted_y = want_y;

        // apply_move snapshots the controller's current button mask at
        // call-time and embeds it in the serial packet + the published
        // MoveEmitted event. We deliberately do NOT call apply_buttons
        // per tick — buttons follow whatever the host asserted via a
        // separate opcode, and a redundant apply_buttons would publish
        // spurious ButtonsChanged events.
        device.apply_move(clamp_i16(dx), clamp_i16(dy));

        let target_t = start + Duration::from_millis(STEP_MS * i as u64);
        if let Some(sleep_for) = target_t.checked_duration_since(Instant::now()) {
            thread::sleep(sleep_for);
        }
    }
}

/// Cubic bezier interpolation between (0,0) and (target) via control
/// points (x1,y1) and (x2,y2). Emits delta moves on `STEP_MS` cadence.
/// See [`interp_linear`] for the per-tick mask semantics — identical here.
#[allow(clippy::too_many_arguments)]
fn interp_bezier(
    target_x: i32,
    target_y: i32,
    duration_ms: u64,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    device: Arc<DeviceController>,
) {
    let dur_ms = duration_ms.max(STEP_MS);
    let steps = ((dur_ms + STEP_MS - 1) / STEP_MS).max(1) as u64;
    let start = Instant::now();
    let mut emitted_x: f64 = 0.0;
    let mut emitted_y: f64 = 0.0;

    let p0 = (0.0f64, 0.0f64);
    let p1 = (x1 as f64, y1 as f64);
    let p2 = (x2 as f64, y2 as f64);
    let p3 = (target_x as f64, target_y as f64);

    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        let u = 1.0 - t;
        let bx = u * u * u * p0.0
            + 3.0 * u * u * t * p1.0
            + 3.0 * u * t * t * p2.0
            + t * t * t * p3.0;
        let by = u * u * u * p0.1
            + 3.0 * u * u * t * p1.1
            + 3.0 * u * t * t * p2.1
            + t * t * t * p3.1;

        let dx = (bx - emitted_x).round() as i32;
        let dy = (by - emitted_y).round() as i32;
        emitted_x += dx as f64;
        emitted_y += dy as f64;

        device.apply_move(clamp_i16(dx), clamp_i16(dy));

        let target_t = start + Duration::from_millis(STEP_MS * i);
        if let Some(sleep_for) = target_t.checked_duration_since(Instant::now()) {
            thread::sleep(sleep_for);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use byteorder::{ByteOrder, LittleEndian};
    use std::net::{IpAddr, Ipv4Addr};
    use std::sync::mpsc;

    use crate::kmbox_net::schema::{HEADER_LEN, SOFT_MOUSE_LEN};
    use crate::streamcheats::state::EventBus;

    const MAC: u32 = 0x01FBC068;

    /// Build a 72-byte KMBox Net packet with the given opcode and a
    /// `soft_mouse_t` payload populated from `(button, x, y, wheel)`.
    fn pkt(cmd: u32, button: i32, x: i32, y: i32, wheel: i32) -> Vec<u8> {
        let mut buf = vec![0u8; HEADER_LEN + SOFT_MOUSE_LEN];
        LittleEndian::write_u32(&mut buf[0..4], MAC);
        LittleEndian::write_u32(&mut buf[4..8], 0xDEADBEEF);
        LittleEndian::write_u32(&mut buf[8..12], 1);
        LittleEndian::write_u32(&mut buf[12..16], cmd);
        LittleEndian::write_i32(&mut buf[16..20], button);
        LittleEndian::write_i32(&mut buf[20..24], x);
        LittleEndian::write_i32(&mut buf[24..28], y);
        LittleEndian::write_i32(&mut buf[28..32], wheel);
        buf
    }

    /// Build a `cmd_monitor` packet (16-byte header only — no body) with
    /// the requested target port in `head.rand`.
    fn monitor_pkt(target_port: u16) -> Vec<u8> {
        let mut buf = vec![0u8; HEADER_LEN];
        LittleEndian::write_u32(&mut buf[0..4], MAC);
        LittleEndian::write_u32(
            &mut buf[4..8],
            (target_port as u32) | (0xAA55u32 << 16),
        );
        LittleEndian::write_u32(&mut buf[8..12], 1);
        LittleEndian::write_u32(&mut buf[12..16], CMD_MONITOR);
        buf
    }

    fn make_translator() -> (Translator, mpsc::Receiver<SerialEnvelope>, PeerRegistry) {
        let (tx, rx) = mpsc::channel::<SerialEnvelope>();
        let holder: SerialTxHolder = Arc::new(Mutex::new(Some(tx)));
        let device = Arc::new(DeviceController::new(holder, EventBus::new(), false));
        let registry = PeerRegistry::new();
        let global_running = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let mask = Arc::new(crate::streamcheats::MaskController::new(
            device.clone(),
            global_running,
        ));
        (
            Translator::new(MAC, false, device, registry.clone(), mask),
            rx,
            registry,
        )
    }

    /// Default peer address used by tests that don't care about it. Any
    /// non-localhost address would work — `handle_packet` only inspects
    /// the peer on `cmd_monitor`; every other arm ignores it.
    fn test_peer() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 5555)
    }

    /// A `mouse_move` whose payload claims `button=0x02` (RMB held) must
    /// produce a serial packet with byte 1 == 0x02, EVEN IF we never
    /// previously saw a `cmd_mouse_right` packet. This is the core
    /// robustness property of Option B.
    #[test]
    fn move_payload_button_drives_serial_mask() {
        let (t, rx, _reg) = make_translator();
        t.handle_packet(&pkt(CMD_MOUSE_MOVE, 0x02, 10, 10, 0), test_peer())
            .unwrap();
        let (_origin, p) = rx.try_recv().expect("expected one serial packet");
        assert_eq!(p[1], 0x02, "serial button byte should mirror payload.button");
        // And exactly ONE packet — the combined helper must not double-send.
        assert!(rx.try_recv().is_err(), "cmd_mouse_move must emit exactly one serial packet");
    }

    /// Side1 piggy-backs on `cmd_mouse_right` in the vendor SDK with the
    /// payload's `button` field carrying 0x08. The translator must forward
    /// 0x08 as the serial mask byte without needing a dedicated opcode.
    #[test]
    fn side1_via_mouse_right_opcode_produces_side1_mask() {
        let (t, rx, _reg) = make_translator();
        t.handle_packet(&pkt(CMD_MOUSE_RIGHT, 0x08, 0, 0, 0), test_peer())
            .unwrap();
        let (_origin, p) = rx.try_recv().expect("expected one serial packet");
        assert_eq!(
            p[1], 0x08,
            "BTN_SIDE1 should pass through verbatim from payload.button"
        );
    }

    /// If a prior packet asserted RMB (0x02) and a later move packet's
    /// payload claims `button=0`, the next serial packet's button byte
    /// must be 0 — proving the host SDK's persistent-global behaviour is
    /// honoured end-to-end (we don't accidentally OR the new mask on top
    /// of the old one).
    #[test]
    fn payload_zero_releases_all_buttons() {
        let (t, rx, _reg) = make_translator();
        // Hold RMB.
        t.handle_packet(&pkt(CMD_MOUSE_RIGHT, 0x02, 0, 0, 0), test_peer())
            .unwrap();
        let (_, p1) = rx.try_recv().unwrap();
        assert_eq!(p1[1], 0x02);
        // Subsequent move with button=0 must release.
        t.handle_packet(&pkt(CMD_MOUSE_MOVE, 0x00, 1, 1, 0), test_peer())
            .unwrap();
        let (_, p2) = rx.try_recv().unwrap();
        assert_eq!(p2[1], 0x00, "move with payload.button=0 must release the mask");
    }

    /// `cmd_mouse_left` with the LMB bit set in payload.button must result
    /// in byte 1 == 0x01 in the serial packet. This exercises the
    /// per-button-opcode path through the new payload-trust logic.
    #[test]
    fn mouse_left_press_emits_lmb_bit() {
        let (t, rx, _reg) = make_translator();
        t.handle_packet(&pkt(CMD_MOUSE_LEFT, 0x01, 0, 0, 0), test_peer())
            .unwrap();
        let (_, p) = rx.try_recv().unwrap();
        assert_eq!(p[1], 0x01);
    }

    /// `cmd_mouse_wheel` must emit exactly one packet carrying both the
    /// wheel delta and the payload's button mask.
    #[test]
    fn mouse_wheel_emits_single_packet_with_mask() {
        let (t, rx, _reg) = make_translator();
        t.handle_packet(&pkt(CMD_MOUSE_WHEEL, 0x04, 0, 0, -1), test_peer())
            .unwrap();
        let (_, p) = rx.try_recv().expect("expected one serial packet");
        assert_eq!(p[1], 0x04);
        assert_eq!(p[4], 0xFF, "wheel byte must be -1 as u8");
        assert!(rx.try_recv().is_err(), "wheel must emit exactly one serial packet");
    }

    /// `cmd_connect` must NOT emit a serial packet (reset is in-state
    /// only) but MUST clear the button mask.
    #[test]
    fn connect_resets_mask_without_emitting_serial() {
        let (t, rx, _reg) = make_translator();
        t.handle_packet(&pkt(CMD_MOUSE_RIGHT, 0x02, 0, 0, 0), test_peer())
            .unwrap();
        let _ = rx.try_recv().unwrap(); // drain the right-button packet
        t.handle_packet(&pkt(CMD_CONNECT, 0, 0, 0, 0), test_peer())
            .unwrap();
        assert!(rx.try_recv().is_err(), "cmd_connect must not emit serial");
        // Now a move with btn=0 should produce a 0-mask packet — proves
        // the reset actually cleared state.
        t.handle_packet(&pkt(CMD_MOUSE_MOVE, 0x00, 1, 1, 0), test_peer())
            .unwrap();
        let (_, p) = rx.try_recv().unwrap();
        assert_eq!(p[1], 0x00);
    }

    /// `cmd_keyboard_all` must be acknowledged (returns Some(reply)) but
    /// must NOT emit a serial packet (the firmware doesn't pass keyboard
    /// through and the translator carries no keyboard state). The reply
    /// is what lets the host SDK's `kmNet_keypress` call avoid a timeout.
    #[test]
    fn keyboard_all_acks_without_emitting_serial() {
        let (t, rx, _reg) = make_translator();
        let reply = t.handle_packet(&pkt(CMD_KEYBOARD_ALL, 0, 0, 0, 0), test_peer());
        assert!(reply.is_some(), "cmd_keyboard_all must produce a reply header");
        assert!(
            rx.try_recv().is_err(),
            "cmd_keyboard_all must NOT emit a serial packet"
        );
    }

    /// `cmd_keyboard_all` must not perturb the cumulative mouse button
    /// mask — a held LMB before the keyboard packet must still be held
    /// after, and the next mouse_move's serial packet must reflect it.
    #[test]
    fn keyboard_all_does_not_clobber_mouse_state() {
        let (t, rx, _reg) = make_translator();
        // Hold LMB.
        t.handle_packet(&pkt(CMD_MOUSE_LEFT, 0x01, 0, 0, 0), test_peer())
            .unwrap();
        let (_, p1) = rx.try_recv().unwrap();
        assert_eq!(p1[1], 0x01);
        // Keyboard packet arrives.
        t.handle_packet(&pkt(CMD_KEYBOARD_ALL, 0, 0, 0, 0), test_peer())
            .unwrap();
        assert!(rx.try_recv().is_err(), "keyboard_all must not emit serial");
        // Subsequent move with payload.button=0x01 should still produce
        // serial with the LMB bit set (proving the keyboard arm didn't
        // wipe state).
        t.handle_packet(&pkt(CMD_MOUSE_MOVE, 0x01, 1, 1, 0), test_peer())
            .unwrap();
        let (_, p2) = rx.try_recv().unwrap();
        assert_eq!(p2[1], 0x01);
    }

    /// `cmd_monitor` with `target_port != 0` must register the peer in
    /// the shared registry with `target_addr = (peer.ip, target_port)`
    /// — NOT `(peer.ip, peer.port)`. The host app's source port is
    /// different from its listening port (the SDK binds a fresh socket
    /// on the requested port, `kmboxNet.cpp:1517`).
    #[test]
    fn cmd_monitor_subscribe_registers_peer_with_target_port() {
        let (t, _rx, reg) = make_translator();
        let peer = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50)), 9999);
        t.handle_packet(&monitor_pkt(6000), peer).unwrap();
        let peers = reg.list_peers();
        assert_eq!(peers.len(), 1);
        assert_eq!(
            peers[0].0,
            SocketAddr::new(peer.ip(), 6000),
            "registered addr must be (peer.ip, target_port)"
        );
        assert_eq!(peers[0].1.mode_flags, 0xAA55);
    }

    /// A repeated `cmd_monitor` from the same (peer, port) is a refresh,
    /// NOT a new registration — the peer count stays at 1.
    #[test]
    fn cmd_monitor_repeat_from_same_peer_is_refresh() {
        let (t, _rx, reg) = make_translator();
        let peer = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50)), 9999);
        t.handle_packet(&monitor_pkt(6000), peer).unwrap();
        t.handle_packet(&monitor_pkt(6000), peer).unwrap();
        assert_eq!(reg.len(), 1);
    }

    /// `cmd_monitor(0)` unsubscribes every entry from the source IP.
    #[test]
    fn cmd_monitor_with_port_zero_unsubscribes() {
        let (t, _rx, reg) = make_translator();
        let peer = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50)), 9999);
        t.handle_packet(&monitor_pkt(6000), peer).unwrap();
        assert_eq!(reg.len(), 1);
        t.handle_packet(&monitor_pkt(0), peer).unwrap();
        assert_eq!(reg.len(), 0);
    }

    // ------------------------------------------------------------------
    // Encryption auto-detect — round-trip with real wire shapes.
    //
    // The translator's `handle_packet` discriminates encrypted vs
    // plaintext by length (128 bytes = encrypted). The two tests below
    // cover both arms with packets shaped exactly the way the vendor
    // SDK puts on the wire.
    // ------------------------------------------------------------------

    /// A plaintext mouse_left packet (72 bytes) must NOT be misclassified
    /// as encrypted. The translator should parse it normally and emit
    /// the corresponding serial packet. This guards against any future
    /// "always try-decrypt" temptation and proves the length predicate
    /// is the sole switch.
    #[test]
    fn autodetect_plaintext_packet_is_not_decrypted() {
        let (t, rx, _reg) = make_translator();
        // 72-byte plaintext mouse_left: button = 0x01 (LMB down).
        let plain = pkt(CMD_MOUSE_LEFT, 0x01, 0, 0, 0);
        assert_eq!(plain.len(), 72, "plaintext mouse-shaped is 72 bytes");
        t.handle_packet(&plain, test_peer()).unwrap();
        let (_origin, p) = rx
            .try_recv()
            .expect("plaintext packet must produce a serial packet");
        assert_eq!(
            p[1], 0x01,
            "plaintext button must reach serial unmodified"
        );
        assert!(
            rx.try_recv().is_err(),
            "should be exactly one serial packet"
        );
    }

    /// An encrypted mouse_left packet (128 bytes, built with the same
    /// `encrypt` we ported from the vendor source) must be detected by
    /// length, decrypted with the MAC-derived key, and produce the same
    /// serial output as the equivalent plaintext packet would.
    #[test]
    fn autodetect_encrypted_packet_is_decrypted_and_dispatched() {
        use crate::kmbox_net::encryption::{
            encrypt as encrypt_packet, key_from_mac, ENC_PACKET_LEN,
        };

        let (t, rx, _reg) = make_translator();

        // Build the plaintext 128-byte form: 16-byte header + 56-byte
        // soft_mouse + 56 zero bytes of padding. button = 0x02 (RMB
        // down), x = 11, y = -7, wheel = 0 — distinct values so we
        // know we are not accidentally reading zeros.
        let mut plain = [0u8; ENC_PACKET_LEN];
        LittleEndian::write_u32(&mut plain[0..4], MAC);
        LittleEndian::write_u32(&mut plain[4..8], 0x12345678);
        LittleEndian::write_u32(&mut plain[8..12], 42);
        LittleEndian::write_u32(&mut plain[12..16], CMD_MOUSE_RIGHT);
        LittleEndian::write_i32(&mut plain[16..20], 0x02);
        LittleEndian::write_i32(&mut plain[20..24], 11);
        LittleEndian::write_i32(&mut plain[24..28], -7);
        LittleEndian::write_i32(&mut plain[28..32], 0);

        // Encrypt with the configured MAC's key — exactly what the
        // vendor SDK's `kmNet_enc_mouse_right` would do before sending.
        let mut cipher = plain;
        let key = key_from_mac(MAC);
        encrypt_packet(&mut cipher, &key);
        // Sanity: ciphertext header must differ from plaintext header.
        assert_ne!(&cipher[..16], &plain[..16]);
        assert_eq!(cipher.len(), 128);

        // Dispatch.
        let reply = t
            .handle_packet(&cipher, test_peer())
            .expect("encrypted packet must produce a reply");
        // Reply header echoes the ORIGINAL (decrypted) header verbatim.
        assert_eq!(LittleEndian::read_u32(&reply[0..4]), MAC);
        assert_eq!(LittleEndian::read_u32(&reply[4..8]), 0x12345678);
        assert_eq!(LittleEndian::read_u32(&reply[8..12]), 42);
        assert_eq!(LittleEndian::read_u32(&reply[12..16]), CMD_MOUSE_RIGHT);

        // And the serial side must reflect the decoded button mask.
        let (_origin, p) = rx
            .try_recv()
            .expect("encrypted button packet must produce a serial packet");
        assert_eq!(p[1], 0x02, "decrypted button must reach serial");
    }

    /// An encrypted mouse_move packet must round-trip through
    /// length-detect → decrypt → dispatch with the original x/y deltas
    /// preserved.
    #[test]
    fn autodetect_encrypted_mouse_move_preserves_deltas() {
        use crate::kmbox_net::encryption::{
            encrypt as encrypt_packet, key_from_mac, ENC_PACKET_LEN,
        };

        let (t, rx, _reg) = make_translator();
        let mut plain = [0u8; ENC_PACKET_LEN];
        LittleEndian::write_u32(&mut plain[0..4], MAC);
        LittleEndian::write_u32(&mut plain[4..8], 0xAABBCCDD);
        LittleEndian::write_u32(&mut plain[8..12], 99);
        LittleEndian::write_u32(&mut plain[12..16], CMD_MOUSE_MOVE);
        LittleEndian::write_i32(&mut plain[16..20], 0x00);
        LittleEndian::write_i32(&mut plain[20..24], 23);
        LittleEndian::write_i32(&mut plain[24..28], -45);

        let mut cipher = plain;
        let key = key_from_mac(MAC);
        encrypt_packet(&mut cipher, &key);

        t.handle_packet(&cipher, test_peer()).unwrap();
        let (_origin, p) = rx.try_recv().expect("serial packet expected");
        // Streamcheats packet layout (see streamcheats::packet::build_packet):
        //   p[0] = 0x08 (report id), p[1] = btn, p[2]/p[3] = axis_lo(x|y),
        //   p[4] = wheel, p[5..7] = x_le i16, p[7..9] = y_le i16.
        // We assert against the extended i16 slots so out-of-int8-range
        // values would still work; for 23 / -45 the lo bytes match too.
        let x = i16::from_le_bytes([p[5], p[6]]);
        let y = i16::from_le_bytes([p[7], p[8]]);
        assert_eq!(x, 23, "decrypted x mismatch");
        assert_eq!(y, -45, "decrypted y mismatch");
    }

    /// An encrypted packet stamped with the WRONG MAC must be silently
    /// dropped: decryption with the translator's key produces garbage,
    /// the header's `mac` field then almost certainly fails the
    /// configured-MAC check, and `handle_packet` returns `None`. This
    /// proves the post-decrypt MAC gate still functions on the
    /// encrypted path.
    #[test]
    fn autodetect_encrypted_packet_with_wrong_mac_is_dropped() {
        use crate::kmbox_net::encryption::{
            encrypt as encrypt_packet, key_from_mac, ENC_PACKET_LEN,
        };

        let (t, rx, _reg) = make_translator();
        let wrong_mac: u32 = 0xDEADBEEF;
        let mut plain = [0u8; ENC_PACKET_LEN];
        LittleEndian::write_u32(&mut plain[0..4], wrong_mac);
        LittleEndian::write_u32(&mut plain[12..16], CMD_MOUSE_LEFT);
        LittleEndian::write_i32(&mut plain[16..20], 1);

        let mut cipher = plain;
        // Encrypt with the WRONG mac's key (matching its header) — but
        // the translator's expected_mac is `MAC`, so it will decrypt
        // with `MAC`'s key, get garbage, and reject.
        let wrong_key = key_from_mac(wrong_mac);
        encrypt_packet(&mut cipher, &wrong_key);

        let reply = t.handle_packet(&cipher, test_peer());
        assert!(reply.is_none(), "wrong-MAC encrypted packet must be dropped");
        assert!(
            rx.try_recv().is_err(),
            "wrong-MAC encrypted packet must NOT emit serial"
        );
    }
}
