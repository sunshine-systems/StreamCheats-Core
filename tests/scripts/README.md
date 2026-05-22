# KMBox Net monitor-callback probe

## Purpose

`probe_monitor_callback.py` is a diagnostic that talks raw UDP to a real
KMBox Net device and answers one question:

> When a button on the mouse attached to the KMBox is **held down**, does
> the device emit a monitor echo packet **per frame** (continuously, at
> the underlying mouse poll rate of ~1 kHz), or **only on transitions**
> (one packet when pressed, one when released)?

This matters for the translator we ship. Many 3rd-party tools bind hotkeys
like RMB and assume the input device repeats while held (mouse HID reports
do). If the KMBox echoes only on transitions, our translator's monitor
mode needs a watchdog that re-emits held button state at high frequency so
those tools see what they expect. If the KMBox already echoes per-frame,
no watchdog is needed and adding one would just duplicate packets.

The script does **not** depend on the vendor `kmNet.pyd` / `kmNet.dll`.
It implements the wire protocol directly so it can run anywhere with a
stock Python install.

## Prerequisites

- Python 3.8+ (stdlib only — no `pip install` required)
- A real KMBox Net device on the same LAN as the host running this script
- The device's:
  - IP address (e.g. `127.0.0.1`)
  - UDP port (e.g. `56873`)
  - UUID (hex string, e.g. `00000000`)

These three values are normally passed to `kmNet_init(ip, port, uuid)` on
the vendor SDK. You can find them in the device's printed sticker / docs,
or by inspecting the config of any working host application.

A physical mouse must be plugged into the KMBox's USB host port — that
is the input source the monitor echoes mirror.

## How to run

From this folder:

```
python probe_monitor_callback.py --ip 127.0.0.1 --port 56873 --uuid 00000000
```

Optional flags:

- `--listen-port 16001` — local UDP port that receives echoes (default 16001).
  Make sure your firewall allows the device to reach this port.
- `--duration N` — capture length in seconds for a bounded run. Default is
  `0`, which means **run until Ctrl+C**.
- `--verbose` — print every received packet. Noisy at 1 kHz but useful
  for raw inspection.

**During the capture window**, physically operate the mouse attached to
the KMBox:

1. Press and **HOLD** RMB for ~5 seconds, release.
2. Press and **HOLD** LMB for ~5 seconds, release.
3. (Optional) Click MMB, Side1, Side2 a couple of times each.

By default the script runs until you press Ctrl+C, at which point the
summary prints. If you passed `--duration N`, it also stops automatically
after N seconds.

## Interpreting the output

Look at the **`packets/sec while held`** number for each button, and
the verdict line beneath it.

- **PER-FRAME** (`packets/sec while held` ~500–1000+):
  The KMBox echoes the mouse state on every USB poll, even when nothing
  changed. Downstream consumers see a continuous stream while a button
  is held, matching HID behaviour. Our translator does **not** need a
  watchdog.

- **PER-TRANSITION** (`packets/sec while held` near 0, often <5):
  The KMBox only emits an echo when state changes — typically one
  packet at press, one at release. Downstream consumers that expect a
  repeating signal (anti-cheat heuristics, hold-to-fire macros,
  framework-level hotkey handlers) will **not** see one. Our translator
  needs a watchdog that re-emits the held state at high frequency.

- **AMBIGUOUS** (50–200 packets/sec):
  Re-run with `--duration 60` and a longer, steadier hold. Also check
  the physical mouse's polling rate — a 125 Hz office mouse pinned at
  125 packets/sec while held is still per-frame, just slow.

`transitions` should equal 2 × number of distinct presses (one down +
one up per press). If it's higher, the hardware is debouncing oddly or
the button chattered.

The `Inter-packet gaps` p95/p99/max are sanity checks for jitter —
spikes >20 ms suggest packet loss or scheduling hiccups on the listen host.

## What to send back to us

Run the script with the buttons exercised as above, then paste:

1. The full `=== Capture summary ===` block (everything from that header
   down to the end of the script's output).
2. (Optional but useful) The verbose log: re-run with `--verbose
   --duration 10`, hold RMB the whole time, and capture stdout to a
   file.

That's enough for us to decide whether the translator's monitor mode
needs a watchdog and at what rate to run it.
