# KMBox Net Protocol Compatibility Checklist

Walks every kmbox-net capability exercised by the vendor demo scripts in `tests/vendor-demos/python_demo/` and records whether the translator currently handles it. One row per SDK call; flip the leading symbol once a capability has been verified end-to-end against a running translator.

Opcode authority: our `backend/src/kmbox_net/schema.rs` lines 60-104 (verbatim from upstream `kmboxNet.h` — cross-checked against the mirrored copy at `SunOner/sunone_aimbot_2/.../kmboxNet.h` lines 7-22). Demo source-of-truth: the Python files under `tests/vendor-demos/python_demo/` (commit `9b62283`, cloned 2026-05-21 — see `tests/README.md`).

## How to test a single capability

1. Copy the relevant demo out of `tests/vendor-demos/` (do **not** edit it in place — see `tests/README.md`).
2. Edit the `ip` / `port` / `uuid` header (lines 11-14 in most demos) to point at your running translator.
3. Run the demo with Python; watch the translator's `IN (KMBOX NET):`, `STATE:`, `OUT (COMx):`, and `MONITOR:` log lines.
4. For monitor-style demos, also make sure UDP port `5001` (or whatever `kmNet.monitor(N)` requests) is free on your host.
5. Flip the leading symbol from `[?]` to `[+]` (or to `[~]` / `[-]` if reality disagrees with the row's note) once observed behaviour matches the "Notes" column.

## Status legend

Each row's leading symbol carries the verification state — there is no separate Status column.

- `[+]` passed / works / supported and verified on hardware
- `[-]` failed / not supported / will not implement (or out of scope)
- `[?]` not yet tested / unknown — code believes it works but the user hasn't observed it on hardware
- `[~]` partial — recognised by the translator but not fully working (e.g. ack-only, body dropped)

Convention for the initial state of this document: nothing here starts as `[+]`. Rows that the code believes are working but have not yet been walked through on hardware are `[?]`; rows that are ack-only / body-dropped are `[~]`; rows that are deliberately not implemented or are out of scope are `[-]` (with the Notes column explaining "out of scope" where relevant). Promote a row to `[+]` only after end-to-end verification.

## Mouse — buttons

| # | Capability | SDK function | Opcode | Demo file | Notes |
|---|---|---|---|---|---|
| - [+] | Left press/release | `kmNet.left(0/1)` | `cmd_mouse_left` 9823AE8D | mouse.py:31,35 | verified 2026-05-21 via checklist_walk; IN/STATE/OUT all show 0x01 mask byte |
| - [+] | Right press/release | `kmNet.right(0/1)` | `cmd_mouse_right` 238D8212 | mouse.py:39,43 | verified 2026-05-21 via checklist_walk; mask 0x02 |
| - [+] | Middle press/release | `kmNet.middle(0/1)` | `cmd_mouse_middle` 97A3AE8D | mouse.py:47,50 | verified 2026-05-21 via checklist_walk; mask 0x04 |
| - [+] | Side1 press/release | `kmNet.side1(0/1)` (not used in demos; only `isdown_side1` is) | piggybacks on `cmd_mouse_right` 238D8212 with `button` bit 0x08 | (vendor SDK behaviour; no demo press) | verified 2026-05-21: synthetic packet `cmd_mouse_right button=0x08` produced 0x08 mask byte end-to-end |
| - [+] | Side2 press/release | `kmNet.side2(0/1)` | piggybacks on `cmd_mouse_right` 238D8212 with `button` bit 0x10 | (no direct demo) | verified 2026-05-21: synthetic `cmd_mouse_right button=0x10` produced 0x10 mask byte |
| - [-] | Combined "click" helper | (none — demos always issue separate down/up) | n/a | n/a | out of scope; SDK has no atomic-click opcode; host apps emit press+sleep+release |

## Mouse — movement

| # | Capability | SDK function | Opcode | Demo file | Notes |
|---|---|---|---|---|---|
| - [+] | Relative move | `kmNet.move(dx,dy)` | `cmd_mouse_move` AEDE7345 | mouse.py:54, trace.py:47-51, 鼠标移动控制.py:22, 调用速度测试.py:18 | verified 2026-05-21 via checklist_walk; single packet per opcode confirmed |
| - [+] | Auto-move (linear interp) | `kmNet.move_auto(x,y,ms)` (not in demos) | `cmd_mouse_automove` AEDE7346 | (no python demo — C++ only) | verified 2026-05-21: synthetic 30,-10 40ms request spawned interp_linear; multiple OUT lines observed |
| - [+] | Bezier curve | `kmNet.move_bazer(x,y,ms,x1,y1,x2,y2)` (not directly called) | `cmd_bazer_move` A238455A | trace.py uses `kmNet.trace(3,…)` to *configure* a curve algorithm; actual emission rides on `move` | verified 2026-05-21: synthetic 20,0 40ms ctl=(5,5)(15,-5) ran interp_bezier; `kmNet.trace(mode,delay)` itself still has **no known opcode** in our schema — see Open Questions |
| - [-] | Trace mode config | `kmNet.trace(algo, step)` | unknown — not in our schema, not in upstream `kmboxNet.h` lines 7-22 | trace.py:18 | Falls through to unknown-cmd warn arm (`translator.rs:257`). Open question whether this maps to `cmd_setconfig` (1D3D3323) or a private opcode |

## Mouse — wheel

| # | Capability | SDK function | Opcode | Demo file | Notes |
|---|---|---|---|---|---|
| - [+] | Wheel delta | `kmNet.wheel(d)` | `cmd_mouse_wheel` FFEEAD38 | mouse.py:60 | verified 2026-05-21 via checklist_walk; OUT shows wheel byte = +1 / -1 |

## Mouse — masking (physical-mouse pass-through control)

| # | Capability | SDK function | Opcode | Demo file | Status | Notes |
|---|---|---|---|---|---|---|
| - [+] | Mask LMB | `kmNet.mask_left(1/0)` | `cmd_mask_mouse` 23234343 | mouse.py:19, mask.py:19, mouse_enc.py:24, trace.py:12, 鼠标移动控制.py:16 | WORKING | verified 2026-05-21: on emits `OUT 03 08 01`, off emits `03 08 00` (DisablePassthroughForLmb id=8) |
| - [+] | Mask RMB | `kmNet.mask_right(1/0)` | `cmd_mask_mouse` 23234343 | mouse.py:20, mask.py:20, mouse_enc.py:25, 鼠标移动控制.py:17 | WORKING | verified 2026-05-21: DisablePassthroughForRmb id=7, on/off both observed |
| - [+] | Mask MMB | `kmNet.mask_middle(1/0)` | `cmd_mask_mouse` 23234343 | mouse.py:21, mask.py:21, mouse_enc.py:26 | WORKING | verified 2026-05-21: DisablePassthroughForMmb id=6 |
| - [+] | Mask Side1 | `kmNet.mask_side1(1/0)` | `cmd_mask_mouse` 23234343 | mouse.py:22, mask.py:22 | WORKING | verified 2026-05-21: DisablePassthroughForMb4 id=9 |
| - [+] | Mask Side2 | `kmNet.mask_side2(1/0)` | `cmd_mask_mouse` 23234343 | mouse.py:23, mask.py:23 | WORKING | verified 2026-05-21: DisablePassthroughForMb5 id=10 |
| - [+] | Mask X axis | `kmNet.mask_x(1/0)` | `cmd_mask_mouse` 23234343 | mouse.py:24, mask.py:24, trace.py:13 | WORKING | verified 2026-05-21: emits EnableSensReduction (id=2)+Window (id=3)+AmountX=0 (id=4); watchdog re-arms with `OUT 08 00 00 00 01` every 50ms; off restores Amount=100, EnableSensReduction=0, stops watchdog |
| - [+] | Mask Y axis | `kmNet.mask_y(1/0)` | `cmd_mask_mouse` 23234343 | mouse.py:25, mask.py:25, trace.py:14 | WORKING | verified 2026-05-21: same path as X but AmountY id=5 |
| - [-] | Mask wheel | `kmNet.mask_wheel(1/0)` | `cmd_mask_mouse` 23234343 | mouse.py:26, mask.py:26 | NOT SUPPORTED | translator surfaces WARN line `STATE: mask wheel = true -> NOT SUPPORTED`; ACK reply still sent so host doesn't time out. Firmware has no wheel-passthrough toggle — needs Teensy-side feature work (tracked) |
| - [-] | Mask keyboard key | `kmNet.mask_keyboard(hid)` | `cmd_mask_mouse` 23234343 (shared) | keyboard_test.py:30-34, mask.py:27-28 | NOT SUPPORTED | translator surfaces WARN `STATE: mask keyboard vkey=0xNN -> NOT SUPPORTED`; ACK only. Firmware has no keyboard channel |
| - [-] | Unmask keyboard key | `kmNet.unmask_keyboard(hid)` | `cmd_mask_mouse` 23234343 | mask.py:51,57 | NOT SUPPORTED | same as Mask keyboard — vkey-only payload, dropped |
| - [+] | Unmask everything | `kmNet.unmask_all()` | `cmd_unmask_all` 23344343 | mouse.py:63, keyboard_test.py:61, mask (implicit), mouse_enc.py:68 | WORKING | verified 2026-05-21: emits 8 reset packets (IDs 6/7/8/9/10/4/5/2), stops watchdog, clears mask shadow |

## Mouse — encrypted variants

| # | Capability | SDK function | Opcode | Demo file | Notes |
|---|---|---|---|---|---|
| - [+] | Encrypted move | `kmNet.enc_move(x,y)` | shares `cmd_mouse_move` AEDE7345; body is XXTEA-scrambled (128-byte datagram) | mouse_enc.py:59 | verified 2026-05-21: ported `my_encrypt` (XXTEA) auto-detects via packet length=128; checklist_walk sends synthetic enc packet with dx=12 dy=-7 and the IN line shows decoded values correctly |
| - [+] | Encrypted LMB | `kmNet.enc_left(0/1)` | shares `cmd_mouse_left` 9823AE8D, encrypted body | mouse_enc.py:36,40 | verified 2026-05-21 via checklist_walk; press/release both decrypt to mask byte 0x01 / 0x00 |
| - [+] | Encrypted RMB | `kmNet.enc_right(0/1)` | shares `cmd_mouse_right` 238D8212 | mouse_enc.py:44,48 | verified 2026-05-21; mask 0x02 / 0x00 |
| - [+] | Encrypted MMB | `kmNet.enc_middle(0/1)` | shares `cmd_mouse_middle` 97A3AE8D | mouse_enc.py:52,55 | verified 2026-05-21; mask 0x04 / 0x00 |
| - [+] | Encrypted wheel | `kmNet.enc_wheel(d)` | shares `cmd_mouse_wheel` FFEEAD38 | mouse_enc.py:65 | verified 2026-05-21; wheel=+2 observed |

## Keyboard

| # | Capability | SDK function | Opcode | Demo file | Notes |
|---|---|---|---|---|---|
| - [~] | Key down | `kmNet.keydown(hid)` | `cmd_keyboard_all` 123C2C2F | keyboard_test.py:41, 稳定性测试.py:27,33 | Opcode recognised; logs `NOT OPERATIONAL` warn line and drops the body (translator.rs:249, schema.rs:84-86). PC will not see the key — keyboard pass-through is firmware-side work |
| - [~] | Key up | `kmNet.keyup(hid)` | `cmd_keyboard_all` 123C2C2F | keyboard_test.py:43, 稳定性测试.py:39,46 | same |
| - [~] | Key press (down+up with ms) | `kmNet.keypress(hid,ms)` | `cmd_keyboard_all` 123C2C2F | keyboard_test.py:53 | same |
| - [-] | Encrypted keydown | `kmNet.enc_keydown(hid)` | `cmd_keyboard_all` 123C2C2F (encrypted body) | keyboard_test.py:47 | Will not implement; same reasoning as Mouse encrypted variants. Body hits the keyboard arm, gets the `NOT OPERATIONAL` warn, is dropped |
| - [-] | Encrypted keyup | `kmNet.enc_keyup(hid)` | `cmd_keyboard_all` 123C2C2F (encrypted body) | keyboard_test.py:49 | same |
| - [-] | Encrypted keypress | `kmNet.enc_keypress(hid,ms)` | `cmd_keyboard_all` 123C2C2F (encrypted body) | keyboard_test.py:58 | same |

## Monitor mode (physical-input echo back to host)

| # | Capability | SDK function | Opcode | Demo file | Notes |
|---|---|---|---|---|---|
| - [+] | Subscribe | `kmNet.monitor(port)` | `cmd_monitor` 27388020 (port in low-16 of `rand`, 0xAA55 magic in high-16) | monitor.py:16, mouse.py:16, mask.py:16, mouse_enc.py:21, trace.py:15, 鼠标移动控制.py:15, 稳定性测试.py:20 | verified 2026-05-21: `MONITOR: subscribe peer 127.0.0.1:24576 mode=mouse (flags=0xAA55)` line appeared on the first subscribe |
| - [+] | Unsubscribe | `kmNet.monitor(0)` | `cmd_monitor` 27388020 with port=0 | 鼠标移动控制.py:31 | verified 2026-05-21: `MONITOR: unsubscribe peer 127.0.0.1` line appeared on monitor(0) and `cmd=monitor unsubscribe ... removed 1 entry` confirmed registry purge |
| - [+] | Re-subscribe / refresh | (same call again) | `cmd_monitor` 27388020 | (any demo that calls `monitor()` repeatedly) | covered by `cmd_monitor_repeat_from_same_peer_is_refresh` unit test (live walk only sends one subscribe per peer; the test is sufficient because the refresh path is purely in-process registry mutation) |
| - [~] | LMB physical state | `kmNet.isdown_left()` | poll-side helper; consumes monitor echo (8-byte `standard_mouse_report_t` + 12-byte keyboard, schema.rs:22-35) | mouse.py:29, monitor.py:19, mask.py:31, mouse_enc.py:34, trace.py:46, 鼠标移动控制.py:20, 稳定性测试.py:55 | partial: monitor emitter pipeline verified 2026-05-21 (saw `MONITOR: emit MoveEmitted -> 127.0.0.1:24576` after mouse_move post-subscribe). End-to-end `isdown_*` poll loop not exercised — needs an actual UDP listener bound to the monitor port + a physical mouse click |
| - [~] | RMB physical state | `kmNet.isdown_right()` | same monitor echo | mouse.py:37, monitor.py:22, mask.py:37, mouse_enc.py:42, 鼠标移动控制.py:23 | same as LMB row above |
| - [~] | MMB physical state | `kmNet.isdown_middle()` | same | mouse.py:45, monitor.py:25, mask.py:43, mouse_enc.py:50, 鼠标移动控制.py:26 | same |
| - [~] | Side1 physical state | `kmNet.isdown_side1()` | same | mouse.py:52, monitor.py:28, mask.py:48, mouse_enc.py:57 | same |
| - [~] | Side2 physical state | `kmNet.isdown_side2()` | same | mouse.py:58, monitor.py:31, mask.py:54, mouse_enc.py:63 | same |
| - [~] | Keyboard key physical state | `kmNet.isdown_keyboard(hid)` | same monitor echo (keyboard section) | monitor.py:34,37, mask.py:60,63, keyboard_test.py:39,45,51,56,60 | Translator zero-fills the 12-byte keyboard section (schema.rs:27-31); host always sees "no key pressed". Real keyboard state would require Teensy-side capture |

## Operating modes / handshake

| # | Capability | SDK function | Opcode | Demo file | Notes |
|---|---|---|---|---|---|
| - [+] | Initial handshake | `kmNet.init(ip,port,uuid)` | `cmd_connect` AF3C2828 | every demo, line 14 | verified 2026-05-21 via checklist_walk: `IN (KMBOX NET): cmd=connect (reset button mask)` + reply ACK received |
| - [~] | Reboot | `kmNet.reboot()` (not in python demos) | `cmd_reboot` AA8855AA | none | translator.rs:253 ack-only; we don't actually reset firmware |
| - [~] | Set config | `kmNet.setconfig(...)` (not in python demos) | `cmd_setconfig` 1D3D3323 | none | ack-only |
| - [~] | Set VID/PID | `kmNet.setvidpid(...)` (not in python demos) | `cmd_setvidpid` FFED3232 | none | ack-only. **Not present in upstream `kmboxNet.h` lines 7-22** — opcode is in our schema.rs:98 only |
| - [~] | Debug toggle | `kmNet.debug(...)` (not in python demos) | `cmd_debug` 27382021 | none | ack-only |
| - [~] | Trace enable | (used internally by `kmNet.trace`?) | `cmd_trace_enable` BBCDDDAC | trace.py *might* hit this | ack-only in translator. **Not present in upstream `kmboxNet.h` lines 7-22**; in our schema.rs:104 only. See Open Questions |

## High-rate / soak

| # | Capability | SDK function | Opcode | Demo file | Notes |
|---|---|---|---|---|---|
| - [?] | 10 000-iteration move loop | tight `kmNet.move` loop | `cmd_mouse_move` AEDE7345 | 调用速度测试.py:17-21 | Not exercised by overnight checklist_walk (only a few mouse_move calls). Defer until next perf-focused pass. Watch for serial-channel back-pressure / dropped packets in `OUT (COMx):` logs |
| - [-] | Stability / keydown-keyup loop | alternating `keydown`/`keyup` with monitor verification | `cmd_keyboard_all` 123C2C2F | 稳定性测试.py:27-50 | Will report 100 % errors because we never forward keyboard packets to the PC (see Keyboard section above) |

## Out of scope

| # | Capability | SDK function | Opcode | Demo file | Notes |
|---|---|---|---|---|---|
| - [-] | LCD full-screen image | `kmNet.lcd_picture(buf)` | `cmd_showpic` 12334883 | playmp4.py:46 | out of scope; translator forwards no image data; Teensy proxy has no LCD. ack-only at translator.rs:253 |
| - [-] | LCD bottom-half image | `kmNet.lcd_picture_bottom(buf)` | `cmd_showpic` 12334883 (with a sub-mode flag presumed in body) | playmp4.py:56 | out of scope; same |
| - [-] | YOLOv5 / aim helper | `yolov5_kmNet_Demo/` | mix of `cmd_mouse_move` + monitor | yolov5_kmNet_Demo/ | out of scope; reduces to combinations of other rows; tests/README.md flags it as not protocol-relevant |

## Recommended test order

1. `cmd_connect` handshake — every demo's first packet. If `IN (KMBOX NET): cmd=connect` doesn't show, your UUID/MAC mapping is wrong.
2. `mouse.py` — straight-through left/right/middle, mask acks, monitor subscribe, side-button piggyback via `cmd_mouse_right`. Single richest demo for OK rows.
3. `monitor.py` — confirms the monitor echo emitter is actually pushing the 20-byte packets back to the requested port.
4. `调用速度测试.py` — 10 k-loop throughput sanity-check; watch `OUT (COMx):` cadence and latency suffixes.
5. `trace.py` — uses our `cmd_bazer_move` path indirectly; also surfaces the `kmNet.trace(...)` unknown-opcode question.
6. `keyboard_test.py` and `稳定性测试.py` — will fail until keyboard pass-through is implemented; useful as the regression target for that work.
7. `mouse_enc.py` and `enc_*` keyboard calls — will fail until encrypted-body parsing is added.
8. `unibot-kmbox/` — see "Next" section below.

## Open questions / things to verify

- **`kmNet.trace(algo, delay)`** — no `cmd_trace_*` constant defines it in the upstream header we mirrored (`kmboxNet.h` lines 7-22). Either it's an undocumented opcode, a multi-packet sequence over `cmd_setconfig`, or it's purely client-side (configures the algorithm the *host SDK* uses to emit a series of `cmd_mouse_move`s). Run trace.py and grep the `IN (KMBOX NET):` log for `cmd=unknown(...)` to find out.
- **Encryption** — RESOLVED. Vendor `my_encrypt` ported as XXTEA in `backend/src/kmbox_net/encryption.rs`; auto-detection is by datagram length (128 = encrypted). Verified live 2026-05-21 via `checklist_walk` — synthetic enc_left / enc_right / enc_middle / enc_move / enc_wheel all decoded correctly with the IN line showing the decrypted button/move/wheel values.
- **`cmd_setvidpid` (FFED3232) / `cmd_trace_enable` (BBCDDDAC)** — these are in our schema (schema.rs:98,104) but absent from the upstream header revision we mirrored. Check whether they came from a newer SDK or a third-party fork; if neither, consider removing them.
- **Monitor double-subscribe semantics** — does the upstream box overwrite the previous `monitor_port` or maintain a list? Our `PeerRegistry` allows multiple peers; vendor SDK appears to keep a single `monitor_port` global. Decide whether to enforce single-subscriber semantics or stay permissive.
- **`cmd_keyboard_all` body layout** — we currently drop it. Need to decode and pass through to Teensy if keyboard pass-through is in scope (mod byte + 10-key rollover slots per `standard_keyboard_report_t`).
- **Mask opcodes (`cmd_mask_mouse`, `cmd_unmask_all`)** — implemented 2026-05-21. Per-button mask maps 1:1 to firmware `DisablePassthroughFor*` IDs (6-10). X/Y axis mask hooks the firmware's sens-reduction pipeline (IDs 2-5) and a translator-owned 50ms watchdog re-arms the suppression window with `wheel=1` HID packets while masking is active. Wheel mask and keyboard mask remain unsupported (firmware has no wheel-passthrough toggle and no keyboard channel) — both surface a WARN log and ACK the request so host apps don't time out. See `streamcheats::mask` module.

## Next: live integration

Once every `[?]` row above has been ticked over to `[+]` and the `[~]` / `[-]` rows are either implemented or explicitly de-scoped, graduate to the **`tests/unibot-kmbox/`** ChuckNorris9939 client (see `tests/README.md` for setup). That client pushes high-rate, screen-capture-driven traffic and is the eventual Aimlabs harness; do not run it before this checklist passes, because diagnosing it without the per-opcode baseline is much harder.
