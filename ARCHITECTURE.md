# Architecture

This document covers the design decisions, the runtime topology, and
the cross-module contracts inside the Rust daemon. For per-file role
documentation see the module-level `//!` blocks in `backend/src/`; for
the user-facing config / log / supported-commands reference see
[`backend/README.md`](backend/README.md).

## Peer-protocol model

The daemon talks two distinct wire protocols and they have been kept
deliberately at arm's length so future changes on either side don't
pull in the other:

- **`kmbox_net/`** owns *everything* that touches the KMBox Net UDP
  protocol — wire-format types ([`schema.rs`](backend/src/kmbox_net/schema.rs)),
  decoders ([`parser.rs`](backend/src/kmbox_net/parser.rs)), the XXTEA-style
  body cipher ([`encryption.rs`](backend/src/kmbox_net/encryption.rs)),
  and the outbound `monitor/` subscriber that emits state echoes to
  third-party host apps.
- **`streamcheats/`** owns *everything* that touches the Teensy
  firmware — the 9-byte mouse-HID packet builder
  ([`packet.rs`](backend/src/streamcheats/packet.rs)), the
  3-byte-prefix settings packet builder
  ([`device_settings.rs`](backend/src/streamcheats/device_settings.rs)),
  COM-port auto-discovery ([`discovery.rs`](backend/src/streamcheats/discovery.rs)),
  the per-session reader / writer threads, the permanent heartbeat
  thread, the [`DeviceController`](backend/src/streamcheats/device.rs)
  state machine, and the mask subsystem.
- **`util/translator.rs`** is the *bridge* — and the only place that
  imports from both sides. It parses one inbound UDP datagram,
  dispatches to one or more `DeviceController` calls, and (for
  interpolated motion) spawns short-lived worker threads.

Neither `kmbox_net` nor `streamcheats` knows the other exists. Adding a
second downstream device backend (e.g. a different firmware) would
only require a new `streamcheats`-shaped module and a new bridge.

## Thread layout

Permanent threads (alive for the entire process lifetime):

| Thread name | Owner / file | Responsibility |
|---|---|---|
| `main` | `main.rs::run` | UDP `recv_from` loop → `Translator::handle_packet` → UDP reply |
| `supervisor` | `main.rs::supervisor_loop` | Auto-discover Teensy; on match spawn `writer`+`reader`; rejoin on disconnect; rescan |
| `heartbeat` | `streamcheats::heartbeat::heartbeat_loop` | Every 2.5 s push a benign settings packet; pause when firmware goes silent |
| `monitor_emitter` | `kmbox_net::monitor::subscriber` | Subscribe to `EventBus`; fan out 20-byte echo UDP per `StateChange` per peer |
| `http-server-driver` | `http::server` | tokio runtime hosting the axum app (`/health`, `/bug-report`) |
| `log_rotation` (optional) | `util::log_rotation` | Hourly sweep of `<data_dir>/logs/`; trim oldest when 1 GiB cap exceeded |

Per-session threads (alive only while a Teensy is plugged in):

| Thread | File | Responsibility |
|---|---|---|
| `writer` | `streamcheats::writer` | Drain mpsc → `write_all` on the serial port; log `OUT (COMx):` |
| `reader` | `streamcheats::reader` | Concurrent `read()` on the same `Arc<SerialPort>`; emit `IN (COMx):` per line |

Short-lived threads (one per call):

| Trigger | Worker | Cadence |
|---|---|---|
| `cmd_mouse_automove` | `translator::interp_linear` | One delta packet every 4 ms (`STEP_MS`) for the requested duration |
| `cmd_bazier_move` | `translator::interp_bezier` | Same cadence, cubic-bezier path |
| `cmd_mask_mouse` first axis-mask | `streamcheats::mask::watchdog` | Re-arm pump every 50 ms while X or Y is masked; joined when mask clears |

### The `SerialTxHolder` swap

The supervisor's "device is/is not currently attached" state lives in
a single `Arc<Mutex<Option<Sender<SerialEnvelope>>>>` shared between
the [`DeviceController`], the heartbeat thread, and the supervisor
itself. While the holder is `None`, every would-be serial write
becomes a silent no-op — but the UDP listener keeps replying, so host
apps never see the translator stall. This is the single mechanism
that makes "plug, unplug, replug" work without restarting anything.

## Event flow: one `cmd_mouse_move` packet

