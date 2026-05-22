# StreamCheats Core — backend daemon

> **For the project-wide overview** (Electron shell, Next.js frontend,
> portable-build instructions, layout map) see the top-level
> [`README.md`](../README.md) and [`ARCHITECTURE.md`](../ARCHITECTURE.md).
> This document covers the **Rust daemon only** — config file, log
> format, supported commands, threading.

A Windows PC-side bridge between third-party KMBox Net host apps and the
Teensy 4.1 USB Host Proxy firmware. It listens for KMBox Net UDP commands
from any host app that already speaks the protocol (game tools, anti-cheats
with KMBox support, etc.), translates each command into the Streamcheats
firmware's 9-byte binary serial protocol, and forwards the result to the
Teensy over a USB-CDC COM port that the translator auto-discovers — no
COM number to configure, plug-and-play across reboots and reconnects.
The Teensy injects the resulting HID mouse events into the target PC;
the host app on the input PC continues to see normal KMBox Net replies,
so it has no idea anything has been swapped out.

```
host app  --UDP (KMBox Net)-->  THIS TRANSLATOR  --serial (9-byte binary)-->  Teensy proxy
```

## Quick start

From inside the `StreamCheats Core/` folder:

```
cargo build --release
.\target\release\streamcheats_core.exe
```

On the **first run** the binary writes a default `config.json` next to
itself (whatever the process's current working directory is) and exits
with a message asking you to edit it. The only field you must set
before the next run is:

* `listen_addr` — the local IP to bind the UDP listener on. `0.0.0.0`
  accepts traffic from any interface.

The COM port is **auto-discovered**: at startup (and again after every
disconnect) the translator scans every available serial port in
parallel and watches for the firmware's banner lines (`S: ...`,
`I: ...`, `V: ...`, `E: ...`, `M: ...`, `SYN:...`). The first port
that matches becomes the active session; unplugging the Teensy makes
the supervisor rescan automatically, and the UDP side keeps replying
to host apps the entire time so they don't stall.

If you already have a `config.json` with `listen_addr` set to a bad
value (e.g. an unparseable IP), the translator prints a specific error
naming the field and exits without touching the file — your other
edits are preserved. Only an unreadable / unparseable file gets
discarded and replaced with a fresh default.

Stale `com_port` / `baud_rate` keys from older config files are
ignored silently so you can drop in this version without hand-editing.

If your shell path contains the space in `StreamCheats Core`, quote
it according to your shell's rules:

* PowerShell: `cd 'C:\...\StreamCheats Core'`
* cmd.exe:    `cd "C:\...\StreamCheats Core"`
* bash (Git Bash / WSL): `cd "/c/.../StreamCheats Core"`

## `config.json` reference

The file lives in the working directory and uses these fields:

| Field                 | Type   | Required | Default      | Validation                                         | Example          |
|-----------------------|--------|----------|--------------|----------------------------------------------------|------------------|
| `listen_addr`         | string | yes      | (none)       | Must parse as an IPv4 or IPv6 address.             | `"0.0.0.0"`      |
| `udp_port`            | u16    | no       | `8888`       | `1..=65535` (zero is rejected).                    | `8888`           |
| `device_mac`          | string | no       | `"01FBC068"` | Exactly 8 hex characters. Host app must send this value in every packet's header. | `"01FBC068"` |
| `enable_timing_logs`  | bool   | no       | `false`      | Adds per-packet latency suffixes to every IN/OUT log line. Diagnostic only. | `true`         |

The serial port and baud rate are no longer configurable — the
translator auto-discovers a Teensy on any port and the baud rate is
hardcoded to 115200 (the firmware is fixed at that rate).

A working example lives at `config.example.json` next to the source.

## Log format

All log lines come from `tracing_subscriber` and use one of three channel
prefixes so the direction of each event is unambiguous:

* `IN (KMBOX NET):` — a UDP datagram from a host app was accepted (MAC
  matched, header parsed). Followed by the decoded command and its args.
* `OUT (COM<n>):` — a 9-byte Streamcheats packet was written to the
  serial port. Followed by space-separated uppercase hex.
* `IN (COM<n>):` — a newline-terminated line was received back from the
  firmware. Non-printable bytes are escaped as `\xHH`.

Annotated example (with `enable_timing_logs: false`, the default):

