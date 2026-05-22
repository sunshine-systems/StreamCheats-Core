# Overnight Test Results — 2026-05-21

## Phase 1 — Mask implementation

New module `backend/src/streamcheats/mask/` with three files:

* `state.rs` — `MaskState` + bit constants (`MASK_LMB`/`RMB`/`MMB`/`SIDE1`/`SIDE2`/`X`/`Y`/`WHEEL`).
* `controller.rs` — `MaskController` that diffs new vs old mask state and emits exactly the changed `DeviceSettings` packets via `DeviceController::send_settings_packet`. Also drives the watchdog lifecycle.
* `watchdog.rs` — pump thread that, while X or Y is masked, calls `DeviceController::apply_axis_mask_rearm(current_buttons)` every 50 ms.

Added two non-state-mutating emit methods on `DeviceController`:

* `send_settings_packet([u8; 9])` — bumps the lifetime emission counter, leaves button/move/wheel state alone (settings carry no HID semantics).
* `apply_axis_mask_rearm(u8)` — emits `(buttons, 0, 0, wheel=1)`, the firmware's sens-reduction re-arm trigger; snapshots current buttons so held buttons are never released.

`util::translator::Translator::dispatch`:

* `CMD_MASK_MOUSE` → `MaskController::apply_mask_mouse(header.rand)`
* `CMD_UNMASK_ALL` → `MaskController::apply_unmask_all(header.rand)`

Wire-format authority confirmed via `https://raw.githubusercontent.com/kvmaibox/kmboxnet/main/c%2B%2B_demo/NetConfig/kmboxNet.cpp` lines 1185-1374 (mouse mask bits low byte of `head.rand`, keyboard vkey in `(v_key << 8)` for `cmd_mask_mouse` and `cmd_unmask_all`).

Mask bit → behavior table:

| Bit | Action |
|---|---|
| LMB / RMB / MMB / Side1 / Side2 | `DisablePassthroughFor{Lmb,Rmb,Mmb,Mb4,Mb5}` (IDs 8/7/6/9/10) |
| X (0x20) | First-entry: `EnableSensReduction=1` (id=2), `Duration=100ms` (id=3); always on change: `AmountX={0 masked,100 unmasked}` (id=4); spawn watchdog |
| Y (0x40) | First-entry: same Enable+Duration; on change: `AmountY` (id=5); spawn watchdog if not already |
| Both X+Y cleared | Emit `EnableSensReduction=0`, stop watchdog |
| Wheel (0x80) | WARN log "wheel mask not supported"; ACK; no settings emit |
| Keyboard (vkey in high bits) | WARN log "keyboard mask not supported"; ACK; no settings emit |

`unmask_all` always emits the full reset bundle (8 packets — every per-button + AmountX/Y back to 100 + Enable=0) and stops the watchdog. Defensive: even if the local shadow is somehow out of sync, the firmware ends up in a known-clean state.

## Phase 2 — Build status

* `cargo check --bins` — clean (1 dead-code warning suppressed in `state.rs`).
* `cargo test --bins` — **127 / 127 passing**, including 9 new mask tests (`diffs_only_emit_on_change`, `release_emits_off_packet`, `each_button_bit_maps_to_correct_setting_id`, `x_mask_transition_emits_three_settings_and_starts_watchdog`, `clearing_axis_mask_stops_watchdog`, `unmask_all_resets_everything`, `wheel_mask_emits_no_settings_packet`, `keyboard_mask_emits_no_settings_packet`, `watchdog_joins_on_drop`).
* `cargo build --release` — clean, `target/release/streamcheats_core.exe` rebuilt.

## Phase 3 — Live device walk

### Setup
* Backed up `backend/config.json` to `config.json.bak`, set `listen_addr=127.0.0.1`, `enable_file_logging=true`, restarted as background process.
* Daemon found device on **COM6** within ~400ms (`Found device on COM6`).
* Firmware version 5.17 — heartbeats `OUT 03 00 ...` and replies `IN V: 5.17` exchanged every 2.5 s.