```
UDP datagram (72 bytes)
        |
        v
main thread recv_from
        |
        v
Translator::handle_packet  --[MAC check]--> drop if mismatch
        |
        v
SoftMouse::parse  (kmbox_net/parser.rs)
        |
        v
Translator dispatches `CMD_MOUSE_MOVE`
        |
        v
DeviceController::apply_buttons_and_move(mask, dx, dy)
        |     |
        |     +---> mutate DeviceState behind a Mutex
        |     +---> build 9-byte packet via streamcheats::packet::build_packet
        |     +---> drop mutex
        |     +---> serial_tx.send((origin, packet))      ----> writer thread --> OUT (COMx):
        |     +---> event_bus.publish(StateChange::MoveEmitted{..})  ----> monitor_emitter --> 20-byte UDP echo per peer
        v
Header::reply()  (byte-for-byte echo)
        |
        v
UDP reply (16 bytes) ----> host app
```

Each step in the lower half (serial send, event publish, UDP reply)
happens *after* the controller's mutex has been released — see the
[`DeviceController`](backend/src/streamcheats/device.rs) locking
discipline section in its module docs.

## State machine: `DeviceController` + `EventBus`

The state machine is the seam between the UDP-shaped world and the
firmware-shaped world. Two key types:

- [`DeviceState`](backend/src/streamcheats/state/device_state.rs) — a
  plain `Clone`able struct holding the cumulative button mask, the most
  recent move/wheel deltas, last-update timestamp, and a lifetime
  packet counter. Lives inside a `Mutex` inside `DeviceController`.
- [`DeviceController`](backend/src/streamcheats/device.rs) — single
  authority for state mutation. Every `apply_*` method takes the
  mutex, mutates, builds the serial packet, **drops the mutex**, then
  sends to the serial channel and publishes a `StateChange` event.
  The mutex is never held across a channel send or a bus publish — see
  module docs for the rationale (avoid cross-thread priority inversion
  on slow subscribers).

[`StateChange`](backend/src/streamcheats/state/event.rs) variants:

- `ButtonsChanged { from, to, at }` — published only when the mask
  actually changed (`from != to`). A no-op `apply_buttons` is silent.
- `MoveEmitted { dx, dy, button_mask, at }` — published on **every**
  call, including (0, 0) no-op ticks from interpolation workers
  (subscribers may want cadence visibility).
- `WheelEmitted { wheel, button_mask, at }` — same per-call cadence.
- `Reset { at }` — `cmd_connect` cleared volatile state.

The [`EventBus`](backend/src/streamcheats/state/bus.rs) is a
hand-rolled `std::sync::mpsc` fan-out — see its module docs for why
the project deliberately avoids pulling tokio into the device-state
core.

## Mask subsystem: `cmd_mask_mouse` / `cmd_unmask_all`

The host's `kmNet_mask_*` calls are cumulative — every call RMWs one
bit into a persistent global and re-sends the whole flag word. The
translator mirrors that model:

- [`MaskState`](backend/src/streamcheats/mask/state.rs) is the
  cumulative shadow keyed by the low byte of `head.rand`.
- [`MaskController`](backend/src/streamcheats/mask/controller.rs)
  diffs each incoming `head.rand` against the shadow and only emits
  the `DeviceSettings` packets that actually changed.
- Per-button bits map 1:1 onto the firmware's
  `DisablePassthroughFor{Lmb,Rmb,Mmb,Mb4,Mb5}` toggles.
- X / Y axis bits ride the firmware's sens-reduction pipeline: a
  `(buttons, 0, 0, wheel=1)` HID packet opens a duration-bounded
  reduction window (default 100 ms); the
  [`mask::watchdog`](backend/src/streamcheats/mask/watchdog.rs) thread
  re-arms it every 50 ms while X or Y is masked. The watchdog is
  spawned the first time an axis bit is set and joined when both axis
  bits clear.
- Wheel-mask and keyboard-mask bits log a warn-and-drop — the firmware
  has no wheel-passthrough toggle and no keyboard channel.

## HTTP service

Bound to `127.0.0.1:0` (kernel picks the port). The chosen port is
published to `%TEMP%\streamcheats_core.http_port` so the Electron
shell can discover it without configuration. Failure to bind is
non-fatal — the daemon keeps running, the bug-report endpoint is just
unavailable until restart.

Routes:

- `GET /health` — JSON `{status, uptime_seconds, version}`. Used by
  Electron as a readiness probe.
- `POST /bug-report` — returns the diagnostic zip described below, or
  `400 {"error":"file_logging_disabled"}` when the user has opted
  out of file logging. The orchestrator runs on the tokio blocking
  pool so a heavy log slice doesn't tie up an axum worker.

The whole HTTP surface is the only async code in the daemon. The rest
(UDP listener, supervisor, monitor emitter, serial reader/writer,
heartbeat, mask watchdog) stays std-thread based — see
[`http::server`](backend/src/http/server.rs) module docs for why.

## Bug-report bundle contents

[`services::bug_report::build_bundle`](backend/src/services/bug_report/mod.rs)
composes five entries into one in-memory zip:

| Entry | Source | Notes |
|---|---|---|
| `streamcheats_last_5min.log` | `log_slicer::slice_last_window` | Tail of today's + yesterday's daily log file, timestamp-filtered to the 5-minute window. ANSI escapes stripped defensively. |
| `config.json` | `config_snapshot::read_config` | Verbatim copy from the daemon's cwd. Missing file → synthetic placeholder. No redaction. |
| `info.txt` | `system_info::render` | Human-readable `key = value`: app_version, pid, uptime, OS, hostname, dirs, file-logger drop count, bind addresses, monitor subscriber count. |
| `device_state.json` | `device_state_snapshot::build` | JSON projection of the live `DeviceState` plus the monitor peer list. `Instant` fields back-projected to wall-clock via a single sample pair. |
| `manifest.json` | `mod.rs` orchestrator | Lists the other four entries with their sizes and a generated-at timestamp. |

## Logging conventions

Every structured log line is prefixed so its direction and concern are
unambiguous. The prefixes are grep targets — do not change them:

| Prefix | Meaning |
|---|---|
| `IN (KMBOX NET):` | Inbound UDP datagram accepted (MAC matched). |
| `OUT (COMx):` | A 9-byte serial packet was written to the firmware. Body is space-separated uppercase hex. |
| `IN (COMx):` | A newline-terminated line was received from the firmware. Non-printable bytes escaped as `\xHH`. |
| `STATE:` | A `DeviceController` mutation happened (button mask change, move/wheel emitted, mask transition). UPPERCASE because these are the canonical authoritative state-change events. |
| `MONITOR:` | A subscribe / emit / unsubscribe happened on the monitor-mode channel. |
| (lowercase init lines) | One-shot startup / lifecycle messages: `Listening on …`, `Found device on COMx`, `daemon: pid=…`, `http: listening on …`. Plain prose, no all-caps prefix. |

`enable_timing_logs: true` in `config.json` adds a `parse=Nµs` suffix
to every `IN (KMBOX NET):` line and a `(lat=X.YYms q=A.BBms w=C.DDms)`
suffix to every `OUT (COMx):` line — `lat` = total origin → wire, `q`
= mpsc-queue wait, `w` = `write_all` syscall.

## Encryption auto-detection

The vendor SDK's `kmNet_enc_*` variants share opcodes with their
plaintext counterparts and always send exactly 128 bytes
(`sendto(..., 128, 0, ...)`). Plaintext is 16 bytes (header-only) or
72 bytes (mouse-shaped). Length is therefore a perfect discriminator
— see [`kmbox_net::encryption`](backend/src/kmbox_net/encryption.rs)
module docs for the alternatives considered and the rationale for
length-based detection.

The cipher is a six-round XXTEA-style block cipher on 32 little-endian
`u32` words. The 16-byte key derives from the daemon's configured MAC
(`mac.to_be_bytes()` then 12 zero bytes). Encryption is implemented for
test fixtures; the daemon itself only ever decrypts.

## Daemon lifecycle

- **Takeover** — on startup the daemon checks
  `%TEMP%\streamcheats_core.pid`. If it names a live process whose
  image name matches `streamcheats_core`, the new instance
  terminates the old one and waits up to 3 s for it to exit before
  binding the UDP port. Mismatched / dead / unparseable pid files are
  silently cleaned up. See
  [`util::daemon::takeover_if_running`](backend/src/util/daemon.rs).
- **Publication** — after successful UDP bind, the daemon atomically
  writes its PID to the pid file and the UDP port to
  `%TEMP%\streamcheats_core.port`. The HTTP port is published
  separately to `%TEMP%\streamcheats_core.http_port` after the
  axum bind succeeds.
- **Shutdown** — Ctrl+C flips a shared `Arc<AtomicBool>`. Every long-
  lived loop polls it at ≤ 250 ms cadence; the supervisor tears down
  the per-session reader/writer; the file-logger `WorkerGuard` flushes
  buffered lines; `daemon::cleanup` removes the temp files.
- **Discoverability** — the Electron shell reads the published HTTP
  port, polls `/health` until it's `ok`, then issues `/bug-report` on
  demand. The frontend never speaks UDP directly.

## File logging

`tracing_appender::non_blocking` in **lossy mode** with an explicit
128 000-line bounded channel. Hot-path threads (UDP main, serial
writer/reader, heartbeat, interpolation workers) never block on disk —
the appender drops on overflow rather than stall. See
[`main::init_logging`](backend/src/main.rs) for the full hot-path
latency contract. Daily-rotating files at
`<data_dir>/logs/streamcheats.YYYY-MM-DD.log`; a separate hourly janitor
thread trims oldest when total exceeds a hardcoded 1 GiB cap (today's
file is always preserved).