```
2026-05-19T14:22:00.012Z  INFO Listening on 0.0.0.0:8888, mac=01FBC068
2026-05-19T14:22:00.013Z  INFO Scanning available COM ports for firmware...
2026-05-19T14:22:01.041Z  INFO Found device on COM7                                        # auto-discovery match
2026-05-19T14:22:03.118Z  INFO IN (KMBOX NET): cmd=connect (reset button mask)            # host app handshake; button state zeroed
2026-05-19T14:22:03.224Z  INFO IN (KMBOX NET): cmd=mouse_move x=12 y=-3 mask=0x00          # decoded UDP packet
2026-05-19T14:22:03.224Z  INFO OUT (COM7): 08 00 0C FD 00 0C 00 FD FF                      # the 9 bytes we wrote to serial
2026-05-19T14:22:03.255Z  INFO IN (COM7): S:ready                                          # firmware status line
2026-05-19T14:22:05.624Z  INFO Sending heartbeat (firmware version request)               # keepalive (every 2.5s, see "Heartbeat" below)
2026-05-19T14:22:05.625Z  INFO OUT (COM7): 03 00 00 00 00 00 00 00 00
2026-05-19T14:22:05.626Z  INFO IN (COM7): I: V: 5.17                                       # firmware version reply
```

When no device is attached, the supervisor logs:

```
INFO Scanning available COM ports for firmware...
INFO No device found, will try again in 10 seconds
```

…and keeps the UDP socket bound, so host apps can connect, send
commands, and receive replies even while no Teensy is plugged in
(outbound serial packets are silently dropped during that window).
Unplugging an attached Teensy mid-session prints:

```
ERROR serial write failed on COM7 (9 bytes): ... — ending session
INFO  Device on COM7 disconnected — rescanning
```

…and the supervisor goes straight back into discovery.

With `enable_timing_logs: true`, every `IN (KMBOX NET):` line gets a
`parse=Nµs` suffix and every `OUT (COMx):` line gets a
`(lat=X.YYms q=A.BBms w=C.DDms)` suffix:

```
INFO IN (KMBOX NET): cmd=mouse_move x=12 y=-3 mask=0x00 parse=18µs
INFO OUT (COM7): 08 00 0C FD 00 0C 00 FD FF (lat=1.23ms q=0.04ms w=1.19ms)
```

`lat` is total origin → wire; `q` is mpsc-queue wait; `w` is the
`write_all` syscall duration. The flag is purely diagnostic — leave it
off for normal operation.

Set `RUST_LOG=debug` to add the per-packet "dropping packet with wrong
mac" lines and other lower-level diagnostics. The default level is `info`.

## Wire formats

The two wire formats are documented inline next to the types that
implement them — those docs are the canonical reference. The headlines:

* **Incoming (KMBox Net UDP)** — 16-byte little-endian `Header` plus a
  command-specific body (most commonly a 56-byte `SoftMouse`). The full
  layout and the `CMD_*` table live in
  [`src/kmbox_net/schema.rs`](src/kmbox_net/schema.rs); the decoders are
  in [`src/kmbox_net/parser.rs`](src/kmbox_net/parser.rs).
* **Outgoing (Streamcheats serial — mouse HID)** — fixed 9 bytes: a
  `0x08` length prefix, button bitmask, an int8/sentinel low byte for X
  and Y, the wheel delta, and an always-populated 16-bit extended
  `(x, y)` pair. The byte-by-byte layout and the "always extended for
  Python parity" rationale live at the top of
  [`src/streamcheats/packet.rs`](src/streamcheats/packet.rs).