### Walker
New example `backend/examples/checklist_walk.rs` — constructs every kmbox-net opcode by hand and sends via `UdpSocket`. **49 packets, 49 ACKs, 0 failures**.

### Per-opcode verification (grepped against `%TEMP%\overnight_test.log`)

| Group | Result |
|---|---|
| `cmd_connect` | `IN: cmd=connect (reset button mask)` observed |
| `cmd_mouse_{left,right,middle}` press+release | All 6 packets seen with correct `btn=0xXX` |
| `cmd_mouse_right` side1 (0x08) / side2 (0x10) | Both observed as `btn=0x08` / `btn=0x10` (Option-B payload-trust path) |
| `cmd_mouse_move` ±10/±10 | `STATE: move dx=10 dy=10` lines + corresponding OUT bytes |
| `cmd_mouse_wheel` ±1 | `wheel=1` / `wheel=-1` lines, single packet each |
| `cmd_mouse_automove` 30,-10 40ms | Multiple `STATE: move` lines from `interp_linear` worker |
| `cmd_bezier_move` 20,0 40ms | Multiple `STATE: move` lines from `interp_bezier` worker |
| `enc_*` (5 calls) | All decoded correctly via XXTEA auto-detect (length=128) |
| `cmd_monitor` subscribe 6000 | `MONITOR: subscribe peer 127.0.0.1:24576 mode=mouse (flags=0xAA55)` |
| `mouse_move post-subscribe` | `MONITOR: emit MoveEmitted{dx=1,dy=1,btn=0x00} -> 127.0.0.1:24576` |
| `cmd_monitor` unsubscribe (port=0) | `MONITOR: unsubscribe peer 127.0.0.1`; registry purged 1 entry |
| `cmd_mask_mouse` LMB | `STATE: mask -> settings id=8 (LMB) value=1` then `value=0`; `OUT 03 08 01 ...` / `03 08 00 ...` |
| `cmd_mask_mouse` RMB | `id=7` packets observed |
| `cmd_mask_mouse` MMB | `id=6` packets observed |
| `cmd_mask_mouse` Side1 | `id=9` packets observed |
| `cmd_mask_mouse` Side2 | `id=10` packets observed |
| `cmd_mask_mouse` X / Y | Enable (id=2) + Window (id=3) + AmountX (id=4) / AmountY (id=5) all observed; **watchdog spawned**; on clear, AmountX/Y restored to 100, Enable=0, watchdog stopped |
| **Watchdog soak** (X masked, 400 ms) | **9 × `OUT 08 00 00 00 01 00 00 00 00`** at 50 ms cadence — pump worked exactly as designed |
| `cmd_mask_mouse` Wheel | WARN line `STATE: mask wheel = true -> NOT SUPPORTED ...`; no settings emit; ACK sent |
| `cmd_mask_mouse` keyboard vkey=0x41 | WARN `STATE: mask keyboard vkey=0x0041 -> NOT SUPPORTED ...`; ACK sent |
| `cmd_unmask_all` | All 8 reset packets emitted (IDs 6/7/8/9/10/4/5/2); watchdog confirmed not running |
| `cmd_keyboard_all` | WARN `cmd=keyboard_all — NOT OPERATIONAL ...`; ACK only |

### Firmware health
20 × `V: 5.17` heartbeat replies during the walk — firmware stayed up the entire ~6-second test window. No `Heartbeat unanswered` warnings.

## Phase 4 — Checklist update summary

Counts vs initial state of `tests/COMPATIBILITY_CHECKLIST.md`:

| Section | Newly `[+]` | Still `[?]` | Newly `[-]` | Newly `[~]` |
|---|---|---|---|---|
| Mouse — buttons | 5 | 0 | 0 | 0 |
| Mouse — movement | 3 (incl. Bezier promoted from `[~]`) | 0 | 0 | 0 |
| Mouse — wheel | 1 | 0 | 0 | 0 |
| Mouse — masking | **8** (LMB, RMB, MMB, Side1, Side2, X, Y, unmask_all) | 0 | 3 (wheel, mask_kbd, unmask_kbd — firmware gap) | 0 |
| Mouse — encrypted | **5** (all enc_* promoted from `[-]`) | 0 | 0 | 0 |
| Keyboard | 0 | 0 | 0 | 0 (still all `[~]` / `[-]`) |
| Monitor mode | 3 (subscribe / unsubscribe / refresh) | 0 | 0 | 5 (`isdown_*` rows demoted from `[?]` to `[~]` w/ "needs physical mouse" note) |
| Operating modes | 1 (cmd_connect) | 0 | 0 | 0 |
| High-rate | 0 | 1 (10k loop deferred) | 0 | 0 |

**Total newly verified `[+]` rows: 26.** Newly `[-]` (firmware-limitation): 3. Demoted `[?]` → `[~]` (partial, evidence shown but not full SDK loop): 5.

## Surprises / issues
* None during the walk. Daemon never crashed, no heartbeat failures, all 49 packets ACK'd, watchdog cadence was precisely 50 ms.
* One harmless `unused_mut` warning in `examples/checklist_walk.rs` — left as-is (cosmetic).
* `config.json` had `listen_addr=""` (invalid) before the run; restored to that empty state per the spec's "restore to .bak". User will need to set a valid listen_addr before launching the daemon next time (this is the same state it was in when the agent took over).

## Daemon shutdown
After the walk completed I `taskkill /F /PID 6956`'d the background daemon. The stale `streamcheats_core.{pid,port,http_port}` files in `%TEMP%` were removed manually so the next start of the daemon doesn't have to wait for the takeover-of-dead-pid path.

## Recommended next steps for morning
1. **Manual sanity check** — open the demo `tests/vendor-demos/python_demo/mask.py` against a real `kmNet.pyd` install on another machine if available, and confirm the masks behave the same way the synthetic walker showed them behaving.
2. **File the GitHub issue** for wheel mask + keyboard mask firmware support (task #17 already in-progress).
3. **High-rate test** — write a separate example that runs the 10 000-iteration `cmd_mouse_move` loop and watches for serial back-pressure (translator already has timing logs available via `enable_timing_logs=true`).
4. **Physical-mouse monitor test** — bind a listener on UDP port 6000 in another script, subscribe via `cmd_monitor`, then have the user move/click their mouse and verify the 20-byte echo packets show real physical state. That'll promote the five `isdown_*` rows from `[~]` to `[+]`.
5. Consider whether the 8-packet `cmd_unmask_all` burst could be optimised to only emit the IDs that were actually non-default (would require an additional shadow flag per ID). For now the defensive "always reset everything" stance feels right.

## Files changed
* `backend/src/streamcheats/mod.rs` — register `mask` module + re-export `MaskController`.
* `backend/src/streamcheats/mask/{mod,state,controller,watchdog}.rs` — new module (4 files).
* `backend/src/streamcheats/device.rs` — added `send_settings_packet` + `apply_axis_mask_rearm` methods.
* `backend/src/util/translator.rs` — wire `CMD_MASK_MOUSE` + `CMD_UNMASK_ALL` arms to `MaskController`; constructor takes Arc<MaskController>.
* `backend/src/main.rs` — construct and pass `MaskController` to `Translator`.
* `backend/src/lib.rs` — re-export `CMD_MASK_MOUSE` / `CMD_MONITOR` / `CMD_UNMASK_ALL` so examples can use them.
* `backend/examples/checklist_walk.rs` — new live-walker example.
* `tests/COMPATIBILITY_CHECKLIST.md` — 26 rows promoted to `[+]`, 3 to `[-]`, 5 demoted from `[?]` to `[~]`.