* **Outgoing (Streamcheats serial — device settings)** — fixed 9 bytes
  with a `0x03` length prefix instead of `0x08`. Byte 1 is the
  [`DeviceSettings`](src/streamcheats/device_settings.rs) ID (0–11,
  mirroring the firmware's `FirmwareSettings::updateSettings` switch),
  bytes 2–3 are the signed `i16` value LE, the rest are zero. Currently
  emitted only as the 2.5 s heartbeat
  (`build_settings_packet(DeviceSettings::FirmwareVersion, 0)`); the
  full enum is exposed for future settings-write features.

## Supported commands

| `CMD_*` constant       | Command label    | Translator behaviour                                                                                  |
|------------------------|------------------|-------------------------------------------------------------------------------------------------------|
| `CMD_CONNECT`          | `connect`        | Clear the cumulative button mask. Reply only — no serial output.                                      |
| `CMD_MOUSE_MOVE`       | `mouse_move`     | Emit one Streamcheats packet with `(x, y)` delta and the current button mask.                         |
| `CMD_MOUSE_LEFT`       | `mouse_left`     | Set or clear `BTN_LEFT` in the cumulative mask; emit one packet with the new mask, no motion.         |
| `CMD_MOUSE_RIGHT`      | `mouse_right`    | Same as left, but for `BTN_RIGHT`.                                                                    |
| `CMD_MOUSE_MIDDLE`     | `mouse_middle`   | Same as left, but for `BTN_MIDDLE`.                                                                   |
| `CMD_MOUSE_WHEEL`      | `mouse_wheel`    | Emit one packet with wheel delta in byte 4, zero motion, current button mask.                         |
| `CMD_MOUSE_AUTOMOVE`   | `mouse_automove` | Spawn a linear interpolation worker that emits delta packets every 4 ms over `duration_ms`.           |
| `CMD_BAZER_MOVE`       | `bezier_move`    | Spawn a cubic-bezier interpolation worker with the given control points, same 4 ms cadence.           |
| `CMD_KEYBOARD_ALL`     | `keyboard_all`   | Ack only. Keyboard forwarding is not yet wired through to serial.                                     |
| `CMD_REBOOT`           | `reboot`         | Ack only.                                                                                             |
| `CMD_MONITOR`          | `monitor`        | Ack only.                                                                                             |
| `CMD_MASK_MOUSE`       | `mask_mouse`     | Ack only.                                                                                             |
| `CMD_UNMASK_ALL`       | `unmask_all`     | Ack only.                                                                                             |
| `CMD_SETCONFIG`        | `setconfig`      | Ack only.                                                                                             |
| `CMD_SETVIDPID`        | `setvidpid`      | Ack only.                                                                                             |
| `CMD_DEBUG`            | `debug`          | Ack only.                                                                                             |
| `CMD_SHOWPIC`          | `showpic`        | Ack only.                                                                                             |
| `CMD_TRACE_ENABLE`     | `trace_enable`   | Ack only.                                                                                             |

Every accepted command produces a reply header that is a **byte-for-byte
echo** of the request header (same `mac`, `rand`, `indexpts`, and
`cmd`). The vendor SDK's `NetRxReturnHandle` enforces
`rx.indexpts == tx.indexpts`; the official client also overwrites its
own `ret = 0` after the check so it silently accepts a mismatch, but
stricter third-party clients honour the result and refuse to connect on
anything else. Unknown command codes are still echoed back so the host
app doesn't stall.

## Companion debug tool: `serial_debug.py`

`serial_debug.py` sends the same 9-byte Streamcheats packets straight to
the COM port, bypassing UDP and the translator entirely. Reach for it
when you want to confirm whether a problem lives on the firmware side or
the translator side. Run it like:

```
python serial_debug.py --port COM7
python serial_debug.py --port COM7 --baud 115200
```

The interactive menu (described at runtime) covers cardinal-direction
moves, custom `(dx, dy)`, button presses/clicks, a 10 ms spam loop, and a
"heartbeat" settings packet that asks the firmware for its version. It
requires `pyserial` (`pip install pyserial`).

## Module layout

```
src/
  main.rs                  # entrypoint, UDP loop, supervisor + heartbeat threads, log formatting
  kmbox_net/
    mod.rs                 # re-exports the items most call sites need
    schema.rs              # wire-format types (Header, SoftMouse) + CMD_* table
    parser.rs              # decoders for the above + Header::reply
  streamcheats/
    mod.rs                 # re-exports
    packet.rs              # 9-byte mouse-HID serial packet builder + button bitmask constants
    device_settings.rs     # firmware setting IDs (DeviceSettings enum) + 3-byte settings packet builder
    discovery.rs           # parallel COM-port auto-discovery (matches firmware banner prefixes)
    writer.rs              # serial writer thread (per-session; exits on write error)
    reader.rs              # serial reader thread (per-session)
    heartbeat.rs           # permanent heartbeat thread, idles when no device is attached
  util/
    mod.rs                 # re-exports
    settings.rs            # config.json load / validate / default-rewrite (three-way LoadOutcome)
    translator.rs          # Translator state machine + linear/bezier interpolation workers
```

## Threading model

The UDP socket, the `Translator`, the heartbeat, and the supervisor are
**permanent** threads — they live for the entire process. The serial
reader and writer are **per-session** — spawned each time the
supervisor discovers a Teensy and torn down on disconnect.

| Thread | Lifetime | Owns | Responsibility |
|---|---|---|---|
| **Main** | permanent | the UDP socket, the `Translator` | `recv_from` loop, header parse + MAC check, dispatch via `Translator::handle_packet`, send UDP reply |
| **Supervisor** | permanent | the discovery loop, per-session join handles | scans every available COM port in parallel; on match, configures the port and spawns writer+reader; on writer exit, joins reader and rescans |
| **Heartbeat** | permanent | a clone of the `SerialTxHolder` | every 2.5 s, if the holder is `Some`, sends a `FIRMWARE_VERSION` request; otherwise no-ops |
| **Writer** | per-session | a clone of `Arc<SerialPort>` | drains the mpsc channel and calls `write_all`; logs `OUT (COMx): …`; **exits on write error** (this is the "device unplugged" signal the supervisor watches for) |
| **Reader** | per-session | a clone of `Arc<SerialPort>` | concurrent `read()` (serial2 supports this), buffers by `\n`, logs `IN (COMx): …`; exits on read error or per-session running flag |
| **Worker** | short-lived | `SerialTxHolder` clone, snapshot of button mask | spawned per `cmd_mouse_automove` / `cmd_bezier_move`, emits delta packets at `STEP_MS = 4 ms` cadence |

The translator's serial sender lives in a `SerialTxHolder`
(`Arc<Mutex<Option<Sender<SerialEnvelope>>>>`). The supervisor swaps
it: `Some(tx)` while a session is active, `None` otherwise. While
`None`, the translator silently drops outbound serial packets but
still returns the UDP reply — so host apps continue to see a healthy
translator even with no Teensy attached.

The button mask is the only shared mutable state; it lives in
`Arc<Mutex<u8>>` and is locked briefly per per-button-command (main
thread) and per interpolation step (worker threads).

The mpsc channel is unbounded and uses real OS wake-ups — when the main
thread does `tx.send(...)`, the writer thread is woken immediately, not
after up to a polling interval. None of the timeouts in the loop bodies
(`socket.set_read_timeout(250ms)`, `rx.recv_timeout(50ms)`, the heartbeat
tick) gate throughput; they only bound shutdown responsiveness.

## Implementation notes

This crate uses [`serial2`](https://docs.rs/serial2/) for the serial
side rather than the more common `serialport-rs`. The older crate's
Windows implementation calls `WriteFile` with `lpOverlapped = NULL` on a
handle opened with `FILE_FLAG_OVERLAPPED`, which forces `WriteFile` to
honour the `COMMTIMEOUTS` write-timeout and pick up the FTDI/CH340
driver's internal write-batching, producing 500-630 ms first-write
latencies on this hardware. `serial2` uses overlapped I/O properly and
exposes separate read and write timeouts, so we can set the write
timeout to zero (no ceiling, blocks until physically out) the same way
pyserial does by default.

## Testing

```
cargo test --release
```

Currently runs **34 tests** covering:

* `kmbox_net::parser` — header decode (little-endian), reply
  construction (byte-for-byte echo of the request header), `SoftMouse`
  body decode for both plain moves and automove-with-control-points.
* `streamcheats::packet` — byte-for-byte parity with the Python
  reference for in-range zeros, positive and negative axis overflow,
  the `-128` / `+127` boundary that takes the sentinel path, wheel-only
  packets, and out-of-range clamping.
* `streamcheats::device_settings` — the `0x03`-prefixed wire form, the
  heartbeat byte sequence matches the literal that `main.rs` used
  before this module existed, negative / positive / `i16::MAX` /
  `i16::MIN` values pack as expected, and every `DeviceSettings`
  variant's discriminant matches the firmware's switch ID.
* `util::settings` — MAC parsing (accept lowercase, reject wrong length
  and non-hex), `listen_addr` requiredness, defaulting of `udp_port` /
  `device_mac` when omitted, that `enable_timing_logs` can be opted
  into via the config file, and that stale `com_port` / `baud_rate`
  keys in legacy configs are silently ignored.
* `streamcheats::discovery` — firmware-prefix matcher: each of the six
  known prefixes (`S: `, `I: `, `V: `, `E: `, `M: `, `SYN:`) matches
  when embedded in noise, unknown letters don't match, `I:hello`
  (missing space) doesn't match, partial lines without a `\n`
  terminator don't match, CRLF works, and `SYN:` matches with digits
  directly following.

## Not yet implemented

The following parts of the KMBox Net surface are recognised but not
forwarded to serial, by design:

* `CMD_KEYBOARD_ALL` — the translator acknowledges with the reply
  header but drops the body. Adding keyboard forwarding will need a
  new `SoftKeyboard` body decoder plus a Streamcheats packet shape the
  firmware can route to HID keyboard output.
* The `enc_*` encrypted variants of every mouse/keyboard command — the
  vendor SDK can encrypt packet bodies with a session key. We currently
  only handle the clear-text codes; encrypted traffic will be dropped on
  the `unknown(0x<code>)` path.

These are intentional gaps, not bugs — the natural entry point for new
work is `Translator::dispatch`.
